"""The PyO3 binding is generated from megane-core's format registry.

``crates/megane-core/src/formats.rs`` holds the one table of structure and
trajectory formats that both the WASM and the PyO3 bindings are generated from.
``tests/ts/parsers/formatRegistry.test.ts`` checks the WASM side; this file is
its Python twin. Together they pin CRITICAL RULE #6 (host consistency): both
hosts expose exactly the registry's formats, plus the explicit, documented
allowlists below. Also covers the ``PyStructure`` / ``PyTrajectoryData`` fields
that used to exist only on the WASM ``ParseResult``.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from megane import megane_parser
from megane.parsers.dispatch import BINARY_PARSERS, TEXT_PARSERS

FIXTURES = Path(__file__).parent.parent / "fixtures"

REGISTRY = json.loads(megane_parser.format_registry())

# Python-only ``parse_*`` exports that are deliberately not registry formats:
#   parse_amber               — prmtop + inpcrd in one call (two files; the
#                               browser joins them in its pipeline instead).
#   parse_top_bonds_from_path — resolves ``#include`` from the filesystem.
#   parse_psf_bonds           — bond pairs only (both hosts; not a structure).
#   parse_jcampdx             — a spectrum, not a structure (both hosts).
PYTHON_ONLY_PARSE_EXPORTS = {
    "parse_amber",
    "parse_top_bonds_from_path",
    "parse_psf_bonds",
    "parse_jcampdx",
}


def _read(name: str) -> str:
    return (FIXTURES / name).read_text()


def test_module_parsers_are_exactly_the_registry_plus_allowlist():
    structure = {f["binding"] for f in REGISTRY["structure"]}
    trajectory = {f["python"] for f in REGISTRY["trajectory"]}
    exported = {name for name in dir(megane_parser) if name.startswith("parse_")}
    assert len(structure) > 15
    assert structure.isdisjoint(trajectory)
    assert exported == structure | trajectory | PYTHON_ONLY_PARSE_EXPORTS
    for name in structure | trajectory:
        assert callable(getattr(megane_parser, name)), name


def test_dispatch_tables_match_the_registry():
    # ``megane.parsers.dispatch`` maps each extension to the same binding (and
    # encoding) the core registry assigns it.
    expected_text: dict[str, str] = {}
    expected_binary: dict[str, str] = {}
    for f in REGISTRY["structure"]:
        target = expected_binary if f["encoding"] == "binary" else expected_text
        for ext in f["extensions"]:
            target[ext] = f["binding"]
    assert TEXT_PARSERS == expected_text
    assert BINARY_PARSERS == expected_binary


def test_trajectory_registry_names_both_hosts():
    by_python = {f["python"]: f for f in REGISTRY["trajectory"]}
    assert by_python["parse_xtc"]["wasm"] == "parse_xtc_file"
    assert by_python["parse_xtc"]["encoding"] == "binary"
    assert by_python["parse_lammpstrj"]["encoding"] == "text"
    assert ".nc" in by_python["parse_netcdf"]["extensions"]


def test_generated_parser_keeps_docstring_and_signature():
    assert megane_parser.parse_cif.__doc__.startswith("Parse a CIF file text")
    assert megane_parser.parse_pdb.__text_signature__ == "(text)"
    assert megane_parser.parse_traj.__text_signature__ == "(data)"
    assert megane_parser.parse_xtc.__text_signature__ == "(data)"
    with pytest.raises(ValueError):
        megane_parser.parse_gro("")


def test_structure_exposes_labels_chains_bfactors_and_backbone():
    s = megane_parser.parse_pdb(_read("1crn.pdb"))
    assert s.n_bonds == s.bonds.shape[0]
    # 1CRN declares its disulfide CONECT records; ``bonds`` lists those first.
    assert 0 < s.n_file_bonds <= s.n_bonds
    assert len(s.atom_labels) == s.n_atoms
    assert s.atom_labels[0] == "THR1"  # residue name + number
    assert s.chain_ids.dtype == np.uint8 and s.chain_ids.shape == (s.n_atoms,)
    assert chr(s.chain_ids[0]) == "A"
    assert s.bfactors.dtype == np.float32 and s.bfactors.shape == (s.n_atoms,)
    assert s.bfactors[0] == pytest.approx(13.79)
    n_ca = s.ca_indices.shape[0]
    assert n_ca == 46  # crambin has 46 residues
    assert s.ca_chain_ids.shape == s.ca_res_nums.shape == s.ca_ss_type.shape == (n_ca,)
    assert set(np.unique(s.ca_ss_type)) <= {0, 1, 2}
    assert s.vector_channels == []
    assert (s.varies_atoms, s.varies_cell, s.varies_topology) == (False, False, False)


def test_structure_optional_fields_are_none_when_absent():
    s = megane_parser.parse_xyz(_read("si_diamond.xyz"))
    assert s.chain_ids is None
    assert s.bfactors is None
    assert s.ca_indices.shape == (0,)
    assert s.n_file_bonds == 0


def test_structure_exposes_vector_channels():
    s = megane_parser.parse_gro(_read("water_multiframe.gro"))
    assert [name for name, _ in s.vector_channels] == ["velocity"]
    frames = s.vector_channels[0][1]
    assert len(frames) == 3
    assert all(f.shape == (s.n_atoms, 3) and f.dtype == np.float32 for f in frames)


def test_structure_reports_which_frame_channels_vary():
    s = megane_parser.parse_xyz(_read("hetero_atoms.xyz"))
    assert s.heterogeneous
    assert s.varies_atoms


_OFFSET_VELOCITY_DUMP = """ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
2
ITEM: BOX BOUNDS pp pp pp
-5.0 5.0
1.0 11.0
2.0 12.0
ITEM: ATOMS id type x y z vx vy vz
1 1 1.0 2.0 3.0 0.1 0.2 0.3
2 2 4.0 5.0 6.0 0.4 0.5 0.6
ITEM: TIMESTEP
100
ITEM: NUMBER OF ATOMS
2
ITEM: BOX BOUNDS pp pp pp
-5.0 5.0
1.0 11.0
2.0 12.0
ITEM: ATOMS id type x y z vx vy vz
1 1 1.1 2.1 3.1 0.11 0.21 0.31
2 2 4.1 5.1 6.1 0.41 0.51 0.61
"""


def test_trajectory_exposes_box_origin_and_vector_channels():
    t = megane_parser.parse_lammpstrj(_OFFSET_VELOCITY_DUMP)
    np.testing.assert_allclose(t.box_origin, [-5.0, 1.0, 2.0])
    assert [name for name, _ in t.vector_channels] == ["velocity"]
    frames = t.vector_channels[0][1]
    assert len(frames) == t.n_frames == 2
    np.testing.assert_allclose(frames[0], [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], rtol=1e-6)
    np.testing.assert_allclose(frames[1][1], [0.41, 0.51, 0.61], rtol=1e-6)


def test_trajectory_box_origin_defaults_to_zero():
    t = megane_parser.parse_dcd((FIXTURES / "water.dcd").read_bytes())
    assert t.box_origin.shape == (3,)
    assert not t.box_origin.any()
    assert t.vector_channels == []


def test_heterogeneous_trajectory_keeps_new_fields():
    t = megane_parser.parse_lammpstrj(_read("hetero_atoms.lammpstrj"))
    assert t.heterogeneous
    assert t.box_origin.shape == (3,)
    assert t.vector_channels == []
