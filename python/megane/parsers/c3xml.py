"""Chem3D XML (.c3xml) reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_c3xml", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_c3xml(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a Chem3D XML file as structure + trajectory.

    Reads ``<n>`` (node) elements for their ``Element`` and ``Position``, and
    ``<b>`` (bond) elements for explicit connectivity and bond orders, so no
    distance inference is needed for genuine 3D input. The long spellings
    (``<node>`` / ``<bond>`` with ``Begin`` / ``End``) some exports use are
    accepted too, and ``Element`` may be an atomic number or a symbol.

    A 2D-only drawing (``p="x y"`` instead of ``Position``) is projected onto
    z = 0 so the file still opens -- visibly flat, which is the honest
    rendering of flat input -- and bonds are *not* inferred for it, since
    projected 2D distances are meaningless.

    The binary ``.cdx`` and general ``.cdxml`` variants are out of scope.

    Args:
        path: Path to the ``.c3xml`` file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading Chem3D XML structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_c3xml(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded Chem3D XML: %d atoms, %d bonds", n_atoms, len(structure.bonds))
    return structure, trajectory
