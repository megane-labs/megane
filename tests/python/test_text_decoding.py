"""Text files are decoded the way the browser hosts decode them (``File.text()``).

UTF-8, a leading byte-order mark dropped, invalid bytes replaced with U+FFFD.
The Python readers used the platform's default encoding instead, so a PDB with
a Latin-1 ``Å`` (0xC5) in a REMARK raised ``UnicodeDecodeError`` in ``view()``,
``set_pipeline()`` and ``megane serve`` while the web app opened it (and a
Windows kernel decoded every file as cp932 / cp1252).
"""

import json
from pathlib import Path

import numpy as np
import pytest

from megane.parsers.common import read_text
from megane.parsers.dispatch import TEXT_PARSERS, load_structure_file, structure_ext

FIXTURES = Path(__file__).parent.parent / "fixtures"
BOM = b"\xef\xbb\xbf"

# The PDB the audit opened in the browser: "REMARK   1 AUTH   J. Ångström" in Latin-1.
LATIN1_PDB = (
    b"REMARK   1 AUTH   J. \xc5ngstr\xf6m\n"
    b"ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00  0.00           O\n"
    b"END\n"
)


def test_read_text_replaces_invalid_bytes_and_drops_a_bom(tmp_path):
    path = tmp_path / "x.txt"
    path.write_bytes(BOM + b"caf\xe9 \xc3\x85 ok\n")
    assert read_text(path) == "caf� Å ok\n"
    assert read_text(str(path)) == "caf� Å ok\n"


def test_latin1_pdb_opens_in_every_python_entry_point(tmp_path):
    import warnings

    import megane
    from megane import server
    from megane.parsers.pdb import load_pdb
    from megane.parsers.xtc import _topology_n_atoms

    path = tmp_path / "latin1.pdb"
    path.write_bytes(LATIN1_PDB)
    assert load_pdb(str(path)).n_atoms == 1
    assert load_structure_file(str(path)).n_atoms == 1
    assert _topology_n_atoms(str(path)) == 1
    viewer = megane.view(str(path))
    assert viewer._node_snapshots_data
    server.configure(str(path))
    assert server._state.structure.n_atoms == 1
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        megane.MolecularViewer().load(str(path))


# One file per text format the viewer opens, read with a BOM in front.
BOM_FIXTURES = [
    "1crn.pdb",
    "1ala.mmcif",
    "high_precision.gro",
    "si_diamond.xyz",
    "methane.mol",
    "caffeine.sdf",
    "methanol.mol2",
    "nacl.cif",
    "confined_offset.data",
    "water.lammpstrj",
    "POSCAR_si_diamond",
    "ethanol.cml",
    "water.molden",
    "si_diamond.xsf",
    "benzene_chem3d.c3xml",
    "ethanol.odydata",
    "si_nmr.magres",
    "si_gamma.phonon",
]


@pytest.mark.parametrize("name", BOM_FIXTURES)
def test_a_byte_order_mark_is_dropped_like_the_browser_does(tmp_path, name):
    assert structure_ext(name) in TEXT_PARSERS
    original = load_structure_file(str(FIXTURES / name))
    copy = tmp_path / name
    copy.write_bytes(BOM + (FIXTURES / name).read_bytes())
    loaded = load_structure_file(str(copy))
    assert loaded.n_atoms == original.n_atoms
    np.testing.assert_array_equal(loaded.positions, original.positions)
    np.testing.assert_array_equal(loaded.elements, original.elements)


@pytest.mark.parametrize(
    ("loader", "name", "data"),
    [
        ("megane.parsers.xyz:load_xyz_trajectory", "w.xyz", b"3\nwater \xc5\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n"),
        ("megane.parsers.gro:load_gro", "w.gro", b"water \xc5\n1\n    1SOL     OW    1   0.000   0.000   0.000\n   1.0 1.0 1.0\n"),
        ("megane.parsers.cif:load_cif", "w.cif", None),
        ("megane.parsers.mol:load_mol", "w.mol", None),
        ("megane.parsers.mol:load_sdf", "w.sdf", None),
    ],
)
def test_latin1_bytes_in_comments_are_replaced(tmp_path, loader, name, data):
    import importlib

    module, func = loader.split(":")
    if data is None:  # a Latin-1 comment added to a real file
        source = {"w.cif": "nacl.cif", "w.mol": "methane.mol", "w.sdf": "caffeine.sdf"}[name]
        raw = (FIXTURES / source).read_bytes()
        data = (b"# caf\xe9\n" + raw) if name.endswith(".cif") else (b"caf\xe9" + raw)
    path = tmp_path / name
    path.write_bytes(data)
    result = getattr(importlib.import_module(module), func)(str(path))
    structure = result[0] if isinstance(result, tuple) else result
    assert structure.n_atoms > 0


def test_psf_topology_with_latin1_title_and_bom(tmp_path):
    from megane.parsers.psf import parse_psf_bonds

    expected = parse_psf_bonds(str(FIXTURES / "water.psf"))
    raw = (FIXTURES / "water.psf").read_bytes()
    path = tmp_path / "w.psf"
    path.write_bytes(BOM + raw.replace(b"\n", b" caf\xe9\n", 1))
    np.testing.assert_array_equal(parse_psf_bonds(str(path)), expected)


def test_gromacs_topology_with_latin1_comment(tmp_path):
    """The .top path reader is Rust's; it decodes the same way."""
    from megane.parsers.top import parse_top_bonds

    expected = parse_top_bonds(str(FIXTURES / "test_topology.top"))
    path = tmp_path / "t.top"
    path.write_bytes(BOM + b"; caf\xe9\n" + (FIXTURES / "test_topology.top").read_bytes())
    np.testing.assert_array_equal(parse_top_bonds(str(path)), expected)


def test_pipeline_json_with_a_bom_loads(tmp_path):
    from megane.pipeline import LoadStructure, Pipeline

    pipe = Pipeline()
    pipe.add_node(LoadStructure(str(FIXTURES / "1crn.pdb")))
    path = tmp_path / "p.megane.json"
    path.write_bytes(BOM + pipe.to_json().encode("utf-8"))
    assert json.loads(Pipeline.load(path).to_json()) == json.loads(pipe.to_json())
