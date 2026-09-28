"""MOL/SDF structure reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import Structure, structure_from_result

__all__ = ["load_mol", "load_sdf"]

logger = logging.getLogger(__name__)


def _load_mol_text(text: str) -> Structure:
    result = megane_parser.parse_mol(text)
    return structure_from_result(result)


def load_mol(path: str) -> Structure:
    """Load a MOL file using the shared Rust parser (megane-core).

    Args:
        path: Path to the .mol file.

    Returns:
        Parsed Structure with positions in Angstroms.
    """
    logger.debug("Loading MOL file: %s", path)
    with open(path) as f:
        text = f.read()

    structure = _load_mol_text(text)
    logger.info("Loaded MOL: %d atoms, %d bonds", structure.n_atoms, len(structure.bonds))
    return structure


def load_sdf(path: str) -> Structure:
    """Load the first record from an SDF file using the shared Rust parser (megane-core).

    SDF files may contain multiple records separated by ``$$$$``; only the
    first record is loaded.

    Args:
        path: Path to the .sdf file.

    Returns:
        Parsed Structure with positions in Angstroms.
    """
    logger.debug("Loading SDF file: %s", path)
    with open(path) as f:
        text = f.read()

    structure = _load_mol_text(text)
    logger.info("Loaded SDF: %d atoms, %d bonds", structure.n_atoms, len(structure.bonds))
    return structure
