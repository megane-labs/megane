"""GROMACS .top / .itp topology file parser.

Thin wrapper over the Rust core (``megane_parser.parse_top_bonds_from_path``,
i.e. ``megane_core::top``), which extracts bond pairs from ``[ bonds ]`` /
``[ settles ]`` / ``[ constraints ]`` sections, honors ``[ moleculetype ]`` /
``[ molecules ]`` replication, and resolves ``#include`` directives from the
filesystem — one implementation shared with every other host.
"""

from __future__ import annotations

import numpy as np


def parse_top_bonds(path: str) -> np.ndarray:
    """Parse a GROMACS ``.top`` file and extract bond pairs.

    ``#include`` directives are resolved relative to the directory of *path*.
    Missing include files (e.g. system forcefield ``.itp`` files) are skipped
    silently.  Circular includes raise ``RecursionError``.

    Args:
        path: Path to a ``.top`` topology file.

    Returns:
        ``(M, 2)`` uint32 array of 0-indexed bond pairs.
    """
    from megane import megane_parser

    try:
        bonds = megane_parser.parse_top_bonds_from_path(path)
    except ValueError as err:
        if "Circular include" in str(err):
            raise RecursionError(str(err)) from err
        raise
    return np.asarray(bonds, dtype=np.uint32).reshape(-1, 2)
