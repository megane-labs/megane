"""Tests for FastAPI server endpoints."""

import struct
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from megane.protocol import MAGIC, MSG_SNAPSHOT, MSG_METADATA
from megane.server import app, configure, _state, ServerState

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture(autouse=True)
def _reset_state():
    """Reset server state before each test."""
    _state.structure = None
    _state.snapshot_bytes = b""
    _state.structure_path = ""
    _state.xtc_path = None
    _state.trajectory = None
    yield
    _state.structure = None
    _state.snapshot_bytes = b""
    _state.structure_path = ""
    _state.xtc_path = None
    _state.trajectory = None


@pytest.fixture
def client():
    return TestClient(app)


# ─── Health endpoint ─────────────────────────────────────────────────


def test_health_endpoint(client):
    """GET /health returns ok status."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ─── configure() ─────────────────────────────────────────────────────


def test_configure_loads_pdb():
    """configure() populates server state with PDB structure."""
    configure(str(FIXTURES / "1crn.pdb"))

    assert _state.structure is not None
    assert _state.structure.n_atoms == 327
    assert len(_state.snapshot_bytes) > 0
    assert _state.snapshot_bytes[:4] == MAGIC


def test_configure_sets_structure_path():
    """configure() records the structure path."""
    pdb_path = str(FIXTURES / "1crn.pdb")
    configure(pdb_path)
    assert _state.structure_path == pdb_path


# Every structure format, not only PDB: configure() dispatches on the extension
# exactly as LoadStructure and the widget do.
@pytest.mark.parametrize(
    "name",
    ["high_precision.gro", "nacl.cif", "si_diamond.xyz", "methanol.mol2", "1ala.mmcif", "POSCAR_si_diamond"],
)
def test_configure_loads_any_structure_format(name):
    """configure() reads a non-PDB structure with its own parser."""
    from megane.parsers.dispatch import load_structure_file

    path = str(FIXTURES / name)
    configure(path)

    expected = load_structure_file(path)
    assert _state.structure.n_atoms == expected.n_atoms
    assert _state.structure.positions.tolist() == expected.positions.tolist()
    assert _state.structure.elements.tolist() == expected.elements.tolist()
    assert _state.structure_path == path
    assert _state.snapshot_bytes[:4] == MAGIC


def test_configure_gro_reads_nanometres_as_angstroms():
    """A .gro goes through the GRO parser (nm -> Å), not the PDB one."""
    configure(str(FIXTURES / "high_precision.gro"))
    assert _state.structure.n_atoms == 11
    first_line = (FIXTURES / "high_precision.gro").read_text().splitlines()[2]
    x_nm = float(first_line[20:].split()[0])
    assert _state.structure.positions[0][0] == pytest.approx(x_nm * 10, abs=1e-3)


def test_configure_unsupported_extension_keeps_state(tmp_path):
    """An unsupported extension raises and leaves the loaded structure alone."""
    configure(str(FIXTURES / "1crn.pdb"))
    before = _state.snapshot_bytes
    bad = tmp_path / "notes.txt"
    bad.write_text("hello")

    with pytest.raises(ValueError, match="Unsupported structure format"):
        configure(str(bad))

    assert _state.snapshot_bytes == before
    assert _state.structure_path == str(FIXTURES / "1crn.pdb")


def test_configure_extensionless_reads_pdb(tmp_path):
    """An extension-less file keeps the historic PDB reading."""
    plain = tmp_path / "structure"
    plain.write_bytes((FIXTURES / "1crn.pdb").read_bytes())
    configure(str(plain))
    assert _state.structure.n_atoms == 327


def test_configure_positional_traj_loads_frames():
    """A .traj passed as the structure loads every frame, like traj_path=."""
    path = str(FIXTURES / "bond_change.traj")
    configure(path)
    assert _state.trajectory is not None
    assert _state.trajectory.n_frames > 1
    assert _state.structure_path == path
    assert _state.xtc_path is None


def test_configure_traj_path():
    """traj_path= loads topology and frames from the .traj."""
    path = str(FIXTURES / "bond_change.traj")
    configure("", traj_path=path)
    assert _state.trajectory is not None
    assert _state.structure.n_atoms == _state.trajectory.n_atoms
    assert _state.structure_path == path


def test_configure_xtc_with_pdb_topology():
    """PDB topology + XTC loads the trajectory."""
    pdb = str(FIXTURES / "caffeine_water.pdb")
    xtc = str(FIXTURES / "caffeine_water_vibration.xtc")
    configure(pdb, xtc)
    assert _state.trajectory is not None
    assert _state.trajectory.n_atoms == 3024
    assert _state.xtc_path == xtc


def test_configure_xtc_with_non_pdb_topology(tmp_path):
    """An XTC pairs with any structure format as its topology."""
    from megane.parsers.pdb import load_pdb
    from megane.writers import save_structure

    xyz = tmp_path / "caffeine_water.xyz"
    save_structure(load_pdb(str(FIXTURES / "caffeine_water.pdb")), xyz)
    xtc = str(FIXTURES / "caffeine_water_vibration.xtc")

    configure(str(xyz), xtc)

    assert _state.structure.n_atoms == 3024
    assert _state.trajectory is not None
    assert _state.trajectory.n_atoms == 3024


def test_configure_xtc_atom_count_mismatch_keeps_state():
    """A topology / XTC atom-count mismatch raises before state changes."""
    configure(str(FIXTURES / "caffeine_water.pdb"), str(FIXTURES / "caffeine_water_vibration.xtc"))
    traj = _state.trajectory

    with pytest.raises(ValueError, match="Atom count mismatch: topology has 11 atoms"):
        configure(str(FIXTURES / "high_precision.gro"), str(FIXTURES / "caffeine_water_vibration.xtc"))

    assert _state.trajectory is traj
    assert _state.structure.n_atoms == 3024


def test_configure_pdb_path_keyword_is_deprecated():
    """The old pdb_path= keyword still works but warns."""
    path = str(FIXTURES / "1crn.pdb")
    with pytest.warns(DeprecationWarning, match="pdb_path"):
        configure(pdb_path=path)
    assert _state.structure.n_atoms == 327
    assert _state.structure_path == path


def test_configure_rejects_both_path_spellings():
    """structure_path and the deprecated pdb_path= cannot both be given."""
    path = str(FIXTURES / "1crn.pdb")
    with pytest.warns(DeprecationWarning), pytest.raises(TypeError, match="both"):
        configure(path, pdb_path=path)


def test_configure_without_xtc():
    """configure() without XTC sets trajectory to None."""
    configure(str(FIXTURES / "1crn.pdb"))
    assert _state.trajectory is None
    assert _state.xtc_path is None


# ─── WebSocket ───────────────────────────────────────────────────────


def test_websocket_sends_snapshot_on_connect(client):
    """WebSocket sends snapshot and metadata immediately after connection."""
    configure(str(FIXTURES / "1crn.pdb"))

    with client.websocket_connect("/ws") as ws:
        # First message: snapshot
        snapshot_data = ws.receive_bytes()
        assert snapshot_data[:4] == MAGIC
        msg_type = struct.unpack("<B", snapshot_data[4:5])[0]
        assert msg_type == MSG_SNAPSHOT

        # Second message: metadata
        meta_data = ws.receive_bytes()
        assert meta_data[:4] == MAGIC
        msg_type = struct.unpack("<B", meta_data[4:5])[0]
        assert msg_type == MSG_METADATA


def test_websocket_no_data_without_structure(client):
    """WebSocket connects but sends nothing when no structure is loaded."""
    with client.websocket_connect("/ws") as ws:
        # Send a stop command to verify the connection works
        ws.send_text('{"type": "stop"}')
        # No crash means success - the server handles empty state


# ─── Upload endpoint ─────────────────────────────────────────────────


def test_upload_pdb(client):
    """POST /api/upload with PDB file loads structure."""
    pdb_path = FIXTURES / "1crn.pdb"
    pdb_content = pdb_path.read_bytes()

    response = client.post(
        "/api/upload",
        files={"pdb": ("1crn.pdb", pdb_content, "chemical/x-pdb")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["nAtoms"] == 327
    assert data["nBonds"] > 0


def test_upload_gro(client):
    """POST /api/upload dispatches on the uploaded file name's extension."""
    content = (FIXTURES / "high_precision.gro").read_bytes()
    response = client.post("/api/upload", files={"pdb": ("water.gro", content, "text/plain")})
    assert response.status_code == 200
    assert response.json()["nAtoms"] == 11
    assert _state.structure.n_atoms == 11


