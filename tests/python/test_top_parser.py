"""Tests for the GROMACS .top topology parser.

The parser is a thin wrapper over the Rust core, so everything is tested
through the public :func:`parse_top_bonds` path-based API.
"""

from pathlib import Path

import numpy as np
import pytest

from megane.parsers.top import parse_top_bonds

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _parse_text(tmp_path, text: str) -> np.ndarray:
    f = tmp_path / "case.top"
    f.write_text(text)
    return parse_top_bonds(str(f))


class TestIncludeDirectiveForms:
    def test_double_quote(self, tmp_path):
        (tmp_path / "molecule.itp").write_text("[ bonds ]\n1 2 1\n")
        assert _parse_text(tmp_path, '#include "molecule.itp"\n').shape == (1, 2)

    def test_angle_bracket(self, tmp_path):
        (tmp_path / "forcefield.itp").write_text("[ bonds ]\n1 2 1\n")
        assert _parse_text(tmp_path, "#include <forcefield.itp>\n").shape == (1, 2)

    def test_leading_whitespace(self, tmp_path):
        (tmp_path / "ions.itp").write_text("[ bonds ]\n1 2 1\n")
        assert _parse_text(tmp_path, '  #include "ions.itp"\n').shape == (1, 2)

    def test_unclosed_quote_is_not_an_include(self, tmp_path):
        # A malformed include line is treated as plain text, not a directive.
        bonds = _parse_text(tmp_path, '#include "unclosed\n[ bonds ]\n1 2 1\n')
        assert bonds.shape == (1, 2)


class TestBondSectionParsing:
    def test_basic(self, tmp_path):
        bonds = _parse_text(tmp_path, "[ bonds ]\n1 2 1\n2 3 1\n")
        np.testing.assert_array_equal(bonds, [[0, 1], [1, 2]])

    def test_inline_comment_stripped(self, tmp_path):
        bonds = _parse_text(tmp_path, "[ bonds ]\n1 2 1 ; comment\n")
        np.testing.assert_array_equal(bonds, [[0, 1]])

    def test_stops_at_next_section(self, tmp_path):
        bonds = _parse_text(tmp_path, "[ bonds ]\n1 2 1\n[ angles ]\n1 2 3 1\n")
        np.testing.assert_array_equal(bonds, [[0, 1]])


class TestMoleculeReplication:
    """Bonds inside [ moleculetype ] blocks must be replicated per [ molecules ]."""

    def test_multiple_copies_of_one_molecule(self, tmp_path):
        text = """
[ moleculetype ]
SOL  2

[ atoms ]
     1  OW   1  SOL  OW   1   0.0   16.00
     2  HW1  1  SOL  HW1  2   0.0    1.01
     3  HW2  1  SOL  HW2  3   0.0    1.01

[ bonds ]
     1     2     1
     1     3     1

[ molecules ]
SOL  4
"""
        bonds = _parse_text(tmp_path, text)
        np.testing.assert_array_equal(
            bonds,
            [[0, 1], [0, 2], [3, 4], [3, 5], [6, 7], [6, 8], [9, 10], [9, 11]],
        )

    def test_multiple_molecule_types_offset_correctly(self, tmp_path):
        text = """
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01
     2  CA   1  ALA  CA   2   0.0   12.01
     3  C    1  ALA  C    3   0.6   12.01
     4  O    1  ALA  O    4  -0.5   16.00
     5  CB   1  ALA  CB   5  -0.1   12.01

[ bonds ]
     1     2     1
     2     3     1
     3     4     1
     2     5     1

[ moleculetype ]
SOL  2

[ atoms ]
     1  OW   1  SOL  OW   1   0.0   16.00
     2  HW1  1  SOL  HW1  2   0.0    1.01
     3  HW2  1  SOL  HW2  3   0.0    1.01

[ bonds ]
     1     2     1
     1     3     1

[ molecules ]
protein  1
SOL      2
"""
        bonds = _parse_text(tmp_path, text)
        np.testing.assert_array_equal(
            bonds,
            [[0, 1], [1, 2], [2, 3], [1, 4], [5, 6], [5, 7], [8, 9], [8, 10]],
        )

    def test_default_order_without_molecules_section(self, tmp_path):
        text = """
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01
     2  CA   1  ALA  CA   2   0.0   12.01

[ bonds ]
     1     2     1
"""
        np.testing.assert_array_equal(_parse_text(tmp_path, text), [[0, 1]])

    def test_unresolved_molecule_type_stops_replication(self, tmp_path):
        text = """
[ moleculetype ]
protein  3

[ atoms ]
     1  N    1  ALA  N    1  -0.3   14.01
     2  CA   1  ALA  CA   2   0.0   12.01

[ bonds ]
     1     2     1

[ molecules ]
protein  1
SOL      10
"""
        np.testing.assert_array_equal(_parse_text(tmp_path, text), [[0, 1]])

    def test_n_atoms_inferred_without_atoms_section(self, tmp_path):
        text = """
[ moleculetype ]
SOL  2

[ bonds ]
     1     2     1
     1     3     1

[ molecules ]
SOL  2
"""
        np.testing.assert_array_equal(
            _parse_text(tmp_path, text), [[0, 1], [0, 2], [3, 4], [3, 5]]
        )


