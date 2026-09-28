"""GROMACS GRO structure reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import Structure, structure_from_result

__all__ = ["load_gro"]

logger = logging.getLogger(__name__)


def load_gro(path: str) -> Structure:
    """Load a GROMACS GRO file using the shared Rust parser (megane-core).

    Args:
        path: Path to the .gro file.

    Returns:
        Parsed Structure with positions in Angstroms.
    """
    logger.debug("Loading GRO file: %s", path)
    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_gro(text)
    logger.info("Loaded GRO: %d atoms, %d bonds", result.n_atoms, len(result.bonds))

    return structure_from_result(result)
