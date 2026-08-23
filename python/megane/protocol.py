"""Binary protocol for Python -> JavaScript data transfer.

Protocol format:
  Header (8 bytes):
    magic:    4 bytes "MEGN"
    msg_type: u8 (0=snapshot, 1=frame, 2=metadata)
    flags:    u8 (bit 0: HAS_BOND_ORDERS, bit 1: HAS_BOX, bit 3: HAS_BOX_ORIGIN,
                  bit 4: HAS_SYMMETRY_OPS)
    reserved: 2 bytes

  Snapshot payload:
    n_atoms:      u32
    n_bonds:      u32
    positions:    Float32[n_atoms * 3]
    elements:     Uint8[n_atoms]     + pad to 4 bytes
    bonds:        Uint32[n_bonds * 2]
    bond_orders:  Uint8[n_bonds]     + pad to 4 bytes  (if HAS_BOND_ORDERS)
    box:          Float32[9]         (3x3 row-major)   (if HAS_BOX)
    box_origin:   Float32[3]         (xlo,ylo,zlo)     (if HAS_BOX_ORIGIN)
    symmetry_ops: u32 byte length + newline-joined utf-8 `x,y,z` strings
                  + pad to 4 bytes                     (if HAS_SYMMETRY_OPS)

  Frame payload:
    frame_id:   u32
    n_atoms:    u32
    positions:  Float32[n_atoms * 3]
    elements:   Uint8[n_atoms]  + pad to 4 bytes  (if HAS_FRAME_ELEMENTS)
    box:        Float32[9]       (3x3 row-major)   (if HAS_BOX)

  The optional frame elements/box carry per-frame topology/cell for
  heterogeneous trajectories; a frame that omits them (flags 0) is byte-identical
  to the original positions-only layout, so uniform playback is unchanged.
"""

from __future__ import annotations

import struct
from typing import Protocol, runtime_checkable

import numpy as np

__all__ = [
    "encode_snapshot",
    "encode_frame",
    "encode_metadata",
    "StructureLike",
    "MSG_SNAPSHOT",
    "MSG_FRAME",
    "MSG_METADATA",
]

MAGIC = b"MEGN"
MSG_SNAPSHOT = 0
MSG_FRAME = 1
MSG_METADATA = 2

HAS_BOND_ORDERS = 0x01
HAS_BOX = 0x02
HAS_FRAME_ELEMENTS = 0x04
HAS_BOX_ORIGIN = 0x08
HAS_SYMMETRY_OPS = 0x10


@runtime_checkable
class StructureLike(Protocol):
    """Structural contract for objects that can be encoded as snapshots."""

    n_atoms: int
    positions: np.ndarray  # (N, 3) float32
    elements: np.ndarray  # (N,) uint8
    bonds: np.ndarray  # (M, 2) uint32
    bond_orders: np.ndarray  # (M,) uint8
    box: np.ndarray  # (3, 3) float32
    box_origin: np.ndarray  # (3,) float32 — box lower corner; zero if unset


