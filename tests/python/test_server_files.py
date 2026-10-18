"""Tests for the web UI's server file browsing (``/api/files``)."""

import os

import pytest
from starlette.testclient import TestClient

from megane.server import _files, _is_loopback, app, configure_files


@pytest.fixture(autouse=True)
def _reset_files():
    yield
    configure_files(None)


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
    return TestClient(app, client=("127.0.0.1", 50000))


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
    remote = TestClient(app, client=("192.168.1.20", 50000))
    resp = remote.get("/api/files")
    assert resp.status_code == 403
    assert "--files-any-host" in resp.json()["detail"]
    assert remote.get("/api/files/content", params={"path": "a.pdb"}).status_code == 403
    assert TestClient(app, client=("::1", 1)).get("/api/files").status_code == 200
    assert TestClient(app, client=("localhost", 1)).get("/api/files").status_code == 200


def test_any_host_serves_every_client(tree):
    root, _ = tree
    configure_files(root, any_host=True)
    assert _files.any_host is True
    remote = TestClient(app, client=("192.168.1.20", 50000))
    assert remote.get("/api/files").status_code == 200


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
