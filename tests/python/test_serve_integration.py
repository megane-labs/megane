"""Integration tests for megane serve CLI command.

Starts the server as a subprocess and verifies HTTP endpoints respond correctly.
These tests validate post-pip-install functionality.
"""

import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _free_port() -> int:
    """Find a free TCP port."""
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def _wait_for_health(port: int, timeout: float = 6.0) -> None:
    """Poll GET /health until the server is ready."""
    url = f"http://localhost:{port}/health"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, timeout=1.0)
            if r.status_code == 200:
                return
        except httpx.ConnectError:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"Server did not start on port {port} within {timeout}s")


@pytest.fixture
def serve(request):
    """Factory fixture that starts megane serve and yields (process, port).

    Usage in tests::

        proc, port = serve("1crn.pdb")
        proc, port = serve()  # no PDB
        proc, port = serve("caffeine_water.pdb", "--xtc", "caffeine_water_vibration.xtc")
    """
    processes: list[subprocess.Popen] = []

    def _start(*extra_args: str, entry_point: str | None = None) -> tuple[subprocess.Popen, int]:
        port = _free_port()
        if entry_point is not None:
            cmd = [entry_point, "serve"]
        else:
            cmd = [sys.executable, "-m", "megane.cli", "serve"]
        cmd.extend(extra_args)
        cmd.extend(["--no-browser", "--port", str(port)])
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        _wait_for_health(port)
        processes.append(proc)
        return proc, port

    yield _start

    for proc in processes:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# ─── Tests ───────────────────────────────────────────────────────────


def test_serve_starts_and_responds(serve):
    """megane serve with a PDB file starts and responds to /health."""
    _, port = serve(str(FIXTURES / "1crn.pdb"))
    r = httpx.get(f"http://localhost:{port}/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_serve_entry_point(serve):
    """The 'megane' console script entry point works after pip install."""
    megane_bin = shutil.which("megane")
    if megane_bin is None:
        # Check venv bin directory (entry point may not be on PATH)
        venv_bin = Path(sys.executable).parent / "megane"
        if venv_bin.exists():
            megane_bin = str(venv_bin)
        else:
            pytest.skip("megane entry point not found")
    _, port = serve(str(FIXTURES / "1crn.pdb"), entry_point=megane_bin)
    r = httpx.get(f"http://localhost:{port}/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_serve_no_pdb_waits_for_upload(serve):
    """megane serve without a PDB file starts and waits for upload."""
    _, port = serve()
    r = httpx.get(f"http://localhost:{port}/health")
    assert r.status_code == 200


def test_serve_with_xtc(serve):
    """megane serve with PDB + XTC trajectory starts successfully."""
    _, port = serve(
        str(FIXTURES / "caffeine_water.pdb"),
        "--xtc", str(FIXTURES / "caffeine_water_vibration.xtc"),
    )
    r = httpx.get(f"http://localhost:{port}/health")
    assert r.status_code == 200


def test_serve_upload_while_running(serve):
    """POST /api/upload loads a structure on a running server."""
    _, port = serve()
    pdb_content = (FIXTURES / "1crn.pdb").read_bytes()
    r = httpx.post(
        f"http://localhost:{port}/api/upload",
        files={"pdb": ("1crn.pdb", pdb_content, "chemical/x-pdb")},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["nAtoms"] == 327
    assert data["nBonds"] > 0


def test_serve_refuses_other_sites(serve, tmp_path):
    """Hidden files, rebound Host names and cross-origin pages are refused by a running server."""
    from websockets.exceptions import InvalidStatus
    from websockets.sync.client import connect

    (tmp_path / ".ssh").mkdir()
    (tmp_path / ".ssh" / "id_rsa").write_text("PRIVATE KEY\n")
    (tmp_path / "a.pdb").write_bytes((FIXTURES / "1crn.pdb").read_bytes())
    _, port = serve(str(FIXTURES / "1crn.pdb"), "--files-root", str(tmp_path))
    base = f"http://127.0.0.1:{port}"

    content = f"{base}/api/files/content"
    assert httpx.get(content, params={"path": "a.pdb"}).status_code == 200
    assert httpx.get(content, params={"path": ".ssh/id_rsa"}).status_code == 403
    rebound = httpx.get(content, params={"path": "a.pdb"}, headers={"host": f"evil.example:{port}"})
    assert rebound.status_code == 403

    upload = httpx.post(
        f"{base}/api/upload",
        files={"pdb": ("1crn.pdb", (FIXTURES / "1crn.pdb").read_bytes(), "chemical/x-pdb")},
        headers={"origin": "http://evil.example"},
    )
    assert upload.status_code == 403

    with pytest.raises(InvalidStatus) as exc:
        connect(f"ws://127.0.0.1:{port}/ws", origin="http://evil.example", open_timeout=5)
    assert exc.value.response.status_code == 403
    with connect(f"ws://127.0.0.1:{port}/ws", origin=base, open_timeout=5) as ws:
        assert ws.recv(timeout=5)[:4] == b"MEGN"
