"""Wavefunction Odyssey (.xodydata / .odydata) reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

from megane import megane_parser
from megane.parsers.common import InMemoryTrajectory, Structure, structure_and_trajectory_from_result

__all__ = ["load_odydata", "InMemoryTrajectory"]

logger = logging.getLogger(__name__)


def load_odydata(path: str) -> tuple[Structure, InMemoryTrajectory]:
    """Load a Wavefunction Odyssey file as structure + trajectory.

    Odyssey writes two unrelated layouts under two extensions and both are
    read here, chosen from the file content rather than its name:

    * ``.xodydata`` -- the modern XML default, rooted at
      ``<odyssey_simulation>``. ``<atom>`` elements carry ``element`` and
      ``xyz``, ``<bond>`` elements carry ``a`` / ``b`` / ``order``, and
      ``<boundary box="x y z"/>`` declares an orthorhombic periodic cell.
    * ``.odydata`` -- the older text layout shared with Spartan's archive
      input section (``ENDCART`` / ``ATOMLABELS`` / ``HESSIAN`` ...
      ``ENDHESS``).

    Bond orders are spelled ``s`` / ``d`` / ``t`` / ``a`` or as an integer;
    aromatic collapses to 1 for display, matching the ``.mol2`` reader. When a
    file declares no bonds at all, connectivity is inferred from distances.

    Wavefunction-based surfaces (orbitals, densities, electrostatic
    potentials) are not stored by Odyssey in these files and so are not read.

    Args:
        path: Path to the ``.xodydata`` or ``.odydata`` file.

    Returns:
        Tuple of (Structure, InMemoryTrajectory).
    """
    logger.debug("Loading Odyssey structure: %s", path)

    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_odydata(text)

    structure, trajectory = structure_and_trajectory_from_result(result)
    n_atoms = structure.n_atoms

    logger.info("Loaded Odyssey: %d atoms, %d bonds", n_atoms, len(structure.bonds))
    return structure, trajectory
