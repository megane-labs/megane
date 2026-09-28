"""CASTEP NMR magres reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_magres", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_magres(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a new-style (``#$magres-abinitio-v1.0``) magres file.

    Reads the ``[atoms]`` block: the ``lattice`` line becomes the unit cell and
    each ``atom`` line an atom, honouring the per-block ``units`` declarations
    independently (Angstrom or bohr) rather than assuming Angstrom.

    The ``ms`` / ``efg`` / ``isc`` tensors in ``[magres]`` are 3x3 per-atom
    quantities with no home in the current renderer, so they are skipped; a
    per-atom scalar channel for them is a follow-up.

    Old-style (pre-2010) magres output is a different, free-form grammar and is
    rejected with a clear message rather than misparsed.

    Args:
        path: Path to the ``.magres`` file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading magres structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_magres(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded magres: %d atoms", n_atoms)
    return structure, trajectory
