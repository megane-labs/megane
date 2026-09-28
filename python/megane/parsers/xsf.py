"""XCrySDen structure file reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_xsf", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_xsf(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load an XCrySDen ``.xsf`` / ``.axsf`` file as structure + trajectory.

    Handles the ``CRYSTAL`` / ``SLAB`` / ``POLYMER`` / ``MOLECULE`` / ``ATOMS``
    dimensionality keywords, ``PRIMVEC`` lattice vectors, and ``PRIMCOORD``
    atom blocks. An ``ANIMSTEPS`` file (``.axsf``) becomes a multi-frame
    structure, with per-frame cells when the animation is variable-cell.
    A static file is returned as a 1-frame trajectory.

    ``CONVVEC`` is consumed and discarded (``PRIMVEC`` is the cell megane
    draws), and ``BEGIN_BLOCK_DATAGRID_*`` volumetric blocks are skipped.

    Args:
        path: Path to the ``.xsf`` / ``.axsf`` file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading XSF structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_xsf(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded XSF: %d frames, %d atoms", trajectory.n_frames, n_atoms)
    return structure, trajectory
