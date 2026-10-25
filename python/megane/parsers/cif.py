"""CIF file parser backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import Structure, read_text, structure_from_result

logger = logging.getLogger(__name__)


def load_cif(path: str) -> Structure:
    """Load a CIF file using the shared Rust parser (megane-core).

    Args:
        path: Path to .cif file.

    Returns:
        Parsed molecular structure.
    """
    logger.debug("Loading CIF file: %s", path)
    text = read_text(path)

    result = megane_parser.parse_cif(text)
    logger.info("Loaded CIF: %d atoms, %d bonds", result.n_atoms, len(result.bonds))

    return structure_from_result(result)