def test_upload_unsupported_extension_is_400(client):
    """An upload no parser reads is a client error, not a server crash."""
    response = client.post("/api/upload", files={"pdb": ("notes.txt", b"hello", "text/plain")})
    assert response.status_code == 400
    assert "Unsupported structure format" in response.json()["detail"]


# ─── _build_metadata_bytes ──────────────────────────────────────────


def test_build_metadata_bytes():
    """_build_metadata_bytes produces valid metadata message."""
    from megane.server import _build_metadata_bytes

    configure(str(FIXTURES / "1crn.pdb"))

    data = _build_metadata_bytes()
    assert data[:4] == MAGIC
    msg_type = struct.unpack("<B", data[4:5])[0]
    assert msg_type == MSG_METADATA

    # n_frames should be 0 (no trajectory)
    n_frames = struct.unpack("<I", data[8:12])[0]
    assert n_frames == 0


# ─── WebSocket validation ──────────────────────────────────────────


def test_websocket_malformed_json(client):
    """Malformed JSON does not crash the WebSocket connection."""
    with client.websocket_connect("/ws") as ws:
        ws.send_text("not valid json {{{")
        # Connection should still be alive; send a valid command
        ws.send_text('{"type": "stop"}')


def test_websocket_request_frame_missing_key(client):
    """request_frame without 'frame' key is silently ignored."""
    configure(str(FIXTURES / "1crn.pdb"))
    with client.websocket_connect("/ws") as ws:
        ws.receive_bytes()  # snapshot
        ws.receive_bytes()  # metadata
        ws.send_text('{"type": "request_frame"}')
        # Should not crash; send another command to verify
        ws.send_text('{"type": "stop"}')


def test_upload_path_traversal(client):
    """Upload with path traversal filename is sanitized."""
    pdb_path = FIXTURES / "1crn.pdb"
    pdb_content = pdb_path.read_bytes()

    response = client.post(
        "/api/upload",
        files={"pdb": ("../../etc/passwd", pdb_content, "chemical/x-pdb")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["nAtoms"] == 327
