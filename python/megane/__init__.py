"""megane - A fast, beautiful molecular viewer."""

from typing import TYPE_CHECKING

from megane.parsers.c3xml import load_c3xml
from megane.parsers.cif import load_cif
from megane.parsers.cml import load_cml
from megane.parsers.gamess import load_gamess
from megane.parsers.jcampdx import load_jcampdx
from megane.parsers.lammps_data import load_lammps_data
from megane.parsers.lammpstrj import load_lammpstrj_structure
from megane.parsers.magres import load_magres
from megane.parsers.molden import load_molden
from megane.parsers.odydata import load_odydata
from megane.parsers.pdb import load_pdb
from megane.parsers.phonon import load_phonon
from megane.parsers.traj import load_traj
from megane.parsers.vasp import load_vasp
from megane.parsers.xsf import load_xsf
from megane.parsers.xtc import load_trajectory
from megane.parsers.xyz import load_xyz_trajectory
from megane.pipeline import (
    AddBonds,
    AddCoordination,
    AddLabels,
    AddPolyhedra,
    BoundaryCompletion,
    Color,
    DrawingBoundary,
    Filter,
    Isosurface,
    LoadSpectrum,
    LoadStructure,
    LoadTrajectory,
    LoadVector,
    LoadVolumetric,
    Modify,
    Pipeline,
    Replicate,
    Representation,
    SpectrumPlot,
    Streaming,
    Symmetry,
    VectorOverlay,
    Viewport,
    Wrap,
    build_pipeline,
    view,
    view_traj,
)
from megane.writers import save_structure, write_structure

if TYPE_CHECKING:
    from megane.widget import MolecularViewer

__all__ = [
    "AddBonds",
    "AddCoordination",
    "AddLabels",
    "AddPolyhedra",
    "BoundaryCompletion",
    "Color",
    "DrawingBoundary",
    "Filter",
    "build_pipeline",
    "Isosurface",
    "LoadSpectrum",
    "LoadStructure",
    "LoadTrajectory",
    "LoadVector",
    "LoadVolumetric",
    "MolecularViewer",
    "Modify",
    "Pipeline",
    "Replicate",
    "Representation",
    "SpectrumPlot",
    "Streaming",
    "Symmetry",
    "VectorOverlay",
    "Viewport",
    "Wrap",
    "load_c3xml",
    "load_cif",
    "load_gamess",
    "load_cml",
    "load_jcampdx",
    "load_lammps_data",
    "load_lammpstrj_structure",
    "load_magres",
    "load_molden",
    "load_odydata",
    "load_pdb",
    "load_phonon",
    "load_traj",
    "load_trajectory",
    "load_xsf",
    "load_vasp",
    "load_xyz_trajectory",
    "save_structure",
    "view",
    "view_traj",
    "write_structure",
]
__version__ = "0.17.0"


def __getattr__(name: str) -> object:
    # The Jupyter widget imports anywidget -> ipywidgets -> IPython, which
    # roughly doubles the cost of `import megane` in time and memory. The CLI,
    # the server and scripts that only read or write structures never use it,
    # so it is imported on first access instead of with the package.
    if name == "MolecularViewer":
        from megane.widget import MolecularViewer

        globals()["MolecularViewer"] = MolecularViewer
        return MolecularViewer
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    # Keep the lazily imported widget visible to dir() and tab completion.
    return sorted(set(globals()) | {"MolecularViewer"})
