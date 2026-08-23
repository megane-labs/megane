"""Tests for binary protocol."""

import struct
from pathlib import Path

import numpy as np

from megane.parsers.pdb import Structure, load_pdb
from megane.protocol import (
    MAGIC,
    MSG_FRAME,
    MSG_SNAPSHOT,
    HAS_BOND_ORDERS,
    HAS_BOX,
    HAS_BOX_ORIGIN,
    HAS_FRAME_ELEMENTS,
    encode_frame,
    encode_snapshot,
)

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _make_water_structure(n_molecules: int) -> Structure:
    """Create a Structure with randomly placed water molecules.

    Each water molecule: O + H1 + H2 (3 atoms, 2 bonds).
    """
    rng = np.random.RandomState(42)
    n_atoms = n_molecules * 3
    n_bonds = n_molecules * 2

    # Water geometry
    oh_length = 0.96
    half_angle = np.radians(104.5 / 2)
    h1_offset = np.array(
        [oh_length * np.sin(half_angle), oh_length * np.cos(half_angle), 0.0],
        dtype=np.float32,
    )
    h2_offset = np.array(
        [-oh_length * np.sin(half_angle), oh_length * np.cos(half_angle), 0.0],
        dtype=np.float32,
    )

    # Place molecules on a cubic grid with random offset
    side = int(np.ceil(n_molecules ** (1.0 / 3.0)))
    spacing = 3.5
    positions = np.empty((n_atoms, 3), dtype=np.float32)
    elements = np.empty(n_atoms, dtype=np.uint8)
    bonds = np.empty((n_bonds, 2), dtype=np.uint32)
    bond_orders = np.ones(n_bonds, dtype=np.uint8)

    mol = 0
    for iz in range(side):
        for iy in range(side):
            for ix in range(side):
                if mol >= n_molecules:
                    break
                center = np.array(
                    [ix * spacing, iy * spacing, iz * spacing], dtype=np.float32
                )
                center += rng.uniform(-0.5, 0.5, size=3).astype(np.float32)

                base = mol * 3
                positions[base] = center
                positions[base + 1] = center + h1_offset
                positions[base + 2] = center + h2_offset

                elements[base] = 8  # O
                elements[base + 1] = 1  # H
                elements[base + 2] = 1  # H

                bonds[mol * 2] = [base, base + 1]
                bonds[mol * 2 + 1] = [base, base + 2]

                mol += 1
            if mol >= n_molecules:
                break
        if mol >= n_molecules:
            break

    return Structure(
        n_atoms=n_atoms,
        positions=positions,
        elements=elements,
        bonds=bonds,
        bond_orders=bond_orders,
        box=np.zeros((3, 3), dtype=np.float32),
    )


def test_encode_snapshot_header():
    """Test that snapshot starts with correct magic and message type."""
    s = load_pdb(str(FIXTURES / "1crn.pdb"))
    data = encode_snapshot(s)

    assert data[:4] == MAGIC
    msg_type = struct.unpack("<B", data[4:5])[0]
    assert msg_type == MSG_SNAPSHOT


def test_encode_snapshot_flags():
    """Test that flags are set for bond orders and box."""
    s = load_pdb(str(FIXTURES / "1crn.pdb"))
    data = encode_snapshot(s)

    flags = struct.unpack("<B", data[5:6])[0]

    # Should have bond orders
    if len(s.bond_orders) > 0:
        assert flags & HAS_BOND_ORDERS

    # Should have box if CRYST1 was parsed
    if np.any(s.box != 0):
        assert flags & HAS_BOX


def test_encode_snapshot_atom_count():
    """Test that encoded snapshot contains correct atom count."""
    s = load_pdb(str(FIXTURES / "1crn.pdb"))
    data = encode_snapshot(s)

    n_atoms = struct.unpack("<I", data[8:12])[0]
    assert n_atoms == 327


