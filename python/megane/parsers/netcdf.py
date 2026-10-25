"""AMBER NetCDF trajectory reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane.parsers.common import FileTrajectory, open_file_trajectory

__all__ = ["load_netcdf"]

logger = logging.getLogger(__name__)


def load_netcdf(path: str) -> FileTrajectory:
    """Load an AMBER NetCDF trajectory file (.nc).

    NetCDF files contain only coordinate frames — topology (elements, bonds)
    must be supplied separately (e.g. via a PDB or AMBER prmtop file). Use
    the ``LoadStructure`` + ``LoadTrajectory`` pipeline pair to combine them.

    Args:
        path: Path to .nc file.

    Returns:
        A trajectory read from the file one frame at a time.
    """
    logger.debug("Loading AMBER NetCDF trajectory: %s", path)

    trajectory = open_file_trajectory(path, "netcdf")

    logger.info(
        "Loaded AMBER NetCDF trajectory: %d frames, %d atoms%s",
        trajectory.n_frames,
        trajectory.n_atoms,
        " (variable cell)" if trajectory.heterogeneous else "",
    )
    return trajectory
