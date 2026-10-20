"""megane.Builder: the structure editor as a Jupyter widget (Python side).

The front end (src/builderWidget.ts) writes the document back into
``_document`` and asks the kernel to save files and to send RDKit's ``.wasm``;
these tests play the front end's part.
"""

import pathlib

import pytest

import megane
from megane.builder import Builder, _free_path, _safe_name

FIXTURES = pathlib.Path(__file__).parent.parent / "fixtures"

WATER_XYZ = "3\nwater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0\n"


def _document(**overrides):
    doc = {
        "name": "water.xyz",
        "n_atoms": 3,
        "n_bonds": 2,
        "n_edits": 1,
        "has_cell": False,
        "xyz": WATER_XYZ,
        "pdb": "PDB TEXT\nEND\n",
        "mol": None,
    }
    doc.update(overrides)
    return doc


class Sent:
    """Capture what the widget sends to the front end."""

    def __init__(self, builder):
        self.messages = []
        builder.send = lambda content, buffers=None: self.messages.append((content, buffers))


def test_lazy_export_from_the_package():
    assert megane.Builder is Builder
    assert "Builder" in dir(megane)
    assert "Builder" in megane.__all__


def test_esm_is_the_builder_bundle():
    b = Builder()
    assert isinstance(b._esm, str)
    assert "render" in b._esm
    assert b._instance_id and len(b._instance_id) == 32
    assert Builder()._instance_id != b._instance_id
    assert b.height == "600px"


def test_load_sends_the_file_and_bumps_the_sequence():
    path = FIXTURES / "1crn.pdb"
    b = Builder(path, height="400px")
    assert b._source == path.read_bytes()
    assert b._source_name == path.name
    assert b._source_seq == 1
    assert b.height == "400px"
    # Loading the same file again still reopens it.
    b.load(path)
    assert b._source_seq == 2


def test_load_text_and_bytes():
    b = Builder()
    assert b.load_text(WATER_XYZ, "water.xyz") is b
    assert b._source == WATER_XYZ.encode()
    assert b._source_name == "water.xyz"
    b.load_bytes(b"abc", "x.pdb")
    assert (b._source, b._source_name, b._source_seq) == (b"abc", "x.pdb", 2)


def test_document_properties():
    b = Builder()
    assert b.file_name is None
    assert b.n_atoms == 0
    assert b.n_bonds == 0
    b._document = _document()
    assert b.file_name == "water.xyz"
    assert b.n_atoms == 3
    assert b.n_bonds == 2


def test_text_reads_the_document():
    b = Builder()
    with pytest.raises(RuntimeError, match="no atoms"):
        b.text()
    b._document = _document()
    assert b.text() == WATER_XYZ
    assert b.text("pdb").startswith("PDB TEXT")
    with pytest.raises(ValueError, match="cannot be written as MOL"):
        b.text("mol")
    with pytest.raises(ValueError, match="cannot be written as CIF"):
        b.text("cif")
    b._document = _document(has_cell=True, cif="data_megane\n", poscar="POSCAR TEXT\n")
    assert b.text("cif") == "data_megane\n"
    assert b.text("poscar") == "POSCAR TEXT\n"
    with pytest.raises(ValueError, match="unknown format"):
        b.text("gro")  # type: ignore[arg-type]


def test_save_picks_the_format_from_the_extension(tmp_path):
    b = Builder()
    b._document = _document()
    out = b.save(tmp_path / "w.xyz")
    assert out.read_text() == WATER_XYZ
    assert b.save(tmp_path / "w.out", fmt="pdb").read_text().startswith("PDB TEXT")
    with pytest.raises(ValueError):
        b.save(tmp_path / "w.unknown")


def test_to_ase():
    ase = pytest.importorskip("ase")
    b = Builder()
    b._document = _document()
    atoms = b.to_ase()
    assert isinstance(atoms, ase.Atoms)
    assert atoms.get_chemical_symbols() == ["O", "H", "H"]


def test_save_request_writes_into_save_dir_without_overwriting(tmp_path):
    b = Builder(save_dir=tmp_path)
    sent = Sent(b)
    b._handle_message(b, {"type": "save", "id": "a", "name": "water.xyz", "text": "one"}, [])
    b._handle_message(b, {"type": "save", "id": "b", "name": "water.xyz", "text": "two"}, [])
    assert (tmp_path / "water.xyz").read_text() == "one"
    assert (tmp_path / "water-1.xyz").read_text() == "two"
    assert sent.messages[0][0] == {"type": "saved", "id": "a", "path": str(tmp_path / "water.xyz")}
    assert sent.messages[1][0]["path"] == str(tmp_path / "water-1.xyz")


def test_save_request_defaults_to_the_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    b = Builder()
    sent = Sent(b)
    b._handle_message(b, {"type": "save", "id": 1, "name": "../../etc/x.pdb", "text": "t"}, [])
    assert (tmp_path / "x.pdb").read_text() == "t"
    assert sent.messages == [({"type": "saved", "id": 1, "path": "x.pdb"}, None)]


def test_save_request_reports_write_errors(tmp_path):
    b = Builder(save_dir=tmp_path / "missing" / "dir")
    sent = Sent(b)
    b._handle_message(b, {"type": "save", "id": 7, "name": "a.xyz", "text": "t"}, [])
    content, _ = sent.messages[0]
    assert content["type"] == "error"
    assert content["id"] == 7


def test_rdkit_request_sends_the_module(monkeypatch, tmp_path):
    wasm = tmp_path / "megane-rdkit.wasm"
    wasm.write_bytes(b"\0asm")
    monkeypatch.setattr("megane.builder._RDKIT_WASM", wasm)
    b = Builder()
    sent = Sent(b)
    b._handle_message(b, {"type": "rdkit_wasm", "id": "r"}, [])
    assert sent.messages == [({"type": "rdkit_wasm", "id": "r"}, [b"\0asm"])]


def test_rdkit_request_without_the_module(monkeypatch, tmp_path):
    monkeypatch.setattr("megane.builder._RDKIT_WASM", tmp_path / "nope.wasm")
    b = Builder()
    sent = Sent(b)
    b._handle_message(b, {"type": "rdkit_wasm", "id": "r"}, [])
    content, _ = sent.messages[0]
    assert content["type"] == "error"
    assert "missing" in content["message"]


def test_unknown_messages_are_ignored():
    b = Builder()
    sent = Sent(b)
    b._handle_message(b, "not a dict", [])
    b._handle_message(b, {"type": "something"}, [])
    assert sent.messages == []


def test_free_path(tmp_path):
    assert _free_path(tmp_path, "a.xyz") == tmp_path / "a.xyz"
    (tmp_path / "a.xyz").write_text("")
    (tmp_path / "a-1.xyz").write_text("")
    assert _free_path(tmp_path, "a.xyz") == tmp_path / "a-2.xyz"


@pytest.mark.parametrize(
    ("raw", "safe"),
    [
        ("water.xyz", "water.xyz"),
        ("dir/sub/water.pdb", "water.pdb"),
        ("C:\\x\\y.mol", "y.mol"),
        ("..", "structure.xyz"),
        ("", "structure.xyz"),
        ("a<b>.xyz", "a_b_.xyz"),
    ],
)
def test_safe_name(raw, safe):
    assert _safe_name(raw) == safe