def encode_snapshot(structure: StructureLike) -> bytes:
    """Encode a molecular structure as a binary snapshot message."""
    n_atoms = structure.n_atoms
    n_bonds = len(structure.bonds)

    flags = 0

    # Positions: float32 * n_atoms * 3
    pos_bytes = structure.positions.astype(np.float32).tobytes()

    # Elements: uint8 * n_atoms, padded to 4-byte alignment
    elem_bytes = structure.elements.astype(np.uint8).tobytes()
    padding_len = (4 - (len(elem_bytes) % 4)) % 4
    elem_bytes += b"\x00" * padding_len

    # Bonds: uint32 * n_bonds * 2
    bond_bytes = structure.bonds.astype(np.uint32).tobytes()

    # Bond orders (optional)
    bond_order_bytes = b""
    if len(structure.bond_orders) > 0:
        flags |= HAS_BOND_ORDERS
        bo_raw = structure.bond_orders.astype(np.uint8).tobytes()
        bo_padding = (4 - (len(bo_raw) % 4)) % 4
        bond_order_bytes = bo_raw + b"\x00" * bo_padding

    # Box (optional)
    box_bytes = b""
    if np.any(structure.box != 0):
        flags |= HAS_BOX
        box_bytes = structure.box.astype(np.float32).flatten().tobytes()

    # Box origin (optional; only meaningful alongside a box). Emitted when the
    # lower corner is offset from the world origin — e.g. a LAMMPS box far from
    # (0,0,0) — so the frontend draws the cell around its (absolute) atoms.
    origin_bytes = b""
    box_origin = getattr(structure, "box_origin", None)
    if (flags & HAS_BOX) and box_origin is not None and np.any(np.asarray(box_origin) != 0):
        flags |= HAS_BOX_ORIGIN
        origin_bytes = np.asarray(box_origin, dtype=np.float32).flatten().tobytes()

    # Symmetry operations (optional): u32 byte length + newline-joined utf-8
    # `x,y,z` strings, padded to 4-byte alignment. The frontend symmetry node
    # applies them; the snapshot itself stays the asymmetric unit as parsed.
    symops_bytes = b""
    symmetry_ops = getattr(structure, "symmetry_ops", None)
    if symmetry_ops:
        flags |= HAS_SYMMETRY_OPS
        raw = "\n".join(symmetry_ops).encode("utf-8")
        sym_padding = (4 - ((4 + len(raw)) % 4)) % 4
        symops_bytes = struct.pack("<I", len(raw)) + raw + b"\x00" * sym_padding

    # Header: magic(4) + msg_type(1) + flags(1) + reserved(2) = 8 bytes
    header = MAGIC + struct.pack("<BBH", MSG_SNAPSHOT, flags, 0)

    # Snapshot header: n_atoms(4) + n_bonds(4) = 8 bytes
    snapshot_header = struct.pack("<II", n_atoms, n_bonds)

    return (
        header
        + snapshot_header
        + pos_bytes
        + elem_bytes
        + bond_bytes
        + bond_order_bytes
        + box_bytes
        + origin_bytes
        + symops_bytes
    )


def encode_frame(
    frame_id: int,
    positions: np.ndarray,
    elements: np.ndarray | None = None,
    box: np.ndarray | None = None,
) -> bytes:
    """Encode a trajectory frame as a binary message.

    Args:
        frame_id: 0-based frame index.
        positions: (N, 3) float32 atom positions.
        elements: optional (N,) uint8 per-frame atomic numbers (heterogeneous
            topology). Omit for uniform trajectories (host reuses the snapshot).
        box: optional (3, 3) float32 per-frame unit cell. Omit for a constant cell.

    A call with neither ``elements`` nor ``box`` produces the original
    positions-only layout, so uniform playback is byte-identical.
    """
    n_atoms = len(positions)

    flags = 0
    pos_bytes = positions.astype(np.float32).tobytes()

    elem_bytes = b""
    if elements is not None:
        flags |= HAS_FRAME_ELEMENTS
        raw = np.asarray(elements, dtype=np.uint8).tobytes()
        pad = (4 - (len(raw) % 4)) % 4
        elem_bytes = raw + b"\x00" * pad

    box_bytes = b""
    if box is not None:
        flags |= HAS_BOX
        box_bytes = np.asarray(box, dtype=np.float32).flatten().tobytes()

    header = MAGIC + struct.pack("<BBH", MSG_FRAME, flags, 0)
    frame_header = struct.pack("<II", frame_id, n_atoms)

    return header + frame_header + pos_bytes + elem_bytes + box_bytes


def encode_metadata(
    n_frames: int,
    timestep_ps: float,
    n_atoms: int,
    pdb_name: str = "",
    xtc_name: str = "",
) -> bytes:
    """Encode trajectory metadata message.

    Includes optional file name strings appended as length-prefixed UTF-8.
    """
    header = MAGIC + struct.pack("<BBH", MSG_METADATA, 0, 0)
    payload = struct.pack("<IfI", n_frames, timestep_ps, n_atoms)
    # Append file names as length-prefixed UTF-8
    pdb_bytes = pdb_name.encode("utf-8")
    xtc_bytes = xtc_name.encode("utf-8")
    payload += struct.pack("<H", len(pdb_bytes)) + pdb_bytes
    payload += struct.pack("<H", len(xtc_bytes)) + xtc_bytes
    return header + payload
