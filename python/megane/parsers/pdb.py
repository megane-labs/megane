"""PDB file parser backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging

import numpy as np

from megane import megane_parser
from megane.parsers.common import Structure, structure_from_result

logger = logging.getLogger(__name__)

# Bond order encoding: matches frontend constants
BOND_SINGLE = 1
BOND_DOUBLE = 2
BOND_TRIPLE = 3
BOND_AROMATIC = 4


def cell_params_to_matrix(
    a: float,
    b: float,
    c: float,
    alpha: float,
    beta: float,
    gamma: float,
) -> np.ndarray:
    """Convert crystallographic cell parameters to a 3x3 matrix of cell vectors.

    Args:
        a, b, c: Cell edge lengths in Angstroms.
        alpha, beta, gamma: Cell angles in degrees.

    Returns:
        (3, 3) float32 array with cell vectors as rows.
    """
    alpha_r = np.radians(alpha)
    beta_r = np.radians(beta)
    gamma_r = np.radians(gamma)

    cos_a, cos_b, cos_g = np.cos(alpha_r), np.cos(beta_r), np.cos(gamma_r)
    sin_g = np.sin(gamma_r)

    va = np.array([a, 0.0, 0.0])
    vb = np.array([b * cos_g, b * sin_g, 0.0])

    cx = c * cos_b
    cy = c * (cos_a - cos_b * cos_g) / sin_g
    cz = np.sqrt(max(0.0, c * c - cx * cx - cy * cy))
    vc = np.array([cx, cy, cz])

    return np.array([va, vb, vc], dtype=np.float32)


def load_pdb(path: str) -> Structure:
    """Load a PDB file using the shared Rust parser (megane-core).

    Replaces the previous RDKit-based implementation for dramatically
    faster parsing. The same Rust code is used by the WASM frontend.
    """
    logger.debug("Loading PDB file: %s", path)
    with open(path) as f:
        text = f.read()

    result = megane_parser.parse_pdb(text)
    logger.info("Loaded PDB: %d atoms, %d bonds", result.n_atoms, len(result.bonds))

    return structure_from_result(result)
