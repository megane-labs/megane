"""ASE .traj file reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_traj", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_traj(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load an ASE .traj file as structure + trajectory.

    Uses the Rust .traj parser (megane-core) instead of ASE.
    The first frame defines the topology (elements, bonds). All frames
    are read into memory.

    Args:
        path: Path to .traj file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading ASE .traj file: %s", path)

    with open(path, "rb") as f:
        data = f.read()

    result = megane_parser.parse_traj(data)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    if trajectory.heterogeneous:
        counts = [f.shape[0] for f in (trajectory.frames_list or [])]
        logger.info(
            "Loaded heterogeneous .traj: %d frames, %d..%d atoms",
            trajectory.n_frames,
            min(counts),
            max(counts),
        )
    else:
        logger.info(
            "Loaded .traj: %d frames, %d atoms, %d bonds",
            trajectory.n_frames,
            n_atoms,
            len(structure.bonds),
        )
    return structure, trajectory
