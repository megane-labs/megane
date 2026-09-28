"""Multi-frame XYZ trajectory reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_xyz_trajectory", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_xyz_trajectory(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a multi-frame XYZ file as structure + trajectory.

    Uses the Rust XYZ parser (megane-core). The first frame defines the
    topology (elements). All frames are read into memory. Single-frame
    XYZ files are returned as a 1-frame trajectory.

    Args:
        path: Path to XYZ file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading XYZ trajectory: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_xyz(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    if trajectory.heterogeneous:
        counts = [f.shape[0] for f in (trajectory.frames_list or [])]
        logger.info(
            "Loaded heterogeneous XYZ: %d frames, %d..%d atoms",
            trajectory.n_frames,
            min(counts),
            max(counts),
        )
    else:
        logger.info("Loaded XYZ: %d frames, %d atoms", trajectory.n_frames, n_atoms)
    return structure, trajectory
