"""Tests for MOL and SDF structure parsers."""

from pathlib import Path

import numpy as np
import pytest

from megane.parsers.mol import load_mol, load_sdf
from megane.parsers import load_mol as load_mol_init, load_sdf as load_sdf_init

FIXTURES = Path(__file__).parent.parent / "fixtures"


# ---------------------------------------------------------------------------
# MOL tests (methane.mol)
# ---------------------------------------------------------------------------


def test_load_methane_mol():
    """Test loading methane from a V2000 MOL file."""
    s = load_mol(str(FIXTURES / "methane.mol"))

    assert s.n_atoms == 5
    assert s.positions.shape == (5, 3)
    assert s.positions.dtype == np.float32
    assert s.elements.dtype == np.uint8


def test_methane_mol_elements():
    """Methane: 1 C (6) and 4 H (1)."""
    s = load_mol(str(FIXTURES / "methane.mol"))

    elements = s.elements.tolist()
    assert elements.count(6) == 1   # carbon
    assert elements.count(1) == 4   # hydrogen


def test_methane_mol_bonds():
    """Methane has 4 C-H single bonds."""
    s = load_mol(str(FIXTURES / "methane.mol"))

    assert len(s.bonds) == 4
    assert s.bonds.dtype == np.uint32
    assert s.bond_orders.dtype == np.uint8
    assert np.all(s.bond_orders == 1)  # all single bonds


def test_methane_mol_bond_indices_valid():
    """Bond indices must be within atom range."""
    s = load_mol(str(FIXTURES / "methane.mol"))

    assert s.bonds.max() < s.n_atoms


def test_mol_no_box():
    """MOL files have no periodic box; box matrix should be all-zero."""
    s = load_mol(str(FIXTURES / "methane.mol"))

    assert s.box.shape == (3, 3)
    assert s.box.dtype == np.float32
    assert np.all(s.box == 0)


# ---------------------------------------------------------------------------
# SDF tests (ethanol.sdf)
# ---------------------------------------------------------------------------


def test_load_ethanol_sdf():
    """Test loading ethanol from an SDF file."""
    s = load_sdf(str(FIXTURES / "ethanol.sdf"))

    assert s.n_atoms == 9
    assert s.positions.shape == (9, 3)
    assert s.positions.dtype == np.float32


def test_ethanol_sdf_elements():
    """Ethanol (C2H5OH): 2 C, 1 O, 6 H."""
    s = load_sdf(str(FIXTURES / "ethanol.sdf"))

    elements = s.elements.tolist()
    assert elements.count(6) == 2   # carbon
    assert elements.count(8) == 1   # oxygen
    assert elements.count(1) == 6   # hydrogen


def test_ethanol_sdf_bonds():
    """Ethanol has 8 bonds."""
    s = load_sdf(str(FIXTURES / "ethanol.sdf"))

    assert len(s.bonds) == 8
    assert s.bonds.dtype == np.uint32
    assert s.bond_orders.dtype == np.uint8
    assert len(s.bond_orders) == len(s.bonds)


# ---------------------------------------------------------------------------
# Import-from-package tests
# ---------------------------------------------------------------------------


def test_load_mol_exported_from_parsers():
    """load_mol must be importable from megane.parsers."""
    s = load_mol_init(str(FIXTURES / "methane.mol"))
    assert s.n_atoms == 5


def test_load_sdf_exported_from_parsers():
    """load_sdf must be importable from megane.parsers."""
    s = load_sdf_init(str(FIXTURES / "ethanol.sdf"))
    assert s.n_atoms == 9


def test_load_mol_missing_file():
    """load_mol raises an error for a non-existent file."""
    with pytest.raises((FileNotFoundError, OSError)):
        load_mol("/nonexistent/missing.mol")


def test_load_sdf_missing_file():
    """load_sdf raises an error for a non-existent file."""
    with pytest.raises((FileNotFoundError, OSError)):
        load_sdf("/nonexistent/missing.sdf")


def test_bond_to_a_missing_atom_is_skipped_with_a_warning():
    """Atom number 0 used to wrap to 4294967295 instead of being rejected."""
    from megane import megane_parser

    text = (
        "x\n  test\n\n  2  2  0  0  0  0            999 V2000\n"
        "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0\n"
        "    1.5000    0.0000    0.0000 O   0  0  0  0  0  0\n"
        "  1  2  1  0\n"
        "  0  2  1  0\n"
        "M  END\n"
    )
    s = megane_parser.parse_mol(text)
    assert s.bonds.tolist() == [[0, 1]]
    assert s.n_file_bonds == 1
    assert len(s.warnings) == 1
