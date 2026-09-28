"""Chemical Markup Language (.cml) reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_cml", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_cml(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a CML file as structure + trajectory.

    Reads the first ``<molecule>`` that carries atoms. Coordinates may be
    Cartesian (``x3``/``y3``/``z3`` or a packed ``xyz3``), fractional
    (``xFract``/``yFract``/``zFract``, converted with the ``<crystal>`` cell),
    or a 2D depiction (``x2``/``y2``, projected onto z = 0). An explicit
    ``<bondArray>`` supplies connectivity; without one, bonds are inferred by
    distance. CML is single-frame, so the trajectory has one frame.

    Args:
        path: Path to the ``.cml`` file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading CML structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_cml(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded CML: %d atoms, %d bonds", n_atoms, len(structure.bonds))
    return structure, trajectory
