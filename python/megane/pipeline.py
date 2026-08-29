"""NetworkX-style pipeline builder for megane molecular viewer.

Nodes are class instances added via ``add_node()``, connections via
``add_edge()`` with explicit port objects.  The pipeline serializes to
the same ``SerializedPipeline`` v3 JSON format used by the TypeScript
pipeline engine, which remains the source of truth.

A ``Viewport`` node must be explicitly added and connected for data
to be rendered.

Example::

    from megane import Pipeline, LoadStructure, Filter, Modify, AddBonds, Viewport, MolecularViewer

    pipe = Pipeline()
    s = pipe.add_node(LoadStructure("protein.pdb"))
    f = pipe.add_node(Filter(query="element == 'C'"))
    m = pipe.add_node(Modify(scale=1.3))
    b = pipe.add_node(AddBonds())
    v = pipe.add_node(Viewport())

    pipe.add_edge(s.out.particle, f.inp.particle)
    pipe.add_edge(f.out.particle, m.inp.particle)
    pipe.add_edge(s.out.particle, b.inp.particle)
    pipe.add_edge(m.out.particle, v.inp.particle)
    pipe.add_edge(b.out.bond, v.inp.bond)

    viewer = MolecularViewer()
    viewer.set_pipeline(pipe)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from megane.parsers.common import InMemoryTrajectory
    from megane.widget import MolecularViewer

# ─── Port Objects ────────────────────────────────────────────────────


class NodePort:
    """A single typed I/O port on a pipeline node.

    Returned by ``node.out.<name>`` and ``node.inp.<name>``.
    Pass to ``Pipeline.add_edge()`` to connect nodes explicitly.
    """

    def __init__(self, node: PipelineNode, handle: str) -> None:
        self._node = node
        self.handle = handle  # JSON wire name, e.g. "particle", "trajectory", "in"


class PortNamespace:
    """Attribute-access namespace that returns :class:`NodePort` instances.

    Example: ``node.out.particle`` → ``NodePort(node, 'particle')``.
    """

    def __init__(self, node: PipelineNode, port_map: dict[str, str]) -> None:
        # Use object.__setattr__ to avoid triggering our own __getattr__.
        object.__setattr__(self, "_node", node)
        object.__setattr__(self, "_port_map", port_map)

    def __getattr__(self, name: str) -> NodePort:
        port_map: dict[str, str] = object.__getattribute__(self, "_port_map")
        node: PipelineNode = object.__getattribute__(self, "_node")
        if name not in port_map:
            available = ", ".join(sorted(port_map)) or "(none)"
            raise AttributeError(f"No port {name!r} on {node._node_type!r} node. Available: {available}")
        return NodePort(node, port_map[name])

    def __dir__(self) -> list[str]:
        port_map: dict[str, str] = object.__getattribute__(self, "_port_map")
        return sorted(port_map)


# ─── Node Classes ───────────────────────────────────────────────────


class PipelineNode:
    """Base class for all pipeline node types."""

    _node_type: str = ""
    _out_ports: dict[str, str] = {}
    _inp_ports: dict[str, str] = {}

    def __init__(self) -> None:
        self._id: str | None = None
        self.out = PortNamespace(self, self.__class__._out_ports)
        self.inp = PortNamespace(self, self.__class__._inp_ports)


class LoadStructure(PipelineNode):
    """Load a molecular structure from a file.

    Supported formats: PDB, GRO, XYZ, MOL, SDF, MOL2, CIF, LAMMPS data
    (.data / .lammps), ASE .traj, and LAMMPS dump (.lammpstrj / .dump / .trj)
    opened standalone as a multi-frame structure (frame-0 topology, integer
    atom `type` ids used as element proxies).

    Ports:
        out.particle — atom data
        out.traj     — trajectory channel
        out.cell     — simulation cell
    """

    _node_type = "load_structure"
    _out_ports = {"particle": "particle", "traj": "trajectory", "cell": "cell"}
    _inp_ports: dict[str, str] = {}

    def __init__(self, path: str) -> None:
        super().__init__()
        self.path = path


class LoadTrajectory(PipelineNode):
    """Load an external trajectory file.

    Supported formats: XTC, DCD, AMBER NetCDF (.nc), ASE .traj,
    LAMMPS dump (.lammpstrj / .dump), and multi-frame XYZ.

    Requires connection from a ``LoadStructure`` node via
    ``pipe.add_edge(s.out.particle, t.inp.particle)``.
    Frames are loaded lazily when ``frame_index`` changes.

    Args:
        xtc: Path to XTC trajectory file.
        dcd: Path to DCD trajectory file (CHARMM/NAMD/X-PLOR).
        nc: Path to AMBER NetCDF trajectory file.
        traj: Path to ASE .traj file.
        xyz: Path to multi-frame XYZ file.
        lammpstrj: Path to LAMMPS dump trajectory (.lammpstrj / .dump / .trj).

    Ports:
        inp.particle — atom topology source
        out.traj     — trajectory frames
    """

    _node_type = "load_trajectory"
    _out_ports = {"traj": "trajectory"}
    _inp_ports = {"particle": "particle"}

    def __init__(
        self,
        *,
        xtc: str | None = None,
        dcd: str | None = None,
        nc: str | None = None,
        traj: str | None = None,
        xyz: str | None = None,
        lammpstrj: str | None = None,
    ) -> None:
        super().__init__()
        self.xtc = xtc
        self.dcd = dcd
        self.nc = nc
        self.traj = traj
        self.xyz = xyz
        self.lammpstrj = lammpstrj


class Streaming(PipelineNode):
    """Streaming source node for WebSocket-based data delivery.

    Connects to the server via WebSocket and provides particle,
    trajectory, and cell data from the streaming connection.

    Ports:
        out.particle — atom data
        out.bond     — bond data
        out.traj     — trajectory channel
        out.cell     — simulation cell
    """

    _node_type = "streaming"
    _out_ports = {
        "particle": "particle",
        "bond": "bond",
        "traj": "trajectory",
        "cell": "cell",
    }
    _inp_ports: dict[str, str] = {}

    def __init__(self) -> None:
        super().__init__()


class LoadVector(PipelineNode):
    """Load per-atom vector data from a file.

    Ports:
        out.vector — vector field
    """

    _node_type = "load_vector"
    _out_ports = {"vector": "vector"}
    _inp_ports: dict[str, str] = {}

    def __init__(self, path: str) -> None:
        super().__init__()
        self.path = path


class Filter(PipelineNode):
    """Filter atoms by a selection query.

    Query syntax examples::

        element == 'C'
        element == 'O' and x > 5.0
        resname == 'ALA'
        index >= 100 and index < 200

    Ports:
        inp.particle — atom data in
        out.particle — filtered atom data
    """

    _node_type = "filter"
    _out_ports = {"particle": "out"}
    _inp_ports = {"particle": "in"}

    def __init__(self, *, query: str = "all", bond_query: str = "") -> None:
        super().__init__()
        self.query = query
        self.bond_query = bond_query


class Modify(PipelineNode):
    """Modify per-atom visual properties (scale, opacity).

    Color and representation now live on dedicated :class:`Color` and
    :class:`Representation` nodes so each modifier owns a single visual
    property (Ovito-style modifier stack).

    Ports:
        inp.particle — atom data in
        out.particle — modified atom data
    """

    _node_type = "modify"
    _out_ports = {"particle": "out"}
    _inp_ports = {"particle": "in"}

    def __init__(
        self,
        *,
        scale: float = 1.0,
        opacity: float = 1.0,
    ) -> None:
        super().__init__()
        self.scale = scale
        self.opacity = opacity


class Symmetry(PipelineNode):
    """Expand a crystallographic asymmetric unit into the full unit cell.

    Applies the space-group symmetry operations the parser captured on the
    structure (a CIF ``_symmetry_equiv_pos_as_xyz`` loop) to fill one unit
    cell with the symmetry-equivalent images, replicating bonds per image and
    dropping images that coincide (special positions). ``"expand"`` (the
    default) performs the expansion; ``"none"`` passes the raw asymmetric unit
    through. Structures without symmetry operations or without a unit cell
    pass through unchanged in either mode.

    Args:
        mode: One of ``"expand"``, ``"none"``.

    Ports:
        inp.particle — atom data in
        inp.traj     — trajectory in
        out.particle — expanded atom data
        out.traj     — trajectory (passed through)
    """

    _node_type = "symmetry"
    _out_ports = {"particle": "particle", "traj": "trajectory"}
    _inp_ports = {"particle": "particle", "traj": "trajectory"}

    def __init__(self, *, mode: Literal["expand", "none"] = "expand") -> None:
        super().__init__()
        self.mode = mode


class Wrap(PipelineNode):
    """Toggle periodic-image coordinate mapping for the particle stream.

    ``"wrap"`` folds every atom back into the home unit cell (fractional
    ``[0,1)``); ``"unwrap"`` shifts atoms by whole lattice vectors so bonded
    molecules that straddle a periodic face become spatially contiguous
    (VESTA/Mercury-style whole molecules). ``"none"`` (the default) passes
    coordinates through untouched. Requires the upstream structure to carry a
    unit cell; without one the input is passed through unchanged. A connected
    trajectory is remapped per frame with the same convention.

    Args:
        mode: One of ``"none"``, ``"wrap"``, ``"unwrap"``.

    Ports:
        inp.particle — atom data in
        inp.traj     — trajectory in
        out.particle — remapped atom data
        out.traj     — remapped trajectory
    """

    _node_type = "wrap"
    _out_ports = {"particle": "particle", "traj": "trajectory"}
    _inp_ports = {"particle": "particle", "traj": "trajectory"}

    def __init__(self, *, mode: Literal["none", "wrap", "unwrap"] = "none") -> None:
        super().__init__()
        self.mode = mode


class Replicate(PipelineNode):
    """Replicate the structure into an ``nx × ny × nz`` supercell.

    OVITO/VESTA-style supercell builder: copies every atom (and its bonds)
    into a grid of cell images placed in the +a/+b/+c directions (the
    original cell included) and enlarges the simulation cell to
    ``nx·a, ny·b, nz·c``. Requires the upstream structure to carry a unit
    cell; without one the input is passed through unchanged.

    Args:
        nx: Number of cell images along the a (x) lattice vector (>= 1).
        ny: Number of cell images along the b (y) lattice vector (>= 1).
        nz: Number of cell images along the c (z) lattice vector (>= 1).

    Ports:
        inp.particle — atom data in
        inp.cell     — simulation cell in
        out.particle — replicated atom data
        out.cell     — enlarged simulation cell
    """

    _node_type = "replicate"
    _out_ports = {"particle": "particle", "cell": "cell"}
    _inp_ports = {"particle": "particle", "cell": "cell"}

    def __init__(self, *, nx: int = 1, ny: int = 1, nz: int = 1) -> None:
        super().__init__()
        self.nx = nx
        self.ny = ny
        self.nz = nz


class DrawingBoundary(PipelineNode):
    """Generate periodic display copies inside fractional drawing bounds.

    Unlike :class:`Replicate`, this does not change structural atom indices or
    enlarge the cell. Bounds are inclusive, so a site on 0 is repeated on 1.

    Ports:
        inp.particle — atom data in
        out.particle — atom data carrying periodic display copies
    """

    _node_type = "drawing_boundary"
    _out_ports = {"particle": "particle"}
    _inp_ports = {"particle": "particle"}

    def __init__(
        self,
        *,
        x_min: float = 0.0,
        x_max: float = 1.0,
        y_min: float = 0.0,
        y_max: float = 1.0,
        z_min: float = 0.0,
        z_max: float = 1.0,
    ) -> None:
        super().__init__()
        self.x_min = x_min
        self.x_max = x_max
        self.y_min = y_min
        self.y_max = y_max
        self.z_min = z_min
        self.z_max = z_max


class BoundaryCompletion(PipelineNode):
    """Add bond-connected periodic copies to a Drawing Boundary.

    ``neighbors`` completes one bond shell. ``components`` completes finite
    connected components while leaving infinite periodic networks unchanged.

    Ports:
        inp.particle — atom data carrying a Drawing Boundary
        inp.bond     — periodic bond topology
        out.particle — atom data carrying completed display copies
        out.bond     — bonds repeated over the completed copies
    """

    _node_type = "boundary_completion"
    _out_ports = {"particle": "particle", "bond": "bond"}
    _inp_ports = {"particle": "particle", "bond": "bond"}

    def __init__(self, *, mode: Literal["neighbors", "components"] = "neighbors") -> None:
        super().__init__()
        self.mode = mode


class Color(PipelineNode):
    """Recolor the upstream particle stream by a chosen scheme.

    Args:
        mode: One of ``"uniform"``, ``"byElement"``, ``"byResidue"``,
              ``"byChain"``, ``"byBFactor"``, ``"byProperty"``.
        uniform_color: Hex color used when ``mode == "uniform"``
                       (e.g. ``"#ff8800"``).
        range: Optional ``(min, max)`` for ``byBFactor`` / ``byProperty``.

    Ports:
        inp.particle — atom data in
        out.particle — recolored atom data
    """

    _node_type = "color"
    _out_ports = {"particle": "out"}
    _inp_ports = {"particle": "in"}

    def __init__(
        self,
        *,
        mode: Literal["uniform", "byElement", "byResidue", "byChain", "byBFactor", "byProperty"] = "uniform",
        uniform_color: str = "#ff8800",
        range: tuple[float, float] | None = None,
    ) -> None:
        super().__init__()
        self.mode = mode
        self.uniform_color = uniform_color
        self.range = range


class Representation(PipelineNode):
    """Tag the particle stream with a visual representation.

    Stacks Ovito-style: the Viewport reads the override from the first
    particle stream that carries one, so a downstream Representation node
    wins over an upstream one on the same chain.

    Args:
        mode: One of ``"atoms"`` (default), ``"licorice"``, ``"cartoon"``,
              ``"both"``, ``"surface"``, ``"line"``. ``"licorice"`` draws atoms
              and bonds at one equal radius as a continuous stick/tube (PyMOL
              licorice). ``"line"`` draws thin wireframe lines (VMD/PyMOL
              "lines").

    Ports:
        inp.particle — atom data in
        out.particle — atom data tagged with the representation override
    """

    _node_type = "representation"
    _out_ports = {"particle": "out"}
    _inp_ports = {"particle": "in"}

    def __init__(
        self,
        *,
        mode: Literal["atoms", "licorice", "cartoon", "both", "surface", "line"] = "atoms",
    ) -> None:
        super().__init__()
        self.mode = mode


class AddBonds(PipelineNode):
    """Compute and display bonds.

    Args:
        source: ``"distance"`` for VDW-based inference,
                ``"structure"`` (alias ``"file"``) to use bonds from the
                loaded structure file.
        top: Path to a topology file (GROMACS ``.top`` or CHARMM/NAMD ``.psf``).
             When provided, *source* is ignored and bonds are read from the
             topology.

    Ports:
        inp.particle — atom data
        out.bond     — computed bonds
    """

    _node_type = "add_bond"
    _out_ports = {"bond": "bond"}
    _inp_ports = {"particle": "particle"}

    def __init__(
        self,
        *,
        source: Literal["distance", "structure", "file"] = "distance",
        top: str | None = None,
    ) -> None:
        super().__init__()
        self.source = "structure" if source == "file" else source
        self.top = top


class AddLabels(PipelineNode):
    """Generate text labels at atom positions.

    Args:
        source: ``"element"``, ``"resname"``, or ``"index"``.

    Ports:
        inp.particle — atom data
        out.label    — label data
    """

    _node_type = "label_generator"
    _out_ports = {"label": "label"}
    _inp_ports = {"particle": "particle"}

    def __init__(
        self,
        *,
        source: Literal["element", "resname", "index"] = "element",
    ) -> None:
        super().__init__()
        self.source = source


class AddCoordination(PipelineNode):
    """Generate directed center-neighbor coordination relationships.

    With ``boundary_mode="complete"``, center atoms remain inside Drawing
    Boundary while bonded periodic images of their neighbors may be appended
    outside it to complete the visible coordination environment.

    Ports:
        inp.particle — atom data, normally from :class:`DrawingBoundary`
        out.coordination — directed center-neighbor relationships
        out.bond — the same relationships as renderable bonds
    """

    _node_type = "coordination_generator"
    _out_ports = {"coordination": "coordination", "bond": "bond"}
    _inp_ports = {"particle": "particle"}

    def __init__(
        self,
        *,
        excluded_centers: list[int] | None = None,
        excluded_ligands: list[int] | None = None,
        cutoff_tolerance: float = 1.15,
        boundary_mode: Literal["inside", "complete"] = "complete",
    ) -> None:
        super().__init__()
        self.excluded_centers = list(excluded_centers) if excluded_centers else []
        self.excluded_ligands = list(excluded_ligands) if excluded_ligands else []
        self.cutoff_tolerance = cutoff_tolerance
        self.boundary_mode = boundary_mode


class AddPolyhedra(PipelineNode):
    """Convert directed coordination relationships to polyhedron meshes.

    Ports:
        inp.coordination — directed center-neighbor coordination data
        out.mesh     — polyhedra mesh
    """

    _node_type = "polyhedron_generator"
    _out_ports = {"mesh": "mesh"}
    _inp_ports = {"coordination": "coordination"}

    def __init__(
        self,
        *,
        opacity: float = 0.5,
        show_edges: bool = False,
        edge_color: str = "#dddddd",
        edge_width: float = 3.0,
    ) -> None:
        super().__init__()
        self.opacity = opacity
        self.show_edges = show_edges
        self.edge_color = edge_color
        self.edge_width = edge_width


class VectorOverlay(PipelineNode):
    """Configure per-atom vector visualization (e.g. forces).

    Ports:
        inp.vector — vector field in
        out.vector — configured vector field
    """

    _node_type = "vector_overlay"
    _out_ports = {"vector": "vector"}
    _inp_ports = {"vector": "vector"}

    def __init__(self, *, scale: float = 1.0) -> None:
        super().__init__()
        self.scale = scale


class LoadVolumetric(PipelineNode):
    """Load a Gaussian CUBE file and output volumetric data.

    The file is parsed in the browser; this node only tracks the filename.
    Volumetric data flows to :class:`Isosurface` nodes.

    Ports:
        out.volumetric — volumetric data
    """

    _node_type = "load_volumetric"
    _out_ports = {"volumetric": "volumetric"}
    _inp_ports: dict[str, str] = {}

    def __init__(self, path: str = "") -> None:
        super().__init__()
        self.path = path


class Isosurface(PipelineNode):
    """Extract an isosurface from volumetric data using marching cubes.

    With ``color_mode="volume"`` the surface is painted by sampling a second
    volume connected to ``inp.color_volumetric`` (e.g. an ESP cube mapped onto
    a charge-density isosurface) through ``colormap``.

    Ports:
        inp.volumetric       — volumetric data (from :class:`LoadVolumetric`)
        inp.color_volumetric — optional volume sampled for coloring
        out.mesh             — isosurface mesh
    """

    _node_type = "isosurface"
    _out_ports = {"mesh": "mesh"}
    _inp_ports = {"volumetric": "volumetric", "color_volumetric": "colorVolumetric"}

    def __init__(
        self,
        *,
        iso_level: float = 0.05,
        color: str = "#4488ff",
        opacity: float = 0.7,
        show_negative: bool = False,
        negative_color: str = "#ff4444",
        color_mode: str = "solid",
        colormap: str = "rwb",
        color_range: tuple[float, float] | None = None,
    ) -> None:
        super().__init__()
        self.iso_level = iso_level
        self.color = color
        self.opacity = opacity
        self.show_negative = show_negative
        self.negative_color = negative_color
        if color_mode not in ("solid", "volume"):
            raise ValueError(f"color_mode must be 'solid' or 'volume', got {color_mode!r}")
        if colormap not in ("rwb", "bwr", "rainbow"):
            raise ValueError(f"colormap must be 'rwb', 'bwr' or 'rainbow', got {colormap!r}")
        self.color_mode = color_mode
        self.colormap = colormap
        self.color_range = tuple(color_range) if color_range is not None else None


class LoadSpectrum(PipelineNode):
    """Load a JCAMP-DX spectrum (.jdx / .jcamp) and output spectrum data.

    The file is decoded in the browser; this node only tracks the filename.
    A spectrum has no 3D coordinates, so it flows to :class:`SpectrumPlot`
    rather than to :class:`Viewport`.

    Ports:
        out.spectrum — spectrum data
    """

    _node_type = "load_spectrum"
    _out_ports = {"spectrum": "spectrum"}
    _inp_ports: dict[str, str] = {}

    def __init__(self, path: str = "") -> None:
        super().__init__()
        self.path = path


class SpectrumPlot(PipelineNode):
    """Draw a spectrum as a 2D line chart.

    Terminal node — a spectrum has no geometry, so nothing flows onward to the
    3D renderer.

    Ports:
        inp.spectrum — spectrum data (from :class:`LoadSpectrum`)
    """

    _node_type = "spectrum_plot"
    _out_ports: dict[str, str] = {}
    _inp_ports = {"spectrum": "spectrum"}

    def __init__(self, *, reverse_x: bool = True, color: str = "#84cc16") -> None:
        super().__init__()
        self.reverse_x = reverse_x
        self.color = color


class Viewport(PipelineNode):
    """3D rendering output node.

    All data to be rendered must be explicitly connected to this node.

    Ports:
        inp.particle — atom data
        inp.bond     — bond data
        inp.cell     — simulation cell
        inp.traj     — trajectory frames
        inp.label    — text labels
        inp.mesh     — polyhedra mesh
        inp.vector   — vector field
    """

    _node_type = "viewport"
    _out_ports: dict[str, str] = {}
    _inp_ports = {
        "particle": "particle",
        "bond": "bond",
        "cell": "cell",
        "traj": "trajectory",
        "label": "label",
        "mesh": "mesh",
        "vector": "vector",
    }

    def __init__(
        self,
        *,
        perspective: bool = False,
        cell_axes_visible: bool = True,
        pivot_marker_visible: bool = True,
    ) -> None:
        super().__init__()
        self.perspective = perspective
        self.cell_axes_visible = cell_axes_visible
        self.pivot_marker_visible = pivot_marker_visible


# ─── Pipeline ───────────────────────────────────────────────────────


def _load_structure_file(path: str):
    """Auto-detect format and load a structure file.

    Returns a ``Structure`` object (from ``megane.parsers.pdb``).
    """
    import pathlib

    import numpy as np

    from megane import megane_parser
    from megane.parsers.pdb import Structure

    ext = pathlib.Path(path).suffix.lower()

    text_parsers = {
        ".pdb": megane_parser.parse_pdb,
        ".gro": megane_parser.parse_gro,
        ".xyz": megane_parser.parse_xyz,
        ".mol": megane_parser.parse_mol,
        ".sdf": megane_parser.parse_mol,
        ".mol2": megane_parser.parse_mol2,
        ".cif": megane_parser.parse_cif,
        ".data": megane_parser.parse_lammps_data,
        ".lammps": megane_parser.parse_lammps_data,
        # LAMMPS dump opened standalone as a structure (frame-0 topology; integer
        # atom `type` ids used as element proxies).
        ".lammpstrj": megane_parser.parse_lammpstrj_structure,
        ".dump": megane_parser.parse_lammpstrj_structure,
        ".trj": megane_parser.parse_lammpstrj_structure,
    }
    binary_parsers = {
        ".traj": megane_parser.parse_traj,
    }

    if ext in text_parsers:
        with open(path) as f:
            text = f.read()
        result = text_parsers[ext](text)
    elif ext in binary_parsers:
        with open(path, "rb") as f:
            data = f.read()
        result = binary_parsers[ext](data)
    else:
        supported = sorted({*text_parsers, *binary_parsers})
        raise ValueError(f"Unsupported structure format: {ext!r}.  Supported: {', '.join(supported)}")

    return Structure(
        n_atoms=result.n_atoms,
        positions=np.asarray(result.positions, dtype=np.float32),
        elements=np.asarray(result.elements, dtype=np.uint8),
        bonds=np.asarray(result.bonds, dtype=np.uint32),
        bond_orders=np.asarray(result.bond_orders, dtype=np.uint8),
        box=np.asarray(result.box_matrix, dtype=np.float32),
        box_origin=np.asarray(result.box_origin, dtype=np.float32),
        # Carried into the binary snapshot so the frontend symmetry node can
        # expand a CIF's asymmetric unit exactly like the other hosts.
        symmetry_ops=list(result.symmetry_ops),
    )


class Pipeline:
    """NetworkX-style pipeline graph builder.

    Build a DAG of processing nodes and serialize to the
    ``SerializedPipeline`` v3 JSON format understood by the
    TypeScript pipeline engine.

    Example::

        from megane import Pipeline, LoadStructure, Viewport

        pipe = Pipeline()
        s = pipe.add_node(LoadStructure("protein.pdb"))
        v = pipe.add_node(Viewport())
        pipe.add_edge(s.out.particle, v.inp.particle)
    """

    def __init__(self) -> None:
        self._nodes: dict[str, tuple[PipelineNode, dict]] = {}
        self._edges: list[dict] = []
        self._node_data: dict[str, bytes] = {}
        self._trajectories: dict[str, InMemoryTrajectory] = {}
        self._structures: dict[str, object] = {}
        self._counter = 0

    # ── Public API ──────────────────────────────────────────

    def add_node(self, node: PipelineNode) -> PipelineNode:
        """Add a node to the pipeline.

        Returns the same node instance so its ports can be used in
        ``add_edge()`` calls::

            s = pipe.add_node(LoadStructure("protein.pdb"))
            pipe.add_edge(s.out.particle, ...)
        """
        self._counter += 1
        node._id = f"{node._node_type}-{self._counter}"

        config = self._serialize_node(node)
        self._nodes[node._id] = (node, config)

        if isinstance(node, LoadStructure):
            self._load_structure_data(node)

        return node

    def add_edge(
        self,
        source: NodePort,
        target: NodePort,
    ) -> None:
        """Connect *source* port to *target* port.

        Both ports must belong to nodes already added to this pipeline::

            pipe.add_edge(s.out.particle, f.inp.particle)
            pipe.add_edge(s.out.traj, v.inp.traj)
        """
        if not isinstance(source, NodePort) or not isinstance(target, NodePort):
            raise TypeError(
                "add_edge() requires NodePort arguments. "
                "Use node.out.<name> and node.inp.<name>, "
                "e.g. pipe.add_edge(s.out.particle, f.inp.particle)."
            )
        if source._node._id not in self._nodes or target._node._id not in self._nodes:
            raise ValueError("Both nodes must be added to this pipeline before connecting.")
        self._edges.append(
            {
                "source": source._node._id,
                "target": target._node._id,
                "sourceHandle": source.handle,
                "targetHandle": target.handle,
            }
        )

        # Trigger lazy trajectory loading when connecting
        # LoadStructure → LoadTrajectory.
        if isinstance(target._node, LoadTrajectory) and isinstance(source._node, LoadStructure):
            self._load_trajectory_data(target._node, source._node)

    # ── Serialization ───────────────────────────────────────

    def to_dict(self) -> dict:
        """Serialize to ``SerializedPipeline`` v3 format."""
        nodes = [config for _, config in self._nodes.values()]
        edges = list(self._edges)
        return {"version": 3, "nodes": nodes, "edges": edges}

    def to_json(self, *, indent: int | None = 2) -> str:
        """Serialize to a JSON string (SerializedPipeline v3).

        Args:
            indent: JSON indentation level (default 2). Pass ``None`` for compact output.

        Returns:
            JSON string representation of the pipeline.
        """
        import json

        return json.dumps(self.to_dict(), indent=indent)

    def save(self, path) -> None:
        """Save the pipeline to a JSON file.

        Args:
            path: Destination file path (``str`` or :class:`pathlib.Path`).
                  Creates or overwrites the file.
        """
        import pathlib

        pathlib.Path(path).write_text(self.to_json(), encoding="utf-8")

    @staticmethod
    def _build_node_from_dict(nd: dict) -> "PipelineNode":
        """Instantiate the correct PipelineNode subclass from a v3 node dict."""
        ntype = nd.get("type")
        if ntype == "load_structure":
            return LoadStructure(nd.get("fileName") or "")
        elif ntype == "load_trajectory":
            import pathlib

            fname = nd.get("fileName") or ""
            ext = pathlib.Path(fname).suffix.lower()
            return LoadTrajectory(
                xtc=fname if ext == ".xtc" else None,
                dcd=fname if ext == ".dcd" else None,
                nc=fname if ext == ".nc" else None,
                traj=fname if ext == ".traj" else None,
                xyz=fname if ext == ".xyz" else None,
                lammpstrj=fname if ext in (".lammpstrj", ".dump", ".trj") else None,
            )
        elif ntype == "filter":
            return Filter(query=nd.get("query", "all"), bond_query=nd.get("bond_query", ""))
        elif ntype == "modify":
            return Modify(scale=nd.get("scale", 1.0), opacity=nd.get("opacity", 1.0))
        elif ntype == "color":
            range_val = nd.get("range")
            return Color(
                mode=nd.get("mode", "uniform"),
                uniform_color=nd.get("uniformColor", "#ff8800"),
                range=tuple(range_val) if range_val is not None else None,
            )
        elif ntype == "representation":
            return Representation(mode=nd.get("mode", "atoms"))
        elif ntype == "symmetry":
            return Symmetry(mode=nd.get("mode", "expand"))
        elif ntype == "wrap":
            return Wrap(mode=nd.get("mode", "none"))
        elif ntype == "replicate":
            return Replicate(nx=nd.get("nx", 1), ny=nd.get("ny", 1), nz=nd.get("nz", 1))
        elif ntype == "drawing_boundary":
            return DrawingBoundary(
                x_min=nd.get("xMin", 0.0),
                x_max=nd.get("xMax", 1.0),
                y_min=nd.get("yMin", 0.0),
                y_max=nd.get("yMax", 1.0),
                z_min=nd.get("zMin", 0.0),
                z_max=nd.get("zMax", 1.0),
            )
        elif ntype == "boundary_completion":
            return BoundaryCompletion(mode=nd.get("mode", "neighbors"))
        elif ntype == "add_bond":
            bond_source = nd.get("bondSource", "distance")
            if bond_source == "file":
                return AddBonds(top=nd.get("bondFileName", ""))
            return AddBonds(source=bond_source)
        elif ntype == "label_generator":
            return AddLabels(source=nd.get("source", "element"))
        elif ntype == "coordination_generator":
            return AddCoordination(
                excluded_centers=nd.get("excludedCenters", []),
                excluded_ligands=nd.get("excludedLigands", []),
                cutoff_tolerance=nd.get("cutoffTolerance", 1.15),
                boundary_mode=nd.get("boundaryMode", "complete"),
            )
        elif ntype == "polyhedron_generator":
            return AddPolyhedra(
                opacity=nd.get("opacity", 0.5),
                show_edges=nd.get("showEdges", False),
                edge_color=nd.get("edgeColor", "#dddddd"),
                edge_width=nd.get("edgeWidth", 3.0),
            )
        elif ntype == "vector_overlay":
            return VectorOverlay(scale=nd.get("scale", 1.0))
        elif ntype == "viewport":
            return Viewport(
                perspective=nd.get("perspective", False),
                cell_axes_visible=nd.get("cellAxesVisible", True),
                pivot_marker_visible=nd.get("pivotMarkerVisible", True),
            )
        elif ntype == "streaming":
            return Streaming()
        elif ntype == "load_vector":
            return LoadVector(nd.get("fileName") or "")
        elif ntype == "load_volumetric":
            return LoadVolumetric(nd.get("fileName") or "")
        elif ntype == "isosurface":
            color_range = nd.get("colorRange")
            return Isosurface(
                iso_level=nd.get("isoLevel", 0.05),
                color=nd.get("color", "#4488ff"),
                opacity=nd.get("opacity", 0.7),
                show_negative=nd.get("showNegative", False),
                negative_color=nd.get("negativeColor", "#ff4444"),
                color_mode=nd.get("colorMode", "solid"),
                colormap=nd.get("colormap", "rwb"),
                color_range=tuple(color_range) if color_range else None,
            )
        elif ntype == "load_spectrum":
            return LoadSpectrum(nd.get("fileName") or "")
        elif ntype == "spectrum_plot":
            return SpectrumPlot(
                reverse_x=nd.get("reverseX", True),
                color=nd.get("color", "#84cc16"),
            )
        else:
            raise ValueError(f"Unknown node type {ntype!r}")

    @classmethod
    def from_dict(cls, d: dict) -> "Pipeline":
        """Reconstruct a Pipeline from a SerializedPipeline v3 dict.

        ``LoadStructure`` file paths in the JSON must still be accessible.
        Relative paths are resolved from the current working directory at call
        time.

        Args:
            d: A dict in ``SerializedPipeline`` v3 format (e.g. from
               :meth:`to_dict`).

        Returns:
            A new :class:`Pipeline` instance ready to pass to
            ``MolecularViewer.set_pipeline()``.

        Raises:
            ValueError: If the dict is not version 3 or contains an unknown
                        node type.
        """
        if d.get("version") != 3:
            raise ValueError(f"Unsupported pipeline version: {d.get('version')!r}. Expected 3.")

        pipe = cls()
        node_by_id: dict[str, PipelineNode] = {}

        for i, nd in enumerate(d.get("nodes", [])):
            if "id" not in nd:
                raise ValueError(f"Node at index {i} is missing required field 'id'.")
            node = cls._build_node_from_dict(nd)
            node._id = nd["id"]
            pipe._nodes[node._id] = (node, pipe._serialize_node(node))
            node_by_id[node._id] = node

            if isinstance(node, LoadStructure) and node.path:
                pipe._load_structure_data(node)

        for i, e in enumerate(d.get("edges", [])):
            for field in ("source", "target", "sourceHandle", "targetHandle"):
                if field not in e:
                    raise ValueError(f"Edge at index {i} is missing required field {field!r}.")
        pipe._edges = [dict(e) for e in d.get("edges", [])]

        # Trigger trajectory loading for LoadStructure → LoadTrajectory edges.
        for edge in pipe._edges:
            target = node_by_id.get(edge["target"])
            source = node_by_id.get(edge["source"])
            if isinstance(target, LoadTrajectory) and isinstance(source, LoadStructure):
                pipe._load_trajectory_data(target, source)

        # Advance counter past any imported IDs to avoid future collisions.
        max_counter = 0
        for nid in pipe._nodes:
            parts = nid.rsplit("-", 1)
            if len(parts) == 2 and parts[1].isdigit():
                max_counter = max(max_counter, int(parts[1]))
        pipe._counter = max_counter

        return pipe

    @classmethod
    def from_json(cls, s: str) -> "Pipeline":
        """Reconstruct a Pipeline from a JSON string.

        Args:
            s: JSON string in ``SerializedPipeline`` v3 format.

        Returns:
            A new :class:`Pipeline` instance.
        """
        import json

        return cls.from_dict(json.loads(s))

    @classmethod
    def load(cls, path) -> "Pipeline":
        """Load a Pipeline from a JSON file saved with :meth:`save`.

        Args:
            path: Path to a JSON file in ``SerializedPipeline`` v3 format
                  (``str`` or :class:`pathlib.Path`).

        Returns:
            A new :class:`Pipeline` instance.
        """
        import pathlib

        return cls.from_json(pathlib.Path(path).read_text(encoding="utf-8"))

    # ── Internal ────────────────────────────────────────────

    def _serialize_node(self, node: PipelineNode) -> dict:
        """Convert a node instance to the TS SerializedPipeline node dict."""
        if node._id is None:
            raise ValueError("Node must be added to the pipeline before serialization.")
        base: dict = {
            "id": node._id,
            "type": node._node_type,
            "position": {"x": 0, "y": 0},
        }

        if isinstance(node, LoadStructure):
            structure = self._structures.get(node._id)
            has_cell = False
            if structure is not None:
                import numpy as np

                has_cell = bool(np.any(structure.box != 0))
            base["fileName"] = node.path
            base["hasTrajectory"] = False
            base["hasCell"] = has_cell
        elif isinstance(node, LoadTrajectory):
            base["fileName"] = node.xtc or node.dcd or node.nc or node.traj or node.xyz or node.lammpstrj
        elif isinstance(node, Streaming):
            base["connected"] = False
        elif isinstance(node, Filter):
            base["query"] = node.query
            base["bond_query"] = node.bond_query
        elif isinstance(node, Modify):
            base["scale"] = node.scale
            base["opacity"] = node.opacity
        elif isinstance(node, Color):
            base["mode"] = node.mode
            base["uniformColor"] = node.uniform_color
            if node.range is not None:
                base["range"] = list(node.range)
        elif isinstance(node, Representation):
            base["mode"] = node.mode
        elif isinstance(node, Symmetry):
            base["mode"] = node.mode
        elif isinstance(node, Wrap):
            base["mode"] = node.mode
        elif isinstance(node, Replicate):
            base["nx"] = node.nx
            base["ny"] = node.ny
            base["nz"] = node.nz
        elif isinstance(node, DrawingBoundary):
            base["xMin"] = node.x_min
            base["xMax"] = node.x_max
            base["yMin"] = node.y_min
            base["yMax"] = node.y_max
            base["zMin"] = node.z_min
            base["zMax"] = node.z_max
        elif isinstance(node, BoundaryCompletion):
            base["mode"] = node.mode
        elif isinstance(node, AddBonds):
            if node.top is not None:
                base["bondSource"] = "file"
                base["bondFileName"] = node.top
                base["bondFileData"] = self._parse_top_bonds(node)
            else:
                base["bondSource"] = node.source
        elif isinstance(node, AddLabels):
            base["source"] = node.source
        elif isinstance(node, AddCoordination):
            base["excludedCenters"] = node.excluded_centers
            base["excludedLigands"] = node.excluded_ligands
            base["cutoffTolerance"] = node.cutoff_tolerance
            base["boundaryMode"] = node.boundary_mode
        elif isinstance(node, AddPolyhedra):
            base["opacity"] = node.opacity
            base["showEdges"] = node.show_edges
            base["edgeColor"] = node.edge_color
            base["edgeWidth"] = node.edge_width
        elif isinstance(node, LoadVector):
            base["fileName"] = node.path
        elif isinstance(node, VectorOverlay):
            base["scale"] = node.scale
        elif isinstance(node, LoadVolumetric):
            base["fileName"] = node.path
        elif isinstance(node, Isosurface):
            base["isoLevel"] = node.iso_level
            base["color"] = node.color
            base["opacity"] = node.opacity
            base["showNegative"] = node.show_negative
            base["negativeColor"] = node.negative_color
            base["colorMode"] = node.color_mode
            base["colormap"] = node.colormap
            if node.color_range is not None:
                base["colorRange"] = list(node.color_range)
        elif isinstance(node, LoadSpectrum):
            base["fileName"] = node.path
        elif isinstance(node, SpectrumPlot):
            base["reverseX"] = node.reverse_x
            base["color"] = node.color
        elif isinstance(node, Viewport):
            base["perspective"] = node.perspective
            base["cellAxesVisible"] = node.cell_axes_visible
            base["pivotMarkerVisible"] = node.pivot_marker_visible

        return base

    @staticmethod
    def _parse_top_bonds(node: AddBonds) -> list[int]:
        """Read a .top or .psf file and return flat bond pairs [a0, b0, a1, b1, ...]."""
        import pathlib

        assert node.top is not None
        ext = pathlib.Path(node.top).suffix.lower()
        if ext == ".psf":
            from megane.parsers.psf import parse_psf_bonds

            bonds = parse_psf_bonds(node.top)
        else:
            from megane.parsers.top import parse_top_bonds

            bonds = parse_top_bonds(node.top)
        return bonds.flatten().tolist()

    def _load_structure_data(self, node: LoadStructure) -> None:
        """Load structure file and store binary snapshot data."""
        from megane.protocol import encode_snapshot

        if node._id is None:
            raise ValueError("Node must be added to the pipeline before loading data.")
        structure = _load_structure_file(node.path)
        self._structures[node._id] = structure
        self._node_data[node._id] = encode_snapshot(structure)

        # Re-serialize to update hasCell
        self._nodes[node._id] = (node, self._serialize_node(node))

    def _load_trajectory_data(
        self,
        node: LoadTrajectory,
        source: LoadStructure,
    ) -> None:
        """Load trajectory object for lazy frame loading."""
        if node._id is None:
            raise ValueError("Node must be added to the pipeline before loading data.")
        if node.xtc is not None:
            from megane.parsers.xtc import load_trajectory

            trajectory = load_trajectory(source.path, node.xtc)
            self._trajectories[node._id] = trajectory
        elif node.dcd is not None:
            from megane.parsers.dcd import load_dcd

            trajectory = load_dcd(node.dcd)
            self._trajectories[node._id] = trajectory
        elif node.nc is not None:
            from megane.parsers.netcdf import load_netcdf

            trajectory = load_netcdf(node.nc)
            self._trajectories[node._id] = trajectory
        elif node.lammpstrj is not None:
            from megane.parsers.lammpstrj import load_lammpstrj

            trajectory = load_lammpstrj(node.lammpstrj)
            self._trajectories[node._id] = trajectory
        elif node.traj is not None:
            from megane.parsers.traj import load_traj

            _, trajectory = load_traj(node.traj)
            self._trajectories[node._id] = trajectory
        elif node.xyz is not None:
            from megane.parsers.xyz import load_xyz_trajectory

            _, trajectory = load_xyz_trajectory(node.xyz)
            self._trajectories[node._id] = trajectory
        else:
            return

        # Update parent LoadStructure's hasTrajectory flag. Only mark true
        # when there is more than one frame — single-frame sources
        # shouldn't advertise a playable trajectory to the frontend.
        if trajectory.n_frames > 1 and source._id is not None and source._id in self._nodes:
            self._nodes[source._id][1]["hasTrajectory"] = True


# ─── Convenience wrappers ────────────────────────────────────────────


def _resolve_bond_source(
    path: str,
    bonds: Literal["auto", "distance", "structure", "file"] | None,
) -> Literal["distance", "structure", "file"] | None:
    """Resolve the ``"auto"`` bond source to the shared per-format default.

    The policy lives in the Rust core (``megane_core::bonds::default_bond_source``)
    and is the same table the webapp's load path uses, so the same file opens
    with the same bonds on every host.
    """
    if bonds != "auto":
        return bonds
    from megane import megane_parser

    return megane_parser.default_bond_source(path)


def view(
    path: str,
    *,
    bonds: Literal["auto", "distance", "structure", "file"] | None = "auto",
    perspective: bool = False,
    cell_axes_visible: bool = True,
) -> "MolecularViewer":
    """Open a molecular viewer for a structure file.

    Builds a minimal pipeline with :class:`LoadStructure` and
    :class:`Viewport` nodes and, when *bonds* is not ``None``
    (the default), an additional :class:`AddBonds` node, then
    returns a :class:`~megane.widget.MolecularViewer` widget.

    Args:
        path: Path to a structure file (PDB, GRO, XYZ, MOL, SDF, MOL2, CIF,
            LAMMPS data, ASE .traj).
        bonds: Bond detection method. ``"auto"`` (default) picks per format —
            ``"structure"`` for formats that embed bonds (PDB, MOL/SDF, LAMMPS
            data, CML, ...), ``"distance"`` otherwise — matching the webapp's
            load path. ``"distance"`` forces VDW-radius inference,
            ``"structure"`` (alias ``"file"``) reads bonds from the loaded
            structure file, ``None`` disables bonds.
        perspective: Use perspective projection instead of orthographic.
        cell_axes_visible: Show unit cell axes.

    Returns:
        A :class:`~megane.widget.MolecularViewer` widget ready for display.

    Example::

        import megane
        viewer = megane.view("protein.pdb")
        viewer  # displays in notebook
    """
    from megane.widget import MolecularViewer

    bonds = _resolve_bond_source(path, bonds)
    pipe = Pipeline()
    s = pipe.add_node(LoadStructure(path))
    # Space-group expansion for CIF asymmetric units, matching the default
    # pipelines of the other hosts. A no-op for structures without ops.
    sym = pipe.add_node(Symmetry())
    v = pipe.add_node(Viewport(perspective=perspective, cell_axes_visible=cell_axes_visible))
    pipe.add_edge(s.out.particle, sym.inp.particle)
    pipe.add_edge(sym.out.particle, v.inp.particle)
    pipe.add_edge(s.out.cell, v.inp.cell)

    if bonds is not None:
        b = pipe.add_node(AddBonds(source=bonds))
        pipe.add_edge(sym.out.particle, b.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)

    viewer = MolecularViewer()
    viewer.set_pipeline(pipe)
    return viewer


def view_traj(
    path: str,
    *,
    xtc: str | None = None,
    traj: str | None = None,
    xyz: str | None = None,
    lammpstrj: str | None = None,
    bonds: Literal["auto", "distance", "structure", "file"] | None = "auto",
    perspective: bool = False,
    cell_axes_visible: bool = True,
) -> "MolecularViewer":
    """Open a molecular viewer with a trajectory.

    Builds a pipeline (LoadStructure → LoadTrajectory → Viewport, with an
    optional AddBonds node when *bonds* is not None) and returns a
    :class:`~megane.widget.MolecularViewer` widget.

    When *path* points to a self-contained trajectory file (``.traj`` or
    multi-frame ``.xyz``) and no explicit trajectory kwarg is provided,
    the trajectory is auto-loaded from that same file.

    Args:
        path: Path to a structure or self-contained trajectory file (PDB,
            GRO, XYZ, MOL, SDF, MOL2, CIF, LAMMPS data, ASE .traj).
        xtc: Path to an XTC trajectory file.
        traj: Path to an ASE ``.traj`` file.
        xyz: Path to a multi-frame XYZ trajectory file.
        bonds: Bond detection method. ``"auto"`` (default) picks per format —
            ``"structure"`` for formats that embed bonds (PDB, MOL/SDF, LAMMPS
            data, CML, ...), ``"distance"`` otherwise — matching the webapp's
            load path. ``"distance"`` forces VDW-radius inference and is
            recomputed per frame during trajectory playback, ``"structure"``
            (alias ``"file"``) reads bonds once from the loaded structure
            file, ``None`` disables bonds.
        perspective: Use perspective projection instead of orthographic.
        cell_axes_visible: Show unit cell axes.

    Returns:
        A :class:`~megane.widget.MolecularViewer` widget ready for display.

    Raises:
        ValueError: If more than one of *xtc*, *traj*, *xyz* is provided,
            or if none is provided and *path* isn't a self-contained
            trajectory file.

    Example::

        import megane
        viewer = megane.view_traj("protein.pdb", xtc="trajectory.xtc")
        viewer = megane.view_traj("trajectory.traj")   # auto-detects .traj
        viewer = megane.view_traj("multiframe.xyz")    # auto-detects .xyz
        viewer.frame_index = 50
    """
    import pathlib

    bonds = _resolve_bond_source(path, bonds)

    if sum(x is not None for x in (xtc, traj, xyz, lammpstrj)) > 1:
        raise ValueError("Only one of 'xtc', 'traj', 'xyz', or 'lammpstrj' can be provided, not multiple.")

    if xtc is None and traj is None and xyz is None and lammpstrj is None:
        ext = pathlib.Path(path).suffix.lower()
        if ext == ".traj":
            traj = path
        elif ext == ".xyz":
            xyz = path
        elif ext in (".lammpstrj", ".dump", ".trj"):
            # Self-contained LAMMPS dump: topology from LoadStructure(path),
            # frames from LoadTrajectory(lammpstrj=path) — same file both ways.
            lammpstrj = path
        else:
            raise ValueError(
                "Either 'xtc', 'traj', 'xyz', or 'lammpstrj' must be provided, "
                "or 'path' must point to a .traj, .xyz, or .lammpstrj/.dump/.trj file. "
                "Use view() for structure-only display."
            )

    from megane.widget import MolecularViewer

    pipe = Pipeline()
    s = pipe.add_node(LoadStructure(path))
    t = pipe.add_node(LoadTrajectory(xtc=xtc, traj=traj, xyz=xyz, lammpstrj=lammpstrj))
    v = pipe.add_node(Viewport(perspective=perspective, cell_axes_visible=cell_axes_visible))

    pipe.add_edge(s.out.particle, t.inp.particle)
    pipe.add_edge(s.out.particle, v.inp.particle)
    pipe.add_edge(s.out.cell, v.inp.cell)
    pipe.add_edge(t.out.traj, v.inp.traj)

    if bonds is not None:
        b = pipe.add_node(AddBonds(source=bonds))
        pipe.add_edge(s.out.particle, b.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)

    viewer = MolecularViewer()
    viewer.set_pipeline(pipe)
    return viewer


def build_pipeline(
    path: str,
    *,
    xtc: str | None = None,
    traj: str | None = None,
    xyz: str | None = None,
    bonds: Literal["auto", "distance", "structure", "file"] | None = "auto",
    top: str | None = None,
    perspective: bool = False,
    cell_axes_visible: bool = True,
    pivot_marker_visible: bool = True,
) -> Pipeline:
    """Build a pipeline for a molecular structure, optionally with a trajectory.

    Constructs a :class:`Pipeline` with :class:`LoadStructure` and
    :class:`Viewport` nodes.  When *xtc*, *traj*, or *xyz* is provided, a
    :class:`LoadTrajectory` node is added.  When *bonds* is not ``None``
    (the default), an :class:`AddBonds` node is included.

    Unlike :func:`view` and :func:`view_traj`, this function returns the
    :class:`Pipeline` directly without creating a widget, making it
    suitable for serialization (via :meth:`Pipeline.to_json`) or further
    programmatic modification.

    Args:
        path: Path to a structure file (PDB, GRO, XYZ, MOL, LAMMPS data,
            ASE .traj).
        xtc: Path to an XTC trajectory file.
        traj: Path to an ASE ``.traj`` file.
        xyz: Path to a multi-frame XYZ trajectory file.
        bonds: Bond detection method. ``"auto"`` (default) picks per format —
            ``"structure"`` for formats that embed bonds (PDB, MOL/SDF, LAMMPS
            data, CML, ...), ``"distance"`` otherwise — matching the webapp's
            load path. ``"distance"`` forces VDW-radius inference,
            ``"structure"`` (alias ``"file"``) reads bonds from the loaded
            structure file, ``None`` disables bonds. Ignored when *top* is
            provided.
        top: Path to a topology file (GROMACS ``.top`` or CHARMM/NAMD ``.psf``)
            for bond definitions.  When provided, overrides *bonds*.
        perspective: Use perspective projection instead of orthographic.
        cell_axes_visible: Show unit cell axes.
        pivot_marker_visible: Show pivot marker in viewport.

    Returns:
        A :class:`Pipeline` instance ready for serialization or
        passing to :meth:`~megane.widget.MolecularViewer.set_pipeline`.

    Raises:
        ValueError: If more than one of *xtc*, *traj*, *xyz* is provided.

    Example::

        import megane

        # Structure only -> JSON
        pipe = megane.build_pipeline("protein.pdb")
        print(pipe.to_json())

        # With trajectory -> save to file
        pipe = megane.build_pipeline("protein.pdb", xtc="trajectory.xtc")
        pipe.save("pipeline.json")

        # With GROMACS topology
        pipe = megane.build_pipeline("protein.pdb", top="topology.top")
        print(pipe.to_json())
    """
    bonds = _resolve_bond_source(path, bonds)
    if sum(x is not None for x in (xtc, traj, xyz)) > 1:
        raise ValueError("Only one of 'xtc', 'traj', or 'xyz' can be provided, not multiple.")

    pipe = Pipeline()
    s = pipe.add_node(LoadStructure(path))
    v = pipe.add_node(
        Viewport(
            perspective=perspective,
            cell_axes_visible=cell_axes_visible,
            pivot_marker_visible=pivot_marker_visible,
        )
    )

    pipe.add_edge(s.out.particle, v.inp.particle)
    pipe.add_edge(s.out.cell, v.inp.cell)

    if xtc is not None or traj is not None or xyz is not None:
        t = pipe.add_node(LoadTrajectory(xtc=xtc, traj=traj, xyz=xyz))
        pipe.add_edge(s.out.particle, t.inp.particle)
        pipe.add_edge(t.out.traj, v.inp.traj)

    if top is not None:
        b = pipe.add_node(AddBonds(top=top))
        pipe.add_edge(s.out.particle, b.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)
    elif bonds is not None:
        b = pipe.add_node(AddBonds(source=bonds))
        pipe.add_edge(s.out.particle, b.inp.particle)
        pipe.add_edge(b.out.bond, v.inp.bond)

    return pipe
