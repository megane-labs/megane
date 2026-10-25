"""LAMMPS data file parser backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import Structure, read_text, structure_from_result

logger = logging.getLogger(__name__)


def load_lammps_data(path: str) -> Structure:
    """Load a LAMMPS data file using the shared Rust parser (megane-core).

    Supports atom_style: atomic, charge, and full (real).
    Auto-detects style from comment hint or field count.
    """
    logger.debug("Loading LAMMPS data file: %s", path)
    text = read_text(path)

    result = megane_parser.parse_lammps_data(text)
    logger.info("Loaded LAMMPS data: %d atoms, %d bonds", result.n_atoms, len(result.bonds))

    return structure_from_result(result)
