"""Filename → structure reader dispatch for every format the viewer opens.

The Python mirror of ``STRUCTURE_EXTS`` (``src/parsers/fileNames.ts``) and
``getParserForExtension`` (``src/parsers/parseCore.ts``), so a pipeline saved
from the web app that loads any structure format opens in Python too.
``tests/python/test_dispatch.py`` pins the two lists together.
"""

from __future__ import annotations

import pathlib
import re

from megane.parsers.common import (
    InMemoryTrajectory,
    Structure,
    read_text,
    structure_and_trajectory_from_result,
    structure_from_result,
)

# Extension → ``megane_parser`` function taking the file's text.
TEXT_PARSERS: dict[str, str] = {
    ".pdb": "parse_pdb",
    ".gro": "parse_gro",
    ".xyz": "parse_xyz",
    # Jmol's second extension for plain XYZ.
    ".jxyz": "parse_xyz",
    # Extended XYZ (ASE's `extxyz` writer) — same grammar as `.xyz`.
    ".extxyz": "parse_xyz",
    ".mol": "parse_mol",
    ".sdf": "parse_mol",
    ".mol2": "parse_mol2",
    ".cif": "parse_cif",
    ".mmcif": "parse_mmcif",
    ".data": "parse_lammps_data",
    ".lammps": "parse_lammps_data",
    ".prmtop": "parse_prmtop",
    # LAMMPS dump opened standalone as a structure (frame-0 topology; integer
    # atom `type` ids used as element proxies).
    ".lammpstrj": "parse_lammpstrj_structure",
    ".dump": "parse_lammpstrj_structure",
    ".trj": "parse_lammpstrj_structure",
    ".vasp": "parse_vasp",
    ".cml": "parse_cml",
    ".molden": "parse_molden",
    ".xsf": "parse_xsf",
    ".axsf": "parse_xsf",
    ".c3xml": "parse_c3xml",
    ".xodydata": "parse_odydata",
    ".odydata": "parse_odydata",
    ".magres": "parse_magres",
    ".gamess": "parse_gamess",
    ".phonon": "parse_phonon",
}

# Extension → ``megane_parser`` function taking the file's bytes.
BINARY_PARSERS: dict[str, str] = {
    ".traj": "parse_traj",
}

# Trajectory extensions (``TRAJECTORY_EXTS`` in fileNames.ts; the core
# registry's trajectory formats). A structure-only reader has no use for them,
# but a LAMMPS prefix name ending in one is that format, not LAMMPS.
TRAJECTORY_EXTS: frozenset[str] = frozenset({".xtc", ".lammpstrj", ".dump", ".trj", ".dcd", ".nc"})

# VASP writes POSCAR / CONTCAR / XDATCAR with no extension (often suffixed:
# POSCAR.bak, CONTCAR_relaxed); matched on the basename, as in fileNames.ts.
_VASP_BARE_NAME = re.compile(r"^(poscar|contcar|xdatcar)([-_.].*)?$")

# LAMMPS names files by a leading keyword: data.peptide, dump.melt.
_LAMMPS_PREFIX_NAME = re.compile(r"^(data|dump)\.(.+)$")


def _basename(path: str) -> str:
    # Either separator, so a Windows path names the same file on every OS.
    return re.split(r"[\\/]", path)[-1]


def lammps_prefix_ext(path: str) -> str | None:
    """The extension a LAMMPS file named by its leading keyword dispatches under.

    ``".data"`` for ``data.<name>`` (``read_data data.peptide``), ``".dump"``
    for ``dump.<name>`` (``dump 1 all atom 100 dump.melt``), ``None`` for any
    other name — including one that also ends in an extension Megane reads
    (``dump.xyz`` is an XYZ file, ``data.lammps`` LAMMPS data by extension).

    Mirrors ``megane_core::formats::lammps_prefix_extension`` and
    ``lammpsPrefixExt`` in ``src/parsers/fileNames.ts``; all of them are tested
    against ``tests/fixtures/lammps_prefix_names.json``.
    """
    name = _basename(path).lower()
    match = _LAMMPS_PREFIX_NAME.match(name)
    if match is None:
        return None
    last = name[name.rindex(".") :]
    if last in TEXT_PARSERS or last in BINARY_PARSERS or last in TRAJECTORY_EXTS:
        return None
    return ".data" if match.group(1) == "data" else ".dump"


def structure_ext(path: str) -> str:
    """The extension ``path`` is dispatched under.

    ``.vasp`` for bare VASP names, ``.data`` / ``.dump`` for LAMMPS's prefix
    names (``data.peptide``, ``dump.melt``), else the last extension.
    """
    name = _basename(path).lower()
    if _VASP_BARE_NAME.match(name):
        return ".vasp"
    lammps = lammps_prefix_ext(name)
    if lammps is not None:
        return lammps
    return pathlib.Path(name).suffix


def _parse_structure_result(path: str):
    from megane import megane_parser

    ext = structure_ext(path)
    if ext in TEXT_PARSERS:
        return getattr(megane_parser, TEXT_PARSERS[ext])(read_text(path))
    if ext in BINARY_PARSERS:
        with open(path, "rb") as f:
            return getattr(megane_parser, BINARY_PARSERS[ext])(f.read())
    supported = sorted({*TEXT_PARSERS, *BINARY_PARSERS})
    raise ValueError(f"Unsupported structure format: {ext!r}.  Supported: {', '.join(supported)}")


def load_structure_file(path: str) -> Structure:
    """Read frame 0 of any supported structure file.

    Raises:
        ValueError: The file's extension is not a supported structure format.
    """
    return structure_from_result(_parse_structure_result(path))


def load_structure_file_with_frames(path: str) -> tuple[Structure, InMemoryTrajectory | None]:
    """Frame 0 of a structure file plus, when the file holds more than one
    frame (multi-frame XYZ, ASE ``.traj``, …), all of them as a trajectory —
    from one parse, so a viewer that also plays the file's frames does not
    read it twice.

    Raises:
        ValueError: The file's extension is not a supported structure format.
    """
    result = _parse_structure_result(path)
    if int(getattr(result, "n_frames", 0)) == 0:
        return structure_from_result(result), None
    return structure_and_trajectory_from_result(result)
