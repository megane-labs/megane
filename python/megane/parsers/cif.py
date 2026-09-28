"""CIF file parser backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import Structure, structure_from_result

logger = logging.getLogger(__name__)


def load_cif(path: str) -> Structure:
    """Load a CIF file using the shared Rust parser (megane-core).

    Args:
        path: Path to .cif file.

    Returns:
        Parsed molecular structure.
    """
    logger.debug("Loading CIF file: %s", path)
    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_cif(text)
    logger.info("Loaded CIF: %d atoms, %d bonds", result.n_atoms, len(result.bonds))

    return structure_from_result(result)
