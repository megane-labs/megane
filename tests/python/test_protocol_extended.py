"""Tests for encode_frame(), encode_metadata() and encode_trajectory() in binary protocol."""

import struct

import numpy as np
import pytest

from megane.protocol import (
    MAGIC,
    MSG_FRAME,
    MSG_METADATA,
    MSG_SNAPSHOT,
    MSG_TRAJECTORY,
    HAS_BOND_ORDERS,
    HAS_BOX,
    encode_frame,
    encode_metadata,
    encode_snapshot,
    encode_trajectory,
)
from megane.parsers.pdb import Structure


# ─── encode_frame ─────────────────────────────────────────────────────


def test_encode_frame_header():
    """Frame message starts with correct magic and message type."""
    positions = np.array([[1.0, 2.0, 3.0]], dtype=np.float32)
    data = encode_frame(0, positions)

    assert data[:4] == MAGIC
    msg_type = struct.unpack("<B", data[4:5])[0]
    assert msg_type == MSG_FRAME


def test_encode_frame_payload():
    """Frame payload contains correct frame_id and n_atoms."""
    positions = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    data = encode_frame(42, positions)

    # Header is 8 bytes, then frame_id(4) + n_atoms(4)
    frame_id, n_atoms = struct.unpack("<II", data[8:16])
    assert frame_id == 42
    assert n_atoms == 2


def test_encode_frame_positions_roundtrip():
    """Positions survive encode roundtrip."""
    original = np.array(
        [[1.5, -2.3, 0.0], [100.0, 200.0, 300.0], [0.001, 0.002, 0.003]],
        dtype=np.float32,
    )
    data = encode_frame(0, original)

    # Skip header(8) + frame_id(4) + n_atoms(4) = 16 bytes
    decoded = np.frombuffer(data[16:], dtype=np.float32).reshape(-1, 3)
    np.testing.assert_array_almost_equal(decoded, original, decimal=5)


def test_encode_frame_zero_atoms():
    """Frame with zero atoms produces valid message."""
    positions = np.empty((0, 3), dtype=np.float32)
    data = encode_frame(0, positions)

    frame_id, n_atoms = struct.unpack("<II", data[8:16])
    assert frame_id == 0
    assert n_atoms == 0
    # Total size: header(8) + frame_header(8) + 0 position bytes
    assert len(data) == 16


def test_encode_frame_large_frame_id():
    """Large frame IDs are encoded correctly."""
    positions = np.array([[0.0, 0.0, 0.0]], dtype=np.float32)
    data = encode_frame(999999, positions)

    frame_id = struct.unpack("<I", data[8:12])[0]
    assert frame_id == 999999


# ─── encode_metadata ─────────────────────────────────────────────────


def test_encode_metadata_header():
    """Metadata message starts with correct magic and message type."""
    data = encode_metadata(n_frames=100, timestep_ps=2.0, n_atoms=327)

    assert data[:4] == MAGIC
    msg_type = struct.unpack("<B", data[4:5])[0]
    assert msg_type == MSG_METADATA


def test_encode_metadata_payload():
    """Metadata payload contains correct n_frames, timestep, n_atoms."""
    data = encode_metadata(n_frames=500, timestep_ps=1.5, n_atoms=1000)

    # Header(8) + n_frames(4) + timestep(4) + n_atoms(4)
    n_frames, timestep, n_atoms = struct.unpack("<IfI", data[8:20])
    assert n_frames == 500
    assert abs(timestep - 1.5) < 1e-5
    assert n_atoms == 1000


def test_encode_metadata_file_names():
    """File name strings are correctly encoded as length-prefixed UTF-8."""
    data = encode_metadata(
        n_frames=10,
        timestep_ps=2.0,
        n_atoms=100,
        pdb_name="protein.pdb",
        xtc_name="traj.xtc",
    )

    # After header(8) + payload(12) = offset 20
    offset = 20

    # PDB name: length(2) + bytes
    pdb_len = struct.unpack("<H", data[offset : offset + 2])[0]
    offset += 2
    pdb_name = data[offset : offset + pdb_len].decode("utf-8")
    offset += pdb_len
    assert pdb_name == "protein.pdb"

    # XTC name: length(2) + bytes
    xtc_len = struct.unpack("<H", data[offset : offset + 2])[0]
    offset += 2
    xtc_name = data[offset : offset + xtc_len].decode("utf-8")
    assert xtc_name == "traj.xtc"


def test_encode_metadata_empty_file_names():
    """Empty file names produce zero-length strings."""
    data = encode_metadata(n_frames=0, timestep_ps=0.0, n_atoms=0)

    offset = 20
    pdb_len = struct.unpack("<H", data[offset : offset + 2])[0]
    offset += 2
    assert pdb_len == 0

    xtc_len = struct.unpack("<H", data[offset : offset + 2])[0]
    assert xtc_len == 0


