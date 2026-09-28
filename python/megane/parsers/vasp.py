"""VASP POSCAR / CONTCAR / XDATCAR reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_vasp", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_vasp(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a VASP structure file as structure + trajectory.

    Handles POSCAR / CONTCAR (single frame) and XDATCAR (one frame per
    ``Direct configuration=`` block), including variable-cell runs that
    re-emit the whole header before each configuration. A POSCAR is returned
    as a 1-frame trajectory, exactly like a single-frame XYZ.

    The filename is irrelevant — VASP's extensionless names (``POSCAR``,
    ``CONTCAR``, ``XDATCAR``) and the ``.vasp`` extension all route here.

    Args:
        path: Path to the VASP structure file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading VASP structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_vasp(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded VASP: %d frames, %d atoms", trajectory.n_frames, n_atoms)
    return structure, trajectory
