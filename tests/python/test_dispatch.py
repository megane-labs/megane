"""Filename → structure reader dispatch (``megane.parsers.dispatch``)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pytest

from megane.parsers.dispatch import (
    BINARY_PARSERS,
    TEXT_PARSERS,
    TRAJECTORY_EXTS,
    lammps_prefix_ext,
    load_structure_file,
    structure_ext,
)
from megane.pipeline import LoadStructure, Pipeline

ROOT = Path(__file__).parent.parent.parent
FIXTURES = ROOT / "tests" / "fixtures"


def _ts_structure_exts() -> set[str]:
    source = (ROOT / "src" / "parsers" / "fileNames.ts").read_text()
    block = source.split("export const STRUCTURE_EXTS", 1)[1].split("];", 1)[0]
    return set(re.findall(r'"(\.[a-z0-9]+)"', block))


def test_matches_the_web_app_extension_list():
    assert set(TEXT_PARSERS) | set(BINARY_PARSERS) == _ts_structure_exts()


@pytest.mark.parametrize(
    "name",
    [
        "1crn.pdb",
        "water.gro",
        "si_diamond.xyz",
        "benzene.jxyz",
        "water_md.extxyz",
        "methane.mol",
        "caffeine.sdf",
        "methanol.mol2",
        "nacl.cif",
        "1ala.mmcif",
        "water.lammps",
        "water.lammpstrj",
        "water.trj",
        "POSCAR_si_diamond",
        "XDATCAR_si_md",
        "ethanol.cml",
        "water.molden",
        "si_diamond.xsf",
        "water_relax.axsf",
        "benzene_chem3d.c3xml",
        "ethanol.xodydata",
        "ethanol.odydata",
        "si_nmr.magres",
        "water_opt.gamess",
        "si_gamma.phonon",
        "water.traj",
        # LAMMPS's leading-keyword names.
        "data.water",
        "dump.water",
    ],
)
def test_loads_every_format(name):
    structure = load_structure_file(str(FIXTURES / name))
    assert structure.n_atoms > 0
    assert structure.positions.size == structure.n_atoms * 3
    assert structure.box_origin.shape == (3,)


def test_carries_the_cell_origin():
    # LAMMPS data declares an offset box; it must survive into the Structure.
    structure = load_structure_file(str(FIXTURES / "confined_offset.data"))
    assert np.any(structure.box_origin != 0)


@pytest.mark.parametrize(
    ("path", "ext"),
    [
        ("dir/POSCAR", ".vasp"),
        ("CONTCAR_relaxed", ".vasp"),
        ("XDATCAR.bak", ".vasp"),
        ("model.VASP", ".vasp"),
        ("a/b/Protein.PDB", ".pdb"),
        ("noext", ""),
    ],
)
def test_structure_ext(path, ext):
    assert structure_ext(path) == ext


# The one case table every implementation of the LAMMPS prefix rule is tested
# against (megane_core::formats::lammps_prefix_extension, fileNames.ts).
LAMMPS_CASES = json.loads((FIXTURES / "lammps_prefix_names.json").read_text())["cases"]


@pytest.mark.parametrize("case", LAMMPS_CASES, ids=[c["name"] for c in LAMMPS_CASES])
def test_lammps_prefix_ext_follows_the_shared_case_table(case):
    assert lammps_prefix_ext(case["name"]) == case["ext"]


@pytest.mark.parametrize(
    ("path", "ext"),
    [
        ("runs/data.peptide", ".data"),
        ("DUMP.melt", ".dump"),
        ("dump.xyz", ".xyz"),
        ("data.lammps", ".lammps"),
        ("C:\\runs\\data.npt", ".data"),
    ],
)
def test_structure_ext_resolves_lammps_prefix_names(path, ext):
    assert structure_ext(path) == ext


def test_trajectory_exts_match_the_registry():
    from megane import megane_parser

    registry = json.loads(megane_parser.format_registry())
    expected = {ext for f in registry["trajectory"] for ext in f["extensions"]}
    assert expected == TRAJECTORY_EXTS


def test_lammps_prefix_names_read_like_their_extension():
    data = load_structure_file(str(FIXTURES / "data.water"))
    reference = load_structure_file(str(FIXTURES / "water.lammps"))
    np.testing.assert_array_equal(data.positions, reference.positions)
    np.testing.assert_array_equal(data.bonds, reference.bonds)
    dump = load_structure_file(str(FIXTURES / "dump.water"))
    np.testing.assert_array_equal(dump.positions, load_structure_file(str(FIXTURES / "water.lammpstrj")).positions)


def test_default_bond_source_reads_lammps_prefix_names():
    from megane import megane_parser

    assert megane_parser.default_bond_source("data.peptide") == "structure"
    assert megane_parser.default_bond_source("dump.melt") == "distance"


def test_rejects_unknown_formats(tmp_path):
    dummy = tmp_path / "notes.txt"
    dummy.write_text("x")
    with pytest.raises(ValueError, match="Unsupported structure format"):
        load_structure_file(str(dummy))


def test_pipeline_loads_formats_it_used_to_reject():
    pipe = Pipeline()
    for name in ("ethanol.cml", "POSCAR_si_diamond", "si_diamond.xsf", "water.molden"):
        node = pipe.add_node(LoadStructure(str(FIXTURES / name)))
        assert pipe._node_data[node._id][:4] == b"MEGN"
