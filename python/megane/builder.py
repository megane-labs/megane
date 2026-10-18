"""megane Builder (the structure editor) as a Jupyter widget.

The same app as the web app's ``/builder.html`` and the Builder tabs of the VS
Code and JupyterLab extensions, in a notebook cell::

    >>> import megane
    >>> builder = megane.Builder("caffeine.sdf")
    >>> builder  # edit in the cell: add / delete / move atoms, bonds, cells
    >>> builder.save("caffeine_edited.pdb")
    >>> atoms = builder.to_ase()

The front end writes the edited structure back into the widget state after
every edit (``_document``), so :meth:`Builder.save`, :meth:`Builder.text` and
:meth:`Builder.to_ase` read what is on screen without a round trip. *File ›
Save* in the cell writes into :attr:`Builder.save_dir` (the kernel's working
directory unless set) and never overwrites a file: a taken name gets a ``-1``,
``-2``, … suffix.

A page shows one Builder at a time. Displaying a second one moves the Builder
into the new output; the old output offers *Show here* to take it back.
"""

from __future__ import annotations

import io
import os
import pathlib
import re
import uuid
from typing import Any

import anywidget
import traitlets

from megane.widget import ANYWIDGET_FRONTEND_RANGE
from megane.writers import StructureFormat, format_from_path

__all__ = ["Builder"]

_STATIC_DIR = pathlib.Path(__file__).parent / "static"
_RDKIT_WASM = _STATIC_DIR / "megane-rdkit.wasm"
_FORMATS: tuple[StructureFormat, ...] = ("xyz", "pdb", "mol")


def _free_path(directory: pathlib.Path, name: str) -> pathlib.Path:
    """``directory / name``, or the first ``stem-N.ext`` beside it that does not exist yet."""
    target = directory / name
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    n = 1
    while True:
        candidate = directory / f"{stem}-{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def _safe_name(name: str) -> str:
    """A bare file name from whatever the front end sent (no directories, no surprises)."""
    base = re.split(r"[\\/]", str(name))[-1].strip()
    base = re.sub(r"[^\w.\-+ ]", "_", base)
    return base if base not in ("", ".", "..") else "structure.xyz"


