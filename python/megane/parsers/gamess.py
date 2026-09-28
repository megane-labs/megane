"""GAMESS (US / Firefly) output reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_gamess", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_gamess(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a GAMESS output file as structure + trajectory.

    Every ``COORDINATES OF ALL ATOMS ARE`` block becomes a frame, so a geometry
    optimisation can be scrubbed exactly like a multi-frame XYZ; the terminal
    ``EQUILIBRIUM GEOMETRY LOCATED`` block is simply the last one. The banner's
    ``(ANGS)`` / ``(BOHR)`` argument is honoured. Bonds are inferred by distance
    -- GAMESS output carries no connectivity.

    Only the ``.gamess`` extension is registered with the host viewers: GAMESS
    logs are normally named ``.log`` / ``.out``, and claiming those globally
    would hijack every log file in a workspace.

    Args:
        path: Path to the GAMESS output file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading GAMESS output: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_gamess(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded GAMESS: %d frames, %d atoms", trajectory.n_frames, n_atoms)
    return structure, trajectory
