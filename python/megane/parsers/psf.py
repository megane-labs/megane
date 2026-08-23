"""CHARMM/NAMD PSF topology file parser.

Thin wrapper over the Rust core (``megane_parser.parse_psf_bonds``, i.e.
``megane_core::psf``), which extracts bond pairs from the ``!NBOND`` section —
one implementation shared with every other host.  PSF files carry no
coordinate data; use together with a DCD or XTC trajectory to get positions.
"""

from __future__ import annotations

import numpy as np


def parse_psf_bonds(path: str) -> np.ndarray:
    """Parse a CHARMM/NAMD PSF topology file and extract bond pairs.

    Args:
        path: Path to a ``.psf`` topology file.

    Returns:
        ``(M, 2)`` uint32 array of 0-indexed bond pairs.
    """
    from megane import megane_parser

    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read()

    bonds = megane_parser.parse_psf_bonds(text)
    return np.asarray(bonds, dtype=np.uint32).reshape(-1, 2)