class Builder(anywidget.AnyWidget):
    """megane Builder — an interactive structure editor — in a notebook cell.

    Args:
        path: A structure file to open (any format megane reads: PDB, XYZ,
            MOL / SDF, MOL2, CIF, GRO, LAMMPS data, …). Omit it to start from
            the empty start screen (*New empty cell…*, *New bulk crystal…* or
            the molecule library).
        height: CSS height of the cell output.
        save_dir: Where *File › Save* in the cell writes files. Defaults to the
            kernel's working directory at the time of the save.
    """

    _esm = _STATIC_DIR / "builder_widget.js"
    _css = ""

    _model_module_version = traitlets.Unicode(ANYWIDGET_FRONTEND_RANGE).tag(sync=True)
    _view_module_version = traitlets.Unicode(ANYWIDGET_FRONTEND_RANGE).tag(sync=True)

    # Tells two Builder objects apart in the front end, which shows one at a time.
    _instance_id = traitlets.Unicode("").tag(sync=True)

    # Python → JS: a file to open. Bumping _source_seq reopens it.
    _source = traitlets.Bytes(b"").tag(sync=True)
    _source_name = traitlets.Unicode("").tag(sync=True)
    _source_seq = traitlets.Int(0).tag(sync=True)

    # JS → Python: the document on screen ({name, n_atoms, n_bonds, n_edits,
    # has_cell, xyz, pdb, mol}); see src/builderWidget.ts `documentState`.
    _document = traitlets.Dict({}).tag(sync=True)

    height = traitlets.Unicode("600px").tag(sync=True)

    def __init__(
        self,
        path: str | os.PathLike[str] | None = None,
        *,
        height: str = "600px",
        save_dir: str | os.PathLike[str] | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(height=height, _instance_id=uuid.uuid4().hex, **kwargs)
        self.save_dir: pathlib.Path | None = pathlib.Path(save_dir) if save_dir is not None else None
        self.on_msg(self._handle_message)
        if path is not None:
            self.load(path)

    # ── Python → Builder ──

    def load(self, path: str | os.PathLike[str]) -> Builder:
        """Open a structure file as the document, replacing the current one."""
        p = pathlib.Path(path)
        return self.load_bytes(p.read_bytes(), p.name)

    def load_text(self, text: str, name: str) -> Builder:
        """Open a structure given as text; *name*'s extension picks the parser (``"water.pdb"``)."""
        return self.load_bytes(text.encode("utf-8"), name)

    def load_bytes(self, data: bytes, name: str) -> Builder:
        """Open a structure given as bytes; *name*'s extension picks the parser."""
        with self.hold_sync():
            self._source = bytes(data)
            self._source_name = name
            self._source_seq += 1
        return self

    # ── Builder → Python ──

    @property
    def file_name(self) -> str | None:
        """The document's name (``"caffeine.sdf"``, ``"untitled"``), or None with nothing open."""
        return self._document.get("name") or None

    @property
    def n_atoms(self) -> int:
        """Atoms in the structure on screen (0 with nothing open)."""
        return int(self._document.get("n_atoms") or 0)

    @property
    def n_bonds(self) -> int:
        """Bonds in the structure on screen."""
        return int(self._document.get("n_bonds") or 0)

    def text(self, fmt: StructureFormat = "xyz") -> str:
        """The structure on screen as ``"xyz"`` (extended XYZ with a cell), ``"pdb"`` or ``"mol"`` text.

        Raises:
            ValueError: For an unknown format, or one the writer refused for this
                structure (MOL holds at most 999 atoms).
            RuntimeError: When the Builder has no atoms (nothing open yet, an
                empty cell, or the widget has not been displayed).
        """
        if fmt not in _FORMATS:
            raise ValueError(f"unknown format {fmt!r}; expected one of {', '.join(_FORMATS)}")
        if self.n_atoms == 0:
            raise RuntimeError("the Builder has no atoms yet; display it and open or build a structure")
        value = self._document.get(fmt)
        if value is None:
            raise ValueError(f"this structure cannot be written as {fmt.upper()}")
        return str(value)

    def save(self, path: str | os.PathLike[str], fmt: StructureFormat | None = None) -> pathlib.Path:
        """Write the structure on screen to *path* (format from its extension unless *fmt* is given)."""
        target = pathlib.Path(path)
        target.write_text(self.text(fmt or format_from_path(target)), encoding="utf-8")
        return target

    def to_ase(self) -> Any:
        """The structure on screen as an ``ase.Atoms`` (needs ASE installed)."""
        try:
            import ase.io
        except ImportError as exc:  # pragma: no cover - depends on the environment
            raise ImportError("Builder.to_ase() needs ASE: pip install ase") from exc
        fmt = "extxyz" if self._document.get("has_cell") else "xyz"
        return ase.io.read(io.StringIO(self.text("xyz")), format=fmt)

    # ── Requests from the front end ──

    def _handle_message(self, _widget: Any, content: Any, _buffers: Any) -> None:
        if not isinstance(content, dict):
            return
        kind = content.get("type")
        request_id = content.get("id")
        if kind == "save":
            self._save_request(request_id, content)
        elif kind == "rdkit_wasm":
            self._rdkit_request(request_id)

    def _save_request(self, request_id: Any, content: dict[str, Any]) -> None:
        try:
            directory = self.save_dir if self.save_dir is not None else pathlib.Path.cwd()
            target = _free_path(directory, _safe_name(content.get("name", "")))
            target.write_text(str(content.get("text", "")), encoding="utf-8")
        except OSError as exc:
            self.send({"type": "error", "id": request_id, "message": str(exc)})
            return
        self.send({"type": "saved", "id": request_id, "path": target.name if self.save_dir is None else str(target)})

    def _rdkit_request(self, request_id: Any) -> None:
        if not _RDKIT_WASM.is_file():
            self.send(
                {
                    "type": "error",
                    "id": request_id,
                    "message": f"{_RDKIT_WASM.name} is missing from the megane package",
                }
            )
            return
        self.send({"type": "rdkit_wasm", "id": request_id}, buffers=[_RDKIT_WASM.read_bytes()])