def test_encode_decode_roundtrip():
    """Test that positions survive encode/decode roundtrip."""
    s = load_pdb(str(FIXTURES / "1crn.pdb"))
    data = encode_snapshot(s)

    # Parse manually
    offset = 8  # skip header
    n_atoms = struct.unpack("<I", data[offset : offset + 4])[0]
    offset += 4
    n_bonds = struct.unpack("<I", data[offset : offset + 4])[0]
    offset += 4

    positions = np.frombuffer(data[offset : offset + n_atoms * 12], dtype=np.float32)
    positions = positions.reshape(n_atoms, 3)
    offset += n_atoms * 12

    elements = np.frombuffer(data[offset : offset + n_atoms], dtype=np.uint8)
    offset += n_atoms
    offset += (4 - (offset % 4)) % 4  # alignment

    np.testing.assert_array_almost_equal(positions, s.positions, decimal=5)
    np.testing.assert_array_equal(elements, s.elements)

    # Bonds
    bonds = np.frombuffer(data[offset : offset + n_bonds * 8], dtype=np.uint32)
    bonds = bonds.reshape(n_bonds, 2)
    offset += n_bonds * 8
    np.testing.assert_array_equal(bonds, s.bonds)

    # Bond orders (if present)
    flags = struct.unpack("<B", data[5:6])[0]
    if flags & HAS_BOND_ORDERS:
        bond_orders = np.frombuffer(data[offset : offset + n_bonds], dtype=np.uint8)
        offset += n_bonds
        offset += (4 - (offset % 4)) % 4
        np.testing.assert_array_equal(bond_orders, s.bond_orders)

    # Box (if present)
    if flags & HAS_BOX:
        box = np.frombuffer(data[offset : offset + 36], dtype=np.float32).reshape(3, 3)
        np.testing.assert_array_almost_equal(box, s.box, decimal=5)


def test_encode_snapshot_box_origin():
    """An offset box origin is flagged and appended after the box (3 floats)."""
    s = _make_water_structure(2)
    s.box = np.eye(3, dtype=np.float32) * 10.0
    s.box_origin = np.array([160.0, 0.0, 600.0], dtype=np.float32)
    data = encode_snapshot(s)

    flags = struct.unpack("<B", data[5:6])[0]
    assert flags & HAS_BOX
    assert flags & HAS_BOX_ORIGIN

    # The origin is the last 12 bytes (3 float32), directly after the 36-byte box.
    origin = np.frombuffer(data[-12:], dtype=np.float32)
    np.testing.assert_array_almost_equal(origin, s.box_origin, decimal=5)


def test_encode_snapshot_zero_origin_omits_flag():
    """A zero (or absent) origin does not set HAS_BOX_ORIGIN — byte-compatible."""
    s = _make_water_structure(2)
    s.box = np.eye(3, dtype=np.float32) * 10.0
    # box_origin defaults to zeros(3).
    data = encode_snapshot(s)
    flags = struct.unpack("<B", data[5:6])[0]
    assert flags & HAS_BOX
    assert not (flags & HAS_BOX_ORIGIN)


def test_encode_snapshot_symmetry_ops():
    """Symmetry operations are flagged and appended as a length-prefixed,
    newline-joined utf-8 blob padded to 4 bytes."""
    from megane.protocol import HAS_SYMMETRY_OPS

    s = _make_water_structure(1)
    s.symmetry_ops = ["x, y, z", "-x+1/2,y+1/2,-z"]
    data = encode_snapshot(s)

    flags = struct.unpack("<B", data[5:6])[0]
    assert flags & HAS_SYMMETRY_OPS

    raw = "\n".join(s.symmetry_ops).encode("utf-8")
    padding = (4 - ((4 + len(raw)) % 4)) % 4
    tail = data[-(4 + len(raw) + padding) :]
    assert struct.unpack("<I", tail[:4])[0] == len(raw)
    assert tail[4 : 4 + len(raw)] == raw
    assert len(data) % 4 == 0


def test_encode_snapshot_no_symmetry_ops_omits_flag():
    """Structures without symmetry ops stay byte-identical to the old layout."""
    from megane.protocol import HAS_SYMMETRY_OPS

    s = _make_water_structure(1)
    data = encode_snapshot(s)
    flags = struct.unpack("<B", data[5:6])[0]
    assert not (flags & HAS_SYMMETRY_OPS)