class TestParseTopBonds:
    """parse_top_bonds extracts bond pairs correctly."""

    def test_basic_parsing(self):
        bonds = parse_top_bonds(str(FIXTURES / "test_topology.top"))
        assert bonds.shape == (4, 2)
        assert bonds.dtype == np.uint32

    def test_zero_indexed(self):
        bonds = parse_top_bonds(str(FIXTURES / "test_topology.top"))
        expected = np.array([[0, 1], [1, 2], [2, 3], [1, 4]], dtype=np.uint32)
        np.testing.assert_array_equal(bonds, expected)

    def test_empty_file(self, tmp_path):
        empty = tmp_path / "empty.top"
        empty.write_text("")
        bonds = parse_top_bonds(str(empty))
        assert bonds.shape == (0, 2)

    def test_no_bonds_section(self, tmp_path):
        f = tmp_path / "no_bonds.top"
        f.write_text("[ atoms ]\n1  N  1  ALA  N  1  -0.3  14.01\n")
        bonds = parse_top_bonds(str(f))
        assert bonds.shape == (0, 2)

    def test_inline_comments_stripped(self, tmp_path):
        f = tmp_path / "inline.top"
        f.write_text("[ bonds ]\n1 2 1 ; comment\n3 4 1 ; another\n")
        bonds = parse_top_bonds(str(f))
        assert len(bonds) == 2

    def test_stops_at_next_section(self, tmp_path):
        f = tmp_path / "sections.top"
        f.write_text("[ bonds ]\n1 2 1\n[ angles ]\n1 2 3 1\n")
        bonds = parse_top_bonds(str(f))
        assert len(bonds) == 1

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(ValueError, match="Cannot read"):
            parse_top_bonds(str(tmp_path / "does_not_exist.top"))

    # ── include resolution ────────────────────────────────────────────────────

    def test_resolves_itp_include(self, tmp_path):
        (tmp_path / "mol.itp").write_text("[ bonds ]\n1 2 1\n2 3 1\n")
        top = tmp_path / "system.top"
        top.write_text('#include "mol.itp"\n')
        bonds = parse_top_bonds(str(top))
        assert bonds.shape == (2, 2)
        np.testing.assert_array_equal(bonds[0], [0, 1])
        np.testing.assert_array_equal(bonds[1], [1, 2])

    def test_resolves_nested_includes(self):
        bonds = parse_top_bonds(str(FIXTURES / "test_with_includes.top"))
        # test_with_includes.top -> test_nested.itp -> test_bonds.itp (4 bonds)
        assert bonds.shape == (4, 2)
        np.testing.assert_array_equal(bonds[0], [0, 1])

    def test_missing_system_include_skipped(self, tmp_path):
        (tmp_path / "mol.itp").write_text("[ bonds ]\n1 2 1\n")
        top = tmp_path / "system.top"
        top.write_text("#include <forcefield.itp>\n#include \"mol.itp\"\n")
        bonds = parse_top_bonds(str(top))
        assert bonds.shape == (1, 2)

    def test_circular_include_raises(self, tmp_path):
        (tmp_path / "a.itp").write_text('#include "b.itp"')
        (tmp_path / "b.itp").write_text('#include "a.itp"')
        top = tmp_path / "system.top"
        top.write_text('#include "a.itp"')
        with pytest.raises(RecursionError, match="Circular include"):
            parse_top_bonds(str(top))

    def test_diamond_include_allowed(self, tmp_path):
        (tmp_path / "d.itp").write_text("[ bonds ]\n1 2 1\n")
        (tmp_path / "b.itp").write_text('#include "d.itp"')
        (tmp_path / "c.itp").write_text('#include "d.itp"')
        top = tmp_path / "system.top"
        top.write_text('#include "b.itp"\n#include "c.itp"\n')
        # Diamond includes are legal (no circular-include error); the identical
        # bond contributed by both branches is deduplicated.
        bonds = parse_top_bonds(str(top))
        np.testing.assert_array_equal(bonds, [[0, 1]])
