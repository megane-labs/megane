"""Tests for the web UI's server file browsing (``/api/files``)."""

import os

import pytest
from starlette.testclient import TestClient

from megane import server
from megane.server import _files, _is_loopback, app, configure_files, configure_hosts

LOCAL_URL = "http://localhost:8765"
LAN_URL = "http://192.168.1.5:8765"


@pytest.fixture(autouse=True)
def _reset_files():
    yield
    configure_files(None)
    configure_hosts(None)


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "root"
    (root / "run" / "deep").mkdir(parents=True)
    (root / "run" / "traj.xtc").write_bytes(b"\x00\x01\x02")
    (root / "a.pdb").write_text("ATOM\n")
    (root / "B.gro").write_text("gro\n")
    (root / ".secret").write_text("hidden\n")
    (root / ".hidden_dir").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "passwd").write_text("nope\n")
    return root, outside


@pytest.fixture
def local_client():
    return TestClient(app, base_url=LOCAL_URL, client=("127.0.0.1", 50000))


def _remote(ip: str = "192.168.1.20", base_url: str = LAN_URL) -> TestClient:
    return TestClient(app, base_url=base_url, client=(ip, 50000))


def test_disabled_by_default(local_client):
    configure_files(None)
    resp = local_client.get("/api/files")
    assert resp.status_code == 404
    assert "disabled" in resp.json()["detail"]


def test_lists_root_folders_first_without_hidden(tree, local_client):
    root, _ = tree
    configure_files(root)
    resp = local_client.get("/api/files", params={"path": ""})
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == ""
    assert body["parent"] is None
    assert [e["name"] for e in body["entries"]] == ["run", "a.pdb", "B.gro"]
    run, pdb = body["entries"][0], body["entries"][1]
    assert run == {"name": "run", "path": "run", "isDir": True, "size": None}
    assert pdb == {"name": "a.pdb", "path": "a.pdb", "isDir": False, "size": 5}


def test_lists_subfolder_with_parent(tree, local_client):
    root, _ = tree
    configure_files(root)
    body = local_client.get("/api/files", params={"path": "run"}).json()
    assert body["path"] == "run"
    assert body["parent"] == ""
    assert [e["path"] for e in body["entries"]] == ["run/deep", "run/traj.xtc"]
    deep = local_client.get("/api/files", params={"path": "run/deep"}).json()
    assert deep["parent"] == "run"
    assert deep["entries"] == []


def test_rejects_paths_outside_root(tree, local_client):
    root, _ = tree
    configure_files(root)
    for path in ["..", "../outside", "run/../../outside"]:
        resp = local_client.get("/api/files", params={"path": path})
        assert resp.status_code == 400, path
    resp = local_client.get("/api/files/content", params={"path": "../outside/passwd"})
    assert resp.status_code == 400


def test_leading_slash_stays_under_root(tree, local_client):
    root, _ = tree
    configure_files(root)
    body = local_client.get("/api/files", params={"path": "/run"}).json()
    assert body["path"] == "run"


def test_invalid_path_is_a_client_error(tree, local_client):
    root, _ = tree
    configure_files(root)
    resp = local_client.get("/api/files", params={"path": "a\x00b"})
    assert resp.status_code == 400


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlinks_cannot_escape_root(tree, local_client):
    root, outside = tree
    (root / "escape").symlink_to(outside)
    (root / "leak.pdb").symlink_to(outside / "passwd")
    (root / "inside").symlink_to(root / "run")
    (root / "dangling").symlink_to(root / "missing")
    configure_files(root)
    names = [e["name"] for e in local_client.get("/api/files").json()["entries"]]
    assert "escape" not in names
    assert "leak.pdb" not in names
    assert "inside" in names
    assert "dangling" not in names  # can't be stat'ed, so it is skipped
    assert local_client.get("/api/files", params={"path": "escape"}).status_code == 400
    assert local_client.get("/api/files/content", params={"path": "leak.pdb"}).status_code == 400
    body = local_client.get("/api/files", params={"path": "inside"}).json()
    assert [e["name"] for e in body["entries"]] == ["deep", "traj.xtc"]


def test_not_a_folder_and_not_a_file(tree, local_client):
    root, _ = tree
    configure_files(root)
    assert local_client.get("/api/files", params={"path": "a.pdb"}).status_code == 404
    assert local_client.get("/api/files", params={"path": "nope"}).status_code == 404
    assert local_client.get("/api/files/content", params={"path": "run"}).status_code == 404
    assert local_client.get("/api/files/content", params={"path": "nope.pdb"}).status_code == 404


