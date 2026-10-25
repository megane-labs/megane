"""DCD trajectory reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane.parsers.common import FileTrajectory, open_file_trajectory

__all__ = ["load_dcd"]

logger = logging.getLogger(__name__)


def load_dcd(path: str) -> FileTrajectory:
    """Load a DCD trajectory file (CHARMM/NAMD/X-PLOR format).

    DCD files contain only coordinate frames — topology (elements, bonds)
    must be supplied separately (e.g. via a PSF or PDB file). Use the
    ``LoadStructure`` + ``LoadTrajectory`` pipeline pair to combine them.

    Args:
        path: Path to .dcd file.

    Returns:
        A trajectory read from the file one frame at a time.
    """
    logger.debug("Loading DCD trajectory: %s", path)

    trajectory = open_file_trajectory(path, "dcd")

    logger.info(
        "Loaded DCD trajectory: %d frames, %d atoms%s",
        trajectory.n_frames,
        trajectory.n_atoms,
        " (variable cell)" if trajectory.heterogeneous else "",
    )
    return trajectory
