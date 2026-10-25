"""JCAMP-DX spectrum reader backed by shared Rust megane-core via PyO3."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from megane import megane_parser
from megane.parsers.common import read_text

__all__ = ["Spectrum", "load_jcampdx"]

logger = logging.getLogger(__name__)


@dataclass
class Spectrum:
    """A decoded JCAMP-DX spectrum.

    Unlike every other megane parser this yields no atoms: a spectrum is a
    plain (x, y) trace, so there is nothing for the 3D viewer to render. It
    feeds the ``SpectrumPlot`` pipeline node instead of ``Viewport``.

    Attributes:
        title: ``##TITLE=`` value, or ``""`` when absent.
        data_type: ``##DATA TYPE=`` value, e.g. ``"INFRARED SPECTRUM"``.
        x_units: Abscissa units, e.g. ``"1/CM"``.
        y_units: Ordinate units, e.g. ``"TRANSMITTANCE"``.
        x: Abscissa values, already scaled by ``##XFACTOR=``.
        y: Ordinate values, already scaled by ``##YFACTOR=``.
    """

    title: str
    data_type: str
    x_units: str
    y_units: str
    x: NDArray[np.float64]
    y: NDArray[np.float64]

    @property
    def n_points(self) -> int:
        """Number of points in the trace."""
        return int(self.x.shape[0])


def load_jcampdx(path: str) -> Spectrum:
    """Load a JCAMP-DX spectrum file.

    Handles both the plain AFFN encoding and the compressed ASDF forms
    (SQZ / DIF / DUP), for ``##XYDATA=(X++(Y..Y))`` and ``##XYPOINTS=(XY..XY)``
    tables alike. ``##XFACTOR=`` / ``##YFACTOR=`` are applied, so the returned
    arrays are in the units named by ``x_units`` / ``y_units``.

    Args:
        path: Path to the ``.jdx`` / ``.jcamp`` file.

    Returns:
        A :class:`Spectrum`.

    Raises:
        ValueError: If the file is not JCAMP-DX or its data table is malformed.
    """
    logger.debug("Loading JCAMP-DX spectrum: %s", path)

    text = read_text(path)

    result = megane_parser.parse_jcampdx(text)

    spectrum = Spectrum(
        title=result.title,
        data_type=result.data_type,
        x_units=result.x_units,
        y_units=result.y_units,
        x=np.asarray(result.x, dtype=np.float64),
        y=np.asarray(result.y, dtype=np.float64),
    )

    logger.info(
        "Loaded JCAMP-DX: %s (%s), %d points",
        spectrum.title or "<untitled>",
        spectrum.data_type or "unknown type",
        spectrum.n_points,
    )
    return spectrum
