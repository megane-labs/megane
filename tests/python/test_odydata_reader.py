"""Tests for the Wavefunction Odyssey (.xodydata / .odydata) reader."""

from pathlib import Path

import numpy as np
import pytest

from megane import megane_parser
from megane.parsers.odydata import InMemoryTrajectory, load_odydata

FIXTURES = Path(__file__).parent.parent / "fixtures"


def test_load_the_xml_flavour_with_explicit_bonds():
    structure, trajectory = load_odydata(str(FIXTURES / "ethanol.xodydata"))

    assert structure.n_atoms == 9
    # C, C, O then six hydrogens.
    assert structure.elements.tolist() == [6, 6, 8, 1, 1, 1, 1, 1, 1]
    # All eight bonds come from the <bond> elements, none inferred.
    assert structure.bonds.shape == (8, 2)
    assert structure.bond_orders.tolist() == [1] * 8
    assert structure.positions[2] == pytest.approx([-1.1867, -0.2472, 0.0], abs=1e-4)

    assert isinstance(trajectory, InMemoryTrajectory)
    assert trajectory.n_frames == 1


def test_the_two_flavours_describe_the_same_molecule():
    """One parser reads both layouts, so they must agree on the result."""
    xml, _ = load_odydata(str(FIXTURES / "ethanol.xodydata"))
    text, _ = load_odydata(str(FIXTURES / "ethanol.odydata"))

    assert xml.n_atoms == text.n_atoms
    assert xml.elements.tolist() == text.elements.tolist()
    assert xml.bonds.tolist() == text.bonds.tolist()
    assert np.allclose(xml.positions, text.positions, atol=1e-4)


def test_letter_bond_orders_are_decoded():
    result = megane_parser.parse_odydata(
        "<odyssey_simulation><structure>"
        '<atom id="1" element="C" xyz="0 0 0"/>'
        '<atom id="2" element="C" xyz="1.2 0 0"/>'
        '<atom id="3" element="N" xyz="2.4 0 0"/>'
        '<bond a="1" b="2" order="d"/>'
        '<bond a="2" b="3" order="t"/>'
        "</structure></odyssey_simulation>"
    )
    assert result.bond_orders.tolist() == [2, 3]


def test_a_boundary_box_becomes_a_periodic_cell():
    """Odyssey coordinates are box-centred; the file's values come back
    verbatim and the cell is anchored via box_origin instead of shifting
    atoms."""
    result = megane_parser.parse_odydata(
        "<odyssey_simulation>"
        '<structure><atom id="1" element="Ar" xyz="0 0 0"/></structure>'
        '<boundary box="20.0 20.0 20.0"/>'
        "</odyssey_simulation>"
    )
    assert result.positions[0] == pytest.approx([0.0, 0.0, 0.0], abs=1e-4)
    assert np.asarray(result.box_matrix).reshape(3, 3)[0][0] == pytest.approx(20.0, abs=1e-4)
    assert np.asarray(result.box_origin) == pytest.approx([-10.0, -10.0, -10.0], abs=1e-4)


def test_bonds_are_inferred_when_the_file_declares_none():
    result = megane_parser.parse_odydata(
        "<odyssey_simulation><structure>"
        '<atom id="1" element="O" xyz="0.000 0.000 0.117"/>'
        '<atom id="2" element="H" xyz="0.000 0.757 -0.469"/>'
        '<atom id="3" element="H" xyz="0.000 -0.757 -0.469"/>'
        "</structure></odyssey_simulation>"
    )
    assert result.bonds.shape == (2, 2)


def test_rejects_a_document_that_is_not_an_odyssey_file():
    with pytest.raises(ValueError, match="not an Odyssey file"):
        megane_parser.parse_odydata("<html><body/></html>")


def test_rejects_a_text_file_with_no_charge_line():
    with pytest.raises(ValueError, match="not an Odyssey file"):
        megane_parser.parse_odydata("C only comments\nC nothing else\n")