def test_encode_snapshot_100k_atoms():
    """Test that 100k atoms can be encoded and decoded correctly."""
    n_molecules = 33_334  # 100,002 atoms
    s = _make_water_structure(n_molecules)
    n_atoms_expected = n_molecules * 3
    n_bonds_expected = n_molecules * 2

    assert s.n_atoms == n_atoms_expected

    data = encode_snapshot(s)

    # Decode and verify
    offset = 8  # skip header
    n_atoms = struct.unpack("<I", data[offset : offset + 4])[0]
    offset += 4
    n_bonds = struct.unpack("<I", data[offset : offset + 4])[0]
    offset += 4

    assert n_atoms == n_atoms_expected
    assert n_bonds == n_bonds_expected

    # Positions roundtrip
    positions = np.frombuffer(
        data[offset : offset + n_atoms * 12], dtype=np.float32
    ).reshape(n_atoms, 3)
    offset += n_atoms * 12
    np.testing.assert_array_almost_equal(positions, s.positions, decimal=5)

    # Elements roundtrip
    elements = np.frombuffer(data[offset : offset + n_atoms], dtype=np.uint8)
    offset += n_atoms
    offset += (4 - (offset % 4)) % 4
    np.testing.assert_array_equal(elements, s.elements)

    # Verify element distribution: 1/3 oxygen (8), 2/3 hydrogen (1)
    unique, counts = np.unique(elements, return_counts=True)
    elem_counts = dict(zip(unique, counts))
    assert elem_counts[8] == n_molecules  # O
    assert elem_counts[1] == n_molecules * 2  # H

    # Bonds roundtrip
    bonds = np.frombuffer(
        data[offset : offset + n_bonds * 8], dtype=np.uint32
    ).reshape(n_bonds, 2)
    offset += n_bonds * 8
    np.testing.assert_array_equal(bonds, s.bonds)

    # Bond orders
    flags = struct.unpack("<B", data[5:6])[0]
    if flags & HAS_BOND_ORDERS:
        bond_orders = np.frombuffer(data[offset : offset + n_bonds], dtype=np.uint8)
        np.testing.assert_array_equal(bond_orders, np.ones(n_bonds, dtype=np.uint8))


def test_encode_frame_positions_only_backward_compat():
    """A positions-only frame carries no flags and the legacy layout."""
    positions = np.arange(6, dtype=np.float32).reshape(2, 3)
    data = encode_frame(3, positions)
    assert data[:4] == MAGIC
    msg_type, flags = struct.unpack("<BB", data[4:6])
    assert msg_type == MSG_FRAME
    assert flags == 0
    frame_id, n_atoms = struct.unpack("<II", data[8:16])
    assert frame_id == 3
    assert n_atoms == 2
    # Header(8) + frame_header(8) + positions(2*3*4) and nothing else.
    assert len(data) == 8 + 8 + 2 * 3 * 4


def test_encode_frame_with_elements_and_box():
    """Per-frame elements and cell are appended behind their flags."""
    positions = np.zeros((2, 3), dtype=np.float32)
    elements = np.array([6, 8], dtype=np.uint8)
    box = np.eye(3, dtype=np.float32) * 12.0
    data = encode_frame(1, positions, elements=elements, box=box)

    _, _, flags, _ = struct.unpack("<IBBH", data[:8])
    assert flags == (HAS_FRAME_ELEMENTS | HAS_BOX)

    offset = 16 + 2 * 3 * 4  # header + frame_header + positions
    # elements padded to 4 bytes.
    elem = np.frombuffer(data[offset : offset + 2], dtype=np.uint8)
    assert elem.tolist() == [6, 8]
    offset += 4  # ceil(2/4)*4
    box_out = np.frombuffer(data[offset : offset + 36], dtype=np.float32).reshape(3, 3)
    np.testing.assert_allclose(box_out, box)
