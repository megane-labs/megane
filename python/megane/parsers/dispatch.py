"""Filename → structure reader dispatch for every format the viewer opens.

The Python mirror of ``STRUCTURE_EXTS`` (``src/parsers/fileNames.ts``) and
``getParserForExtension`` (``src/parsers/parseCore.ts``), so a pipeline saved
from the web app that loads any structure format opens in Python too.
``tests/python/test_dispatch.py`` pins the two lists together.
"""

from __future__ import annotations

import pathlib
import re

from megane.parsers.common import Structure, structure_from_result

# Extension → ``megane_parser`` function taking the file's text.
TEXT_PARSERS: dict[str, str] = {
    ".pdb": "parse_pdb",
    ".gro": "parse_gro",
    ".xyz": "parse_xyz",
    # Jmol's second extension for plain XYZ.
    ".jxyz": "parse_xyz",
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

# VASP writes POSCAR / CONTCAR / XDATCAR with no extension (often suffixed:
# POSCAR.bak, CONTCAR_relaxed); matched on the basename, as in fileNames.ts.
_VASP_BARE_NAME = re.compile(r"^(poscar|contcar|xdatcar)([-_.].*)?$")


def structure_ext(path: str) -> str:
    """The extension ``path`` is dispatched under (``.vasp`` for bare VASP names)."""
    name = pathlib.Path(path).name.lower()
    if _VASP_BARE_NAME.match(name):
        return ".vasp"
    return pathlib.Path(name).suffix


def load_structure_file(path: str) -> Structure:
    """Read frame 0 of any supported structure file.

    Raises:
        ValueError: The file's extension is not a supported structure format.
    """
    from megane import megane_parser

    ext = structure_ext(path)
    if ext in TEXT_PARSERS:
        with open(path) as f:
            result = getattr(megane_parser, TEXT_PARSERS[ext])(f.read())
    elif ext in BINARY_PARSERS:
        with open(path, "rb") as f:
            result = getattr(megane_parser, BINARY_PARSERS[ext])(f.read())
    else:
        supported = sorted({*TEXT_PARSERS, *BINARY_PARSERS})
        raise ValueError(f"Unsupported structure format: {ext!r}.  Supported: {', '.join(supported)}")
    return structure_from_result(result)
