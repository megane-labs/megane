"""XTC trajectory reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import FileTrajectory, open_file_trajectory, read_text

logger = logging.getLogger(__name__)


def load_trajectory(pdb_path: str, xtc_path: str, n_atoms: int | None = None) -> FileTrajectory:
    """Load a trajectory from a topology file + XTC coordinates.

    Uses the Rust XTC reader (megane-core) instead of MDAnalysis. The frames
    stay in the file: opening it reads only the frame headers, and each frame
    is decoded when it is asked for.

    Args:
        pdb_path: Path to the topology, used for atom count validation. Any
            structure format ``megane.parsers.dispatch`` reads (PDB, GRO,
            CIF, ...); an extension-less path is read as PDB. The name is
            kept for backward compatibility.
        xtc_path: Path to XTC file (trajectory).
        n_atoms: The topology's atom count when the caller has already parsed
            it; the topology is then not read again.

    Returns:
        A trajectory read from the file one frame at a time.
    """
    logger.debug("Loading XTC trajectory: %s (topology: %s)", xtc_path, pdb_path)

    topology_atoms = n_atoms if n_atoms is not None else _topology_n_atoms(pdb_path)
    trajectory = open_file_trajectory(xtc_path, "xtc")
    if trajectory.n_atoms != topology_atoms:
        raise ValueError(
            f"Atom count mismatch: topology has {topology_atoms} atoms, XTC has {trajectory.n_atoms} atoms."
        )

    logger.info(
        "Loaded XTC trajectory: %d frames, %d atoms%s",
        trajectory.n_frames,
        trajectory.n_atoms,
        " (variable cell)" if trajectory.heterogeneous else "",
    )
    return trajectory


def _topology_n_atoms(path: str) -> int:
    """Atom count of a topology file, read with the matching structure parser."""
    from megane.parsers.dispatch import load_structure_file, structure_ext

    if structure_ext(path) in ("", ".pdb"):
        return megane_parser.parse_pdb(read_text(path)).n_atoms
    return load_structure_file(path).n_atoms
