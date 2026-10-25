"""Tests for the DCD trajectory PyO3 parser (megane_parser.parse_dcd)."""

from pathlib import Path

import numpy as np
import pytest

from megane import megane_parser

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def test_parse_dcd_water_fixture():
    """parse_dcd handles the canonical water.dcd fixture (3 atoms, 5 frames)."""
    with open(FIXTURES / "water.dcd", "rb") as f:
        data = f.read()

    result = megane_parser.parse_dcd(data)

    assert result.n_atoms == 3
    assert result.n_frames == 5

    # frame_positions is shape (n_frames, n_atoms * 3)
    frames = np.asarray(result.frame_positions, dtype=np.float32)
    assert frames.shape == (5, 9)

    # Frame 0: atom0 at origin, atom1 at (0.96, 0, 0), atom2 at (0, 0.96, 0)
    np.testing.assert_allclose(frames[0, 0:3], [0.0, 0.0, 0.0], atol=1e-4)
    np.testing.assert_allclose(frames[0, 3:6], [0.96, 0.0, 0.0], atol=1e-4)
    np.testing.assert_allclose(frames[0, 6:9], [0.0, 0.96, 0.0], atol=1e-4)


def test_parse_dcd_box_matrix():
    """parse_dcd reports the orthorhombic 10 Å box on the diagonal."""
    with open(FIXTURES / "water.dcd", "rb") as f:
        data = f.read()

    result = megane_parser.parse_dcd(data)
    box = np.asarray(result.box_matrix, dtype=np.float32)

    assert box.shape == (3, 3)
    np.testing.assert_allclose(box[0, 0], 10.0, atol=1e-3)
    np.testing.assert_allclose(box[1, 1], 10.0, atol=1e-3)
    np.testing.assert_allclose(box[2, 2], 10.0, atol=1e-3)


def test_parse_dcd_timestep_positive():
    """DELTA × NSAVC is converted from AKMA to picoseconds."""
    with open(FIXTURES / "water.dcd", "rb") as f:
        data = f.read()

    result = megane_parser.parse_dcd(data)

    assert result.timestep_ps > 0


def test_parse_dcd_rejects_bad_magic():
    """parse_dcd raises ValueError on bytes that aren't a Fortran 84-byte header."""
    with pytest.raises(ValueError):
        megane_parser.parse_dcd(b"\x00\x01\x02\x03not a dcd file")


def test_parse_dcd_rejects_empty_input():
    """parse_dcd raises on empty input rather than panicking."""
    with pytest.raises(ValueError):
        megane_parser.parse_dcd(b"")


def test_parse_dcd_reports_a_dropped_incomplete_last_frame():
    """A DCD cut inside its last frame keeps the whole frames and says so."""
    data = (FIXTURES / "water.dcd").read_bytes()

    assert megane_parser.parse_dcd(data).warnings == []

    # 60 bytes short: the last frame keeps its cell record but loses X, Y, Z.
    result = megane_parser.parse_dcd(data[:-60])

    assert result.n_frames == 4
    assert len(result.warnings) == 1
    assert result.warnings[0].startswith("DCD: frame 5 is incomplete")
