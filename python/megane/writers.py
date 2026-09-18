"""Structure writers backed by the shared Rust core (``megane_core::writer``).

The inverse of the ``load_*`` readers for the formats a user most often hands
to another tool after building or editing a structure in megane: XYZ (extended
XYZ when the structure carries a unit cell), PDB, and MDL Molfile (V2000).
The same Rust code serves the browser hosts through WASM, so a file written
here and one exported from the Build panel are byte-for-byte identical.
"""

from __future__ import annotations

import os
from typing import Literal

import numpy as np

from megane import megane_parser
from megane.parsers.pdb import Structure

__all__ = ["StructureFormat", "write_structure", "save_structure", "format_from_path"]

StructureFormat = Literal["xyz", "pdb", "mol"]

_EXTENSION_FORMATS: dict[str, StructureFormat] = {
    ".xyz": "xyz",
    ".extxyz": "xyz",
    ".pdb": "pdb",
    ".mol": "mol",
    ".sdf": "mol",
}


def format_from_path(path: str | os.PathLike[str]) -> StructureFormat:
    """Infer the output format from a file extension.

    Raises:
        ValueError: If the extension is not one of ``.xyz`` / ``.extxyz`` /
            ``.pdb`` / ``.mol`` / ``.sdf``.
    """
    ext = os.path.splitext(os.fspath(path))[1].lower()
    try:
        return _EXTENSION_FORMATS[ext]
    except KeyError:
        supported = ", ".join(sorted(_EXTENSION_FORMATS))
        raise ValueError(f"cannot infer a structure format from {ext!r}; supported extensions: {supported}") from None


def write_structure(
    structure: Structure,
    fmt: StructureFormat,
    *,
    atom_labels: list[str] | None = None,
    chain_ids: np.ndarray | list[int] | None = None,
) -> str:
    """Serialize a :class:`~megane.parsers.pdb.Structure` to text.

    Args:
        structure: The structure to write. ``box`` is treated as absent when it
            is all zeros, matching the reader convention.
        fmt: ``"xyz"``, ``"pdb"``, or ``"mol"``.
        atom_labels: Optional per-atom residue labels in megane's ``ALA42``
            form; only the PDB writer uses them (``UNK 1`` otherwise).
        chain_ids: Optional per-atom chain identifiers as ASCII codes.

    Returns:
        The file contents as a string.
    """
    positions = np.ascontiguousarray(structure.positions, dtype=np.float32).reshape(-1, 3)
    elements = np.ascontiguousarray(structure.elements, dtype=np.uint8)
    bonds = np.ascontiguousarray(structure.bonds, dtype=np.uint32).reshape(-1, 2)
    bond_orders = None
    if structure.bond_orders is not None and len(structure.bond_orders) == len(bonds):
        bond_orders = np.ascontiguousarray(structure.bond_orders, dtype=np.uint8)
    box = None
    if structure.box is not None:
        box_arr = np.ascontiguousarray(structure.box, dtype=np.float32).reshape(3, 3)
        if np.any(box_arr != 0):
            box = box_arr
    chains = None if chain_ids is None else [int(c) for c in chain_ids]
    return megane_parser.write_structure(
        fmt,
        positions,
        elements,
        bonds,
        bond_orders,
        box,
        atom_labels,
        chains,
    )


def save_structure(
    structure: Structure,
    path: str | os.PathLike[str],
    fmt: StructureFormat | None = None,
    **kwargs,
) -> None:
    """Write a structure to ``path``, inferring the format from the extension
    unless ``fmt`` is given. Extra keyword arguments go to
    :func:`write_structure`."""
    resolved = fmt or format_from_path(path)
    text = write_structure(structure, resolved, **kwargs)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