def test_reads_file_content(tree, local_client):
    root, _ = tree
    configure_files(root)
    resp = local_client.get("/api/files/content", params={"path": "run/traj.xtc"})
    assert resp.status_code == 200
    assert resp.content == b"\x00\x01\x02"
    assert "traj.xtc" in resp.headers["content-disposition"]


def test_only_loopback_clients_by_default(tree):
    root, _ = tree
    configure_files(root)
    remote = _remote()
    resp = remote.get("/api/files")
    assert resp.status_code == 403
    assert "--files-any-host" in resp.json()["detail"]
    assert remote.get("/api/files/content", params={"path": "a.pdb"}).status_code == 403
    assert TestClient(app, base_url=LOCAL_URL, client=("::1", 1)).get("/api/files").status_code == 200
    assert TestClient(app, base_url=LOCAL_URL, client=("localhost", 1)).get("/api/files").status_code == 200


def test_any_host_serves_every_client(tree):
    root, _ = tree
    configure_files(root, any_host=True)
    assert _files.any_host is True
    assert _remote().get("/api/files").status_code == 200


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("127.0.0.1", True),
        ("127.5.0.1", True),
        ("::1", True),
        ("localhost", True),
        ("10.0.0.1", False),
        ("testclient", False),
        ("", False),
        (None, False),
    ],
)
def test_is_loopback(host, expected):
    assert _is_loopback(host) is expected


def test_configure_files_resolves_root(tmp_path):
    configure_files(tmp_path / "x" / "..")
    assert _files.root == tmp_path.resolve()
    configure_files(None)
    assert _files.root is None
    assert _files.any_host is False


@pytest.fixture
def static_app(tmp_path, monkeypatch):
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("<html><head><title>Megane</title></head><body></body></html>")
    monkeypatch.setattr(server, "_static_dir", app_dir)
    return app_dir


def test_index_is_marked_when_files_are_served(tree, static_app, local_client):
    root, _ = tree
    configure_files(root)
    for path in ("/", "/index.html", "/?test=1"):
        resp = local_client.get(path)
        assert resp.status_code == 200
        assert server.SERVER_FILES_META in resp.text
        assert resp.text.index(server.SERVER_FILES_META) < resp.text.index("</head>")
        assert resp.headers["cache-control"] == "no-cache"


def test_index_is_unmarked_without_file_browsing(static_app, local_client):
    configure_files(None)
    resp = local_client.get("/")
    assert resp.status_code == 200
    assert "<title>Megane</title>" in resp.text
    assert "megane-server-files" not in resp.text


def test_index_is_unmarked_for_a_refused_client(tree, static_app):
    root, _ = tree
    remote = _remote("203.0.113.5", base_url="http://198.51.100.7:8765")
    configure_files(root)
    assert "megane-server-files" not in remote.get("/").text
    configure_files(root, any_host=True)
    assert server.SERVER_FILES_META in remote.get("/").text


def test_index_without_a_built_app(tmp_path, monkeypatch, local_client):
    monkeypatch.setattr(server, "_static_dir", tmp_path / "missing")
    resp = local_client.get("/")
    assert resp.status_code == 200
    assert "The web UI is not available." in resp.text


# ─── Hidden files ────────────────────────────────────────────────────


@pytest.mark.parametrize("path", [".secret", "./.secret", "run/../.secret", ".hidden_dir/x", "run\\..\\.secret"])
def test_content_refuses_hidden_paths(tree, local_client, path):
    """Dot files are not listed, so they are not served by name either (~/.ssh/id_rsa)."""
    root, _ = tree
    configure_files(root)
    resp = local_client.get("/api/files/content", params={"path": path})
    assert resp.status_code == 403, path
    assert "Hidden" in resp.json()["detail"]


def test_listing_refuses_hidden_folders(tree, local_client):
    root, _ = tree
    (root / ".hidden_dir" / "id_rsa").write_text("key\n")
    configure_files(root)
    for path in [".hidden_dir", "run/../.hidden_dir"]:
        assert local_client.get("/api/files", params={"path": path}).status_code == 403, path


def test_dot_and_dot_dot_still_navigate(tree, local_client):
    root, _ = tree
    configure_files(root)
    assert local_client.get("/api/files", params={"path": "run/.."}).json()["path"] == ""
    assert local_client.get("/api/files/content", params={"path": "./run/../a.pdb"}).status_code == 200


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlinks_into_hidden_folders_are_refused(tree, local_client):
    root, _ = tree
    (root / ".hidden_dir" / "id_rsa").write_text("key\n")
    (root / "keys").symlink_to(root / ".hidden_dir")
    (root / "key.pdb").symlink_to(root / ".hidden_dir" / "id_rsa")
    configure_files(root)
    names = [e["name"] for e in local_client.get("/api/files").json()["entries"]]
    assert "keys" not in names
    assert "key.pdb" not in names
    assert local_client.get("/api/files", params={"path": "keys"}).status_code == 403
    assert local_client.get("/api/files/content", params={"path": "keys/id_rsa"}).status_code == 403
    assert local_client.get("/api/files/content", params={"path": "key.pdb"}).status_code == 403


