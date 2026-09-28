"""MOL2 structure reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import Structure, structure_from_result

__all__ = ["load_mol2"]

logger = logging.getLogger(__name__)


def load_mol2(path: str) -> Structure:
    """Load a MOL2 (Tripos SYBYL) file using the shared Rust parser (megane-core).

    Args:
        path: Path to the .mol2 file.

    Returns:
        Parsed Structure with positions in Angstroms.
    """
    logger.debug("Loading MOL2 file: %s", path)
    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_mol2(text)
    logger.info("Loaded MOL2: %d atoms, %d bonds", result.n_atoms, len(result.bonds))

    return structure_from_result(result)
