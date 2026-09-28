"""LAMMPS dump trajectory (.lammpstrj) reader backed by shared Rust megane-core."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import (
    InMemoryTrajectory,
    Structure,
    structure_and_trajectory_from_result,
    trajectory_from_traj_result,
)

__all__ = ["load_lammpstrj", "load_lammpstrj_structure", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_lammpstrj(dump_path: str) -> InMemoryTrajectory:
    """Load a LAMMPS dump trajectory file.

    Uses the shared Rust LAMMPS-dump parser (megane-core) so behavior matches the
    WASM frontend, including support for *heterogeneous* dumps whose atom count,
    box, or atom type varies between frames (GCMC / deposition runs).

    Args:
        dump_path: Path to .lammpstrj / .dump file.

    Returns:
        InMemoryTrajectory with frame-by-frame access.
    """
    logger.debug("Loading LAMMPS dump file: %s", dump_path)
    with open(dump_path) as f:
        text = f.read()

    result = megane_parser.parse_lammpstrj(text)
    trajectory = trajectory_from_traj_result(result)

    if trajectory.heterogeneous:
        counts = [f.shape[0] for f in (trajectory.frames_list or [])]
        logger.info(
            "Loaded heterogeneous LAMMPS dump: %d frames, %d..%d atoms",
            trajectory.n_frames,
            min(counts),
            max(counts),
        )
    else:
        logger.info(
            "Loaded LAMMPS dump: %d frames, %d atoms",
            trajectory.n_frames,
            trajectory.n_atoms,
        )
    return trajectory


def load_lammpstrj_structure(dump_path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a LAMMPS dump standalone as a structure + trajectory.

    Unlike :func:`load_lammpstrj` (which returns only a trajectory to attach onto
    a separately-loaded topology), this derives the topology from frame 0 so the
    dump can be opened on its own, exactly like a multi-frame XYZ or ASE ``.traj``.

    A dump carries no element symbols or masses, so the integer per-atom ``type``
    id is used as the atomic-number proxy (element identities are therefore
    placeholder colours/sizes, not true chemistry); a dump without a ``type``
    column falls back to element 0. Bonds are inferred by distance from frame 0.

    Args:
        dump_path: Path to .lammpstrj / .dump / .trj file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading LAMMPS dump as structure: %s", dump_path)
    with open(dump_path) as f:
        text = f.read()

    result = megane_parser.parse_lammpstrj_structure(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    if trajectory.heterogeneous:
        counts = [f.shape[0] for f in (trajectory.frames_list or [])]
        logger.info(
            "Loaded heterogeneous LAMMPS dump as structure: %d frames, %d..%d atoms",
            trajectory.n_frames,
            min(counts),
            max(counts),
        )
    else:
        logger.info(
            "Loaded LAMMPS dump as structure: %d frames, %d atoms",
            trajectory.n_frames,
            n_atoms,
        )
    return structure, trajectory