def test_hidden_root_itself_is_served(tmp_path, local_client):
    """Only names under the root count: a root inside a dot folder still works."""
    root = tmp_path / ".cache" / "runs"
    root.mkdir(parents=True)
    (root / "a.pdb").write_text("ATOM\n")
    configure_files(root)
    assert local_client.get("/api/files/content", params={"path": "a.pdb"}).status_code == 200


# ─── Host and Origin (DNS rebinding, cross-site pages) ───────────────


@pytest.mark.parametrize("endpoint", ["/api/files", "/api/files/content?path=a.pdb"])
def test_rebound_host_name_is_refused(tree, local_client, endpoint):
    """A page whose DNS name was pointed at 127.0.0.1 sends its own name as Host."""
    root, _ = tree
    configure_files(root)
    resp = local_client.get(endpoint, headers={"host": "evil.example:8765"})
    assert resp.status_code == 403
    assert "--allowed-host" in resp.json()["detail"]
    configure_files(root, any_host=True)
    assert local_client.get(endpoint, headers={"host": "evil.example:8765"}).status_code == 403


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1:8765", "[::1]:8765", "LOCALHOST:8765", "megane.localhost"])
def test_loopback_host_names_are_this_machine(tree, local_client, host):
    root, _ = tree
    configure_files(root)
    assert local_client.get("/api/files", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("host", ["", "[::1"])
def test_missing_or_malformed_host_header_is_refused(tree, local_client, host):
    root, _ = tree
    configure_files(root)
    assert local_client.get("/api/files", headers={"host": host}).status_code == 403


def test_index_is_unmarked_for_a_rebound_host(tree, static_app, local_client):
    root, _ = tree
    configure_files(root)
    assert "megane-server-files" not in local_client.get("/", headers={"host": "evil.example:8765"}).text


def test_cross_origin_file_request_is_refused(tree, local_client):
    root, _ = tree
    configure_files(root)
    params = {"path": "a.pdb"}
    resp = local_client.get("/api/files/content", params=params, headers={"origin": "http://evil.example"})
    assert resp.status_code == 403
    assert "cross-origin" in resp.json()["detail"]
    same = local_client.get("/api/files/content", params=params, headers={"origin": LOCAL_URL})
    assert same.status_code == 200


def test_ip_address_host_reaches_any_host_files(tree):
    """`--host 0.0.0.0 --files-any-host`: other machines browse by IP; Docker's port map arrives as localhost."""
    root, _ = tree
    configure_files(root, any_host=True)
    assert _remote().get("/api/files").status_code == 200
    assert _remote("172.17.0.1", base_url="http://localhost:8080").get("/api/files").status_code == 200
    assert _remote(base_url="http://node42:8765").get("/api/files").status_code == 403


def test_bind_host_name_is_allowed(tree):
    """`--host node42` binds that name, so browsers may use it as Host."""
    root, _ = tree
    configure_files(root, any_host=True)
    configure_hosts("Node42")
    assert _remote(base_url="http://node42:8765").get("/api/files").status_code == 200
    assert _remote(base_url="http://node43:8765").get("/api/files").status_code == 403


def test_allowed_host_behind_a_proxy_is_not_this_machine(tree):
    """A reverse proxy on this machine arrives from loopback, but its clients are not local."""
    root, _ = tree
    configure_files(root)
    configure_hosts("127.0.0.1", ["viewer.example.org"])
    proxied = TestClient(app, base_url="https://viewer.example.org", client=("127.0.0.1", 50000))
    resp = proxied.get("/api/files")
    assert resp.status_code == 403
    assert "--files-any-host" in resp.json()["detail"]
    configure_files(root, any_host=True)
    assert proxied.get("/api/files").status_code == 200


def test_configure_hosts_normalizes_names():
    configure_hosts("[::1]", ["Viewer.Example.org", " lab "])
    assert server._hosts.bind_host == "::1"
    assert server._hosts.allowed == frozenset({"viewer.example.org", "lab"})
    configure_hosts(None)
    assert server._hosts.bind_host is None
    assert server._hosts.allowed == frozenset()
