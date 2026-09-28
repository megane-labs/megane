"""Molden file reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_molden", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_molden(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a Molden file as structure + trajectory.

    Reads the ``[Atoms]`` block, honouring its mandatory ``(AU)`` / ``(Angs)``
    unit argument — getting that wrong is a 1.889x coordinate error. A
    ``[GEOMETRIES] XYZ`` block (a geometry optimisation) becomes a multi-frame
    structure; a file with only ``[Atoms]`` is returned as one frame.

    ``[GTO]`` / ``[MO]`` orbitals and ``[FREQ]`` normal modes are skipped, as
    are any vendor-specific sections — the parser never fails on a block it
    does not recognise.

    Args:
        path: Path to the ``.molden`` file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading Molden structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_molden(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded Molden: %d frames, %d atoms", trajectory.n_frames, n_atoms)
    return structure, trajectory