def test_encode_metadata_unicode_file_names():
    """Unicode file names are correctly encoded."""
    data = encode_metadata(
        n_frames=1,
        timestep_ps=1.0,
        n_atoms=1,
        pdb_name="構造.pdb",
        xtc_name="軌道.xtc",
    )

    offset = 20
    pdb_len = struct.unpack("<H", data[offset : offset + 2])[0]
    offset += 2
    pdb_name = data[offset : offset + pdb_len].decode("utf-8")
    offset += pdb_len
    assert pdb_name == "構造.pdb"

    xtc_len = struct.unpack("<H", data[offset : offset + 2])[0]
    offset += 2
    xtc_name = data[offset : offset + xtc_len].decode("utf-8")
    assert xtc_name == "軌道.xtc"


# ─── encode_snapshot edge cases ───────────────────────────────────────


def test_encode_snapshot_zero_atoms():
    """Snapshot with zero atoms produces valid message."""
    s = Structure(
        n_atoms=0,
        positions=np.empty((0, 3), dtype=np.float32),
        elements=np.empty(0, dtype=np.uint8),
        bonds=np.empty((0, 2), dtype=np.uint32),
        bond_orders=np.empty(0, dtype=np.uint8),
        box=np.zeros((3, 3), dtype=np.float32),
    )
    data = encode_snapshot(s)

    assert data[:4] == MAGIC
    msg_type = struct.unpack("<B", data[4:5])[0]
    assert msg_type == MSG_SNAPSHOT

    n_atoms, n_bonds = struct.unpack("<II", data[8:16])
    assert n_atoms == 0
    assert n_bonds == 0


def test_encode_snapshot_no_bonds():
    """Snapshot with atoms but no bonds is valid."""
    s = Structure(
        n_atoms=3,
        positions=np.array([[0, 0, 0], [1, 0, 0], [2, 0, 0]], dtype=np.float32),
        elements=np.array([1, 1, 1], dtype=np.uint8),
        bonds=np.empty((0, 2), dtype=np.uint32),
        bond_orders=np.empty(0, dtype=np.uint8),
        box=np.zeros((3, 3), dtype=np.float32),
    )
    data = encode_snapshot(s)

    n_atoms, n_bonds = struct.unpack("<II", data[8:16])
    assert n_atoms == 3
    assert n_bonds == 0

    flags = struct.unpack("<B", data[5:6])[0]
    assert not (flags & HAS_BOND_ORDERS)  # no bond orders for empty bonds


def test_encode_snapshot_with_box():
    """Snapshot with non-zero box sets HAS_BOX flag."""
    box = np.array([[10, 0, 0], [0, 10, 0], [0, 0, 10]], dtype=np.float32)
    s = Structure(
        n_atoms=1,
        positions=np.array([[5, 5, 5]], dtype=np.float32),
        elements=np.array([1], dtype=np.uint8),
        bonds=np.empty((0, 2), dtype=np.uint32),
        bond_orders=np.empty(0, dtype=np.uint8),
        box=box,
    )
    data = encode_snapshot(s)

    flags = struct.unpack("<B", data[5:6])[0]
    assert flags & HAS_BOX


# ─── encode_trajectory ─────────────────────────────────────────────────


def test_encode_trajectory_layout():
    """Header, frame count, offset table, then the frame messages back to back."""
    frames = [
        encode_frame(0, np.zeros((2, 3), dtype=np.float32)),
        encode_frame(1, np.ones((3, 3), dtype=np.float32)),
    ]
    data = encode_trajectory(frames)

    assert data[:4] == MAGIC
    msg_type, flags, _ = struct.unpack_from("<BBH", data, 4)
    assert (msg_type, flags) == (MSG_TRAJECTORY, 0)
    n_frames, *offsets = struct.unpack_from("<4I", data, 8)
    assert n_frames == 2
    assert offsets == [24, 24 + len(frames[0]), len(data)]
    assert data[offsets[0] : offsets[1]] == frames[0]
    assert data[offsets[1] : offsets[2]] == frames[1]
    assert all(o % 4 == 0 for o in offsets)


def test_encode_trajectory_empty():
    data = encode_trajectory([])
    assert struct.unpack_from("<II", data, 8) == (0, 16)
    assert len(data) == 16


def test_encode_trajectory_rejects_over_4gib():
    class _Huge(bytes):
        def __len__(self) -> int:
            return 3 * 1024**3

    with pytest.raises(ValueError, match="4 GiB"):
        encode_trajectory([_Huge(), _Huge()])
