"""XTC trajectory reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, trajectory_from_traj_result

logger = logging.getLogger(__name__)


def load_trajectory(pdb_path: str, xtc_path: str) -> InMemoryTrajectory:
    """Load a trajectory from a topology file + XTC coordinates.

    Uses the Rust XTC parser (megane-core) instead of MDAnalysis.

    Args:
        pdb_path: Path to the topology, used for atom count validation. Any
            structure format ``megane.parsers.dispatch`` reads (PDB, GRO,
            CIF, ...); an extension-less path is read as PDB. The name is
            kept for backward compatibility.
        xtc_path: Path to XTC file (trajectory).

    Returns:
        InMemoryTrajectory with frame-by-frame access.
    """
    logger.debug("Loading XTC trajectory: %s (topology: %s)", xtc_path, pdb_path)

    topology_atoms = _topology_n_atoms(pdb_path)

    # Parse XTC binary
    with open(xtc_path, "rb") as f:
        xtc_bytes = f.read()
    result = megane_parser.parse_xtc(xtc_bytes)

    n_atoms = result.n_atoms
    if n_atoms != topology_atoms:
        raise ValueError(f"Atom count mismatch: topology has {topology_atoms} atoms, XTC has {n_atoms} atoms.")

    trajectory = trajectory_from_traj_result(result)
    logger.info(
        "Loaded XTC trajectory: %d frames, %d atoms%s",
        trajectory.n_frames,
        n_atoms,
        " (variable cell)" if trajectory.heterogeneous else "",
    )
    return trajectory


def _topology_n_atoms(path: str) -> int:
    """Atom count of a topology file, read with the matching structure parser."""
    from megane.parsers.dispatch import load_structure_file, structure_ext

    if structure_ext(path) in ("", ".pdb"):
        with open(path) as f:
            return megane_parser.parse_pdb(f.read()).n_atoms
    return load_structure_file(path).n_atoms
