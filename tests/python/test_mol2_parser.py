"""Tests for MOL2 (Tripos SYBYL) structure parser."""

from pathlib import Path

import numpy as np
import pytest

from megane.parsers.mol2 import load_mol2
from megane.parsers import load_mol2 as load_mol2_init

FIXTURES = Path(__file__).parent.parent / "fixtures"


def test_load_methanol_mol2():
    """Test loading methanol from a MOL2 file."""
    s = load_mol2(str(FIXTURES / "methanol.mol2"))

    assert s.n_atoms == 6
    assert s.positions.shape == (6, 3)
    assert s.positions.dtype == np.float32
    assert s.elements.dtype == np.uint8


def test_methanol_mol2_elements():
    """Methanol (CH3OH): 1 C, 1 O, 4 H."""
    s = load_mol2(str(FIXTURES / "methanol.mol2"))

    elements = s.elements.tolist()
    assert elements.count(6) == 1   # carbon
    assert elements.count(8) == 1   # oxygen
    assert elements.count(1) == 4   # hydrogen


def test_methanol_mol2_bonds():
    """Methanol has 5 bonds."""
    s = load_mol2(str(FIXTURES / "methanol.mol2"))

    assert len(s.bonds) == 5
    assert s.bonds.dtype == np.uint32
    assert s.bond_orders.dtype == np.uint8
    assert len(s.bond_orders) == len(s.bonds)


def test_methanol_mol2_bond_indices_valid():
    """All bond indices must be within atom range."""
    s = load_mol2(str(FIXTURES / "methanol.mol2"))

    assert s.bonds.max() < s.n_atoms


def test_mol2_no_box():
    """Small-molecule MOL2 files have no periodic box."""
    s = load_mol2(str(FIXTURES / "methanol.mol2"))

    assert s.box.shape == (3, 3)
    assert s.box.dtype == np.float32
    assert np.all(s.box == 0)


def test_load_mol2_exported_from_parsers():
    """load_mol2 must be importable from megane.parsers."""
    s = load_mol2_init(str(FIXTURES / "methanol.mol2"))
    assert s.n_atoms == 6


def test_load_mol2_missing_file():
    """load_mol2 raises an error for a non-existent file."""
    with pytest.raises((FileNotFoundError, OSError)):
        load_mol2("/nonexistent/missing.mol2")


# ---- CRYSIN unit cell ------------------------------------------------------


def test_mol2_crysin_standard_record_sets_box():
    """The 8-field @<TRIPOS>CRYSIN record after BOND becomes the cell matrix."""
    s = load_mol2(str(FIXTURES / "nacl_crysin.mol2"))

    assert s.n_atoms == 8
    assert len(s.bonds) == 0
    assert s.box.shape == (3, 3)
    assert s.box.dtype == np.float32
    np.testing.assert_allclose(s.box, np.diag([5.6402, 5.6402, 5.6402]), atol=1e-4)


def test_mol2_crysin_six_fields_before_atom_non_orthogonal():
    """A 6-field CRYSIN placed right after MOLECULE gives a hexagonal cell."""
    s = load_mol2(str(FIXTURES / "graphite_crysin.mol2"))

    assert s.n_atoms == 4
    assert len(s.bonds) == 2
    expected = np.array(
        [
            [2.4612, 0.0, 0.0],
            [-1.2306, 2.13146, 0.0],
            [0.0, 0.0, 6.7079],
        ],
        dtype=np.float32,
    )
    np.testing.assert_allclose(s.box, expected, atol=1e-4)


def test_mol2_crysin_degenerate_cell_is_skipped(tmp_path):
    """A placeholder zero cell must not produce a box (and must not fail)."""
    text = (FIXTURES / "nacl_crysin.mol2").read_text()
    text = text.replace(
        "    5.6402    5.6402    5.6402   90.0000   90.0000   90.0000 225 1",
        "0.0 0.0 0.0 90.0 90.0 90.0 1 1",
    )
    p = tmp_path / "zero_cell.mol2"
    p.write_text(text)

    s = load_mol2(str(p))
    assert s.n_atoms == 8
    assert np.all(s.box == 0)


def test_gaff_types_blank_name_and_charges():
    """GAFF ``ca``/``os`` are C/O (not Ca/Os); a blank name keeps the counts line."""
    from megane import megane_parser

    text = (
        "@<TRIPOS>MOLECULE\n"
        "\n"
        " 2 1 1 0 0\n"
        "SMALL\n"
        "bcc\n"
        "\n"
        "@<TRIPOS>ATOM\n"
        "      1 C1          0.0000    0.0000    0.0000 ca      1  BNZ        -0.1300\n"
        "      2 O1          1.4300    0.0000    0.0000 os      1  BNZ        -0.1000\n"
        "@<TRIPOS>BOND\n"
        "     1     1     2    1\n"
    )
    s = megane_parser.parse_mol2(text)
    assert s.elements.tolist() == [6, 8]
    [(name, frames)] = s.scalar_channels
    assert name == "charge"
    assert frames[0].tolist() == pytest.approx([-0.13, -0.1])
