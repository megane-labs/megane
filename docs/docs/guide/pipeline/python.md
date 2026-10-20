---
sidebar_label: Python
---

# Python Pipeline API

For simple visualization, use the convenience wrappers `megane.view()` and `megane.view_traj()`:

```python
import megane

viewer = megane.view("protein.pdb")                                     # structure
viewer = megane.view_traj("protein.pdb", xtc="trajectory.xtc")         # with trajectory
```

Both pick the bond source per format by default (`bonds="auto"`), and both insert a `Symmetry` node so a CIF asymmetric unit is expanded to the full cell (with a trajectory connected, the structure passes through unexpanded so the frames still match). `megane.build_pipeline(path, ...)` builds the same minimal pipeline but returns the `Pipeline` itself instead of a widget, for saving to JSON or further editing.

When you need more control — filtering atoms, multi-layer rendering, labels, polyhedra, or custom styling — build a pipeline manually with the `Pipeline` class.

For real-world examples, see the [Gallery](/gallery).

## Overview

```python
from megane import Pipeline, LoadStructure, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("protein.pdb"))  # returns node with .out/.inp
v = pipe.add_node(Viewport())
pipe.add_edge(s.out.particle, v.inp.particle)    # connect explicit ports

viewer = MolecularViewer()
viewer.set_pipeline(pipe)   # apply to viewer
viewer                      # display in notebook
```

After `add_node()`, each node exposes `.out` and `.inp` namespaces for its ports. Pass these port objects to `add_edge()` to wire nodes together explicitly. The pipeline serializes to the `SerializedPipeline` v3 JSON format. A `Viewport` node must be explicitly added and connected for data to be rendered.

## Pipeline class

| Method                               | Description                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `add_node(node)`                     | Add a node to the pipeline. Returns the node (with `.out`/`.inp` ports) for use in `add_edge()` |
| `add_edge(source_port, target_port)` | Connect `source.out.<name>` → `target.inp.<name>`                                               |
| `to_dict()`                          | Serialize to v3 JSON dict                                                                       |
| `to_json(indent=2)`                  | Serialize to a JSON string                                                                      |
| `save(path)`                         | Save the pipeline to a JSON file                                                                |
| `Pipeline.from_dict(d)`              | Reconstruct a Pipeline from a v3 dict                                                           |
| `Pipeline.from_json(s)`              | Reconstruct a Pipeline from a JSON string                                                       |
| `Pipeline.load(path)`                | Load a Pipeline from a JSON file                                                                |

## Node classes

All node classes are importable from `megane`:

```python
from megane import (
    LoadStructure,
    LoadTrajectory,
    Streaming,
    LoadVector,
    LoadVolumetric,
    LoadSpectrum,
    Filter,
    Modify,
    Symmetry,
    Wrap,
    Replicate,
    DrawingBoundary,
    BoundaryCompletion,
    Color,
    Representation,
    AddBonds,
    AddCoordination,
    AddLabels,
    AddPolyhedra,
    SurfaceMesh,
    Isosurface,
    VectorOverlay,
    SpectrumPlot,
    Viewport,
    Pipeline,
)
```

Every node type of the visual pipeline editor has a Python class, so
`Pipeline.from_dict()` / `Pipeline.load()` can read any pipeline the editor
saves, and `to_dict()` / `save()` write it back with every node's parameters,
its `position` in the editor, and its `enabled` flag. Each node object carries
those two as attributes too — `node.enabled = False` disables a node (it passes
its input through) and `node.position = {"x": 0, "y": 200}` places it in the
editor; set them before `add_node()`, which records the node's settings.

### LoadStructure

Load a molecular structure file.

```python
LoadStructure(path: str, *, edits: list[dict] | None = None, file_url: str | None = None)
```

| Parameter | Type                 | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`    | `str`                | —       | File path, read when the node is added. Auto-detected by extension: `.pdb`, `.gro`, `.xyz` / `.extxyz` / `.jxyz`, `.mol`, `.sdf`, `.mol2`, `.cif`, `.mmcif`, `.data` / `.lammps` (LAMMPS data), `.lammpstrj` / `.dump` / `.trj` (LAMMPS dump, frame 0), `.prmtop`, `.vasp` and bare `POSCAR` / `CONTCAR` / `XDATCAR` names, `.cml`, `.molden`, `.xsf` / `.axsf`, `.c3xml`, `.odydata` / `.xodydata`, `.magres`, `.gamess`, `.phonon`, and `.traj` (ASE binary). |
| `edits`   | `list[dict] \| None` | `None`  | Structure edits replayed on the file as loaded — the same edit history the [Megane Builder](../builder.md#history) writes (`add_atom`, `delete_atoms`, `move_atoms`, `set_element`, `add_bond`, `delete_bond`, `add_fragment`, `set_cell`, `supercell`, `slab`, `expand_symmetry`, `wrap`, `center`). Atom references are file atom indices (`int`) or the `id` of an atom an earlier op created (`str`).                                                                                         |
| `file_url` | `str \| None`       | `None`  | URL the React [`PipelineViewer`](./typescript.md) fetches the file from (written as `fileUrl`). The widget ignores it. |

```python
LoadStructure("water.pdb", edits=[
    {"op": "delete_atoms", "atoms": [5, 6]},
    {"op": "add_bond", "a": 0, "b": 1, "order": 2},
])
```

**Ports:** `out.particle`, `out.traj`, `out.cell`

### LoadTrajectory

Load an external trajectory file. Requires connection from a `LoadStructure` node.

```python
LoadTrajectory(
    *,
    xtc: str | None = None,
    dcd: str | None = None,
    nc: str | None = None,
    traj: str | None = None,
    xyz: str | None = None,
    lammpstrj: str | None = None,
    source: Literal["file", "structure"] = "file",
)
```

| Parameter   | Type          | Default | Description                                             |
| ----------- | ------------- | ------- | ------------------------------------------------------- |
| `xtc`       | `str \| None` | `None`  | Path to XTC trajectory file                             |
| `dcd`       | `str \| None` | `None`  | Path to DCD trajectory file (CHARMM/NAMD/X-PLOR)        |
| `nc`        | `str \| None` | `None`  | Path to AMBER NetCDF trajectory file                    |
| `traj`      | `str \| None` | `None`  | Path to ASE `.traj` trajectory file                     |
| `xyz`       | `str \| None` | `None`  | Path to a multi-frame XYZ (or extended XYZ) trajectory file      |
| `lammpstrj` | `str \| None` | `None`  | Path to LAMMPS dump trajectory (`.lammpstrj` / `.dump` / `.trj`) |
| `source`    | `str`         | `"file"` | `"file"` plays the file given above; `"structure"` forwards the frames embedded in the structure file itself (multi-frame XYZ / PDB / `.traj`), as the editor sets it when such a file is opened |

Pass exactly one file (or none with `source="structure"`). **Ports:** `inp.particle`, `out.traj`

### Streaming

WebSocket-based real-time data delivery.

```python
Streaming()
```

No parameters. **Ports:** `out.particle`, `out.bond`, `out.traj`, `out.cell`

### LoadVector

Load per-atom vector data from a file.

```python
LoadVector(path: str)
```

| Parameter | Type  | Description              |
| --------- | ----- | ------------------------ |
| `path`    | `str` | Path to vector data file |

**Ports:** `out.vector`

### LoadVolumetric

Load a volumetric grid file and output volumetric data for isosurface rendering.

```python
LoadVolumetric(path: str = "")
```

| Parameter | Type  | Description                                                                                                     |
| --------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `path`    | `str` | File path to a Gaussian CUBE (`.cube` / `.cub`) or OpenDX (`.dx`) grid. Parsed in the browser; the Python object only tracks the filename. |

**Ports:** `out.volumetric`

### Isosurface

Extract an isosurface from volumetric data using marching cubes.

```python
Isosurface(
    *,
    iso_level: float = 0.05,
    color: str = "#4488ff",
    opacity: float = 0.7,
    show_negative: bool = False,
    negative_color: str = "#ff4444",
    color_mode: str = "solid",
    colormap: str = "rwb",
    color_range: tuple[float, float] | None = None,
)
```

| Parameter        | Type                          | Default     | Description                                                                              |
| ---------------- | ----------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `iso_level`      | `float`                       | `0.05`      | Contour value for the positive isosurface                                                |
| `color`          | `str`                         | `"#4488ff"` | Hex color for the positive isosurface                                                    |
| `opacity`        | `float`                       | `0.7`       | Surface transparency (0–1)                                                               |
| `show_negative`  | `bool`                        | `False`     | Show a second isosurface at −iso_level (dual-contour for ESP maps)                       |
| `negative_color` | `str`                         | `"#ff4444"` | Hex color for the negative isosurface                                                    |
| `color_mode`     | `str`                         | `"solid"`   | `"volume"` paints the surface by sampling the volume connected to `inp.color_volumetric` |
| `colormap`       | `str`                         | `"rwb"`     | `"rwb"` (red→white→blue, chemistry ESP convention), `"bwr"`, or `"rainbow"`              |
| `color_range`    | `tuple[float, float] \| None` | `None`      | Explicit colormap range; `None` = auto (symmetric around 0 for the diverging maps)       |

**Ports:** `inp.volumetric`, `inp.color_volumetric`, `out.mesh`

To render an ESP-mapped charge density, load both cubes and connect the ESP
volume to the coloring input:

```python
density = pipe.add_node(LoadVolumetric("density.cube"))
esp = pipe.add_node(LoadVolumetric("esp.cube"))
iso = pipe.add_node(Isosurface(iso_level=0.02, color_mode="volume", colormap="rwb"))
v = pipe.add_node(Viewport())
pipe.add_edge(density.out.volumetric, iso.inp.volumetric)
pipe.add_edge(esp.out.volumetric, iso.inp.color_volumetric)
pipe.add_edge(iso.out.mesh, v.inp.mesh)
```

### Filter

Select atoms by a query expression.

```python
Filter(*, query: str = "all", bond_query: str = "")
```

| Parameter    | Type  | Default | Description                                                                                                                                                                             |
| ------------ | ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`      | `str` | `"all"` | Atom selection expression (see [Filter DSL](./index.md#filter-dsl)). `"all"` and `""` both select every atom; a pipeline JSON node without `query` loads as `""`, the editor's default. |
| `bond_query` | `str` | `""`    | Bond selection expression (see [Bond Selection DSL](./index.md#bond-selection-dsl)). Empty string means no bond filtering.                                                              |

**Ports:** `inp.particle`, `out.particle`

### Modify

Override per-atom visual properties.

```python
Modify(*, scale: float = 1.0, opacity: float = 1.0)
```

| Parameter | Type    | Default | Description                              |
| --------- | ------- | ------- | ---------------------------------------- |
| `scale`   | `float` | `1.0`   | Atom sphere radius multiplier (0.1–2.0); on a bond stream, the bond width multiplier for the whole stream |
| `opacity` | `float` | `1.0`   | Transparency (0 = invisible, 1 = opaque) |

**Ports:** `inp.particle`, `out.particle`

### Symmetry

Expand a crystallographic asymmetric unit into the full unit cell using the
space-group operations the parser captured (a CIF `_symmetry_equiv_pos_as_xyz`
loop), replicating bonds per image and dropping coincident images.
`megane.view()`, `megane.view_traj()` and `megane.build_pipeline()` insert this
node automatically. While a trajectory is connected to `inp.traj` the structure
passes through unexpanded, so the frames keep matching its atoms.

```python
Symmetry(*, mode: Literal["expand", "none"] = "expand")
```

| Parameter | Type  | Default    | Description                                                                                                                       |
| --------- | ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `str` | `"expand"` | `"expand"` fills the unit cell; `"none"` passes the asymmetric unit through. Structures without symmetry ops or a cell pass through unchanged. |

**Ports:** `inp.particle`, `inp.traj`, `out.particle`, `out.traj`

### Wrap

Remap coordinates by whole lattice vectors.

```python
Wrap(*, mode: Literal["none", "wrap", "unwrap"] = "none")
```

| Parameter | Type  | Default  | Description                                                                                                                                                                    |
| --------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`    | `str` | `"none"` | `"wrap"` folds every atom into the home cell; `"unwrap"` makes bonded molecules that straddle a periodic face whole; `"none"` passes coordinates through. Requires a unit cell. |

A connected trajectory is remapped per frame. **Ports:** `inp.particle`, `inp.traj`, `out.particle`, `out.traj`

### Replicate

Build an `nx × ny × nz` supercell: every atom (and its bonds) is copied into the
cell images along +a/+b/+c and the cell is enlarged. Requires a unit cell.

```python
Replicate(*, nx: int = 1, ny: int = 1, nz: int = 1)
```

| Parameter        | Type  | Default | Description                                  |
| ---------------- | ----- | ------- | -------------------------------------------- |
| `nx`, `ny`, `nz` | `int` | `1`     | Number of cell images along a / b / c (≥ 1) |

A connected trajectory is replicated per frame. **Ports:** `inp.particle`, `inp.cell`, `inp.traj`, `out.particle`, `out.cell`, `out.traj`

### Color

Recolor the upstream particle stream by a chosen scheme. Color was split out
of `Modify` so each modifier owns a single visual property (Ovito-style
modifier stack).

```python
Color(
    *,
    mode: Literal[
        "uniform", "byElement", "byResidue", "byChain", "byBFactor", "byProperty", "illustrative"
    ] = "uniform",
    uniform_color: str = "#ff8800",
    range: tuple[float, float] | None = None,
)
```

| Parameter       | Type                          | Default     | Description                                                                                                                                            |
| --------------- | ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`          | `str`                         | `"uniform"` | Coloring scheme. `"illustrative"` is Goodsell-style: every atom takes a soft pastel color for its chain, with carbon a lighter shade of the same color |
| `uniform_color` | `str`                         | `"#ff8800"` | Hex color used when `mode == "uniform"`                                                                                                                |
| `range`         | `tuple[float, float] \| None` | `None`      | Optional explicit range for `byBFactor` / `byProperty`                                                                                                 |

**Ports:** `inp.particle`, `out.particle`

### Representation

Tag the particle stream with the visual representation the Viewport should
display. Stacks Ovito-style: a downstream `Representation` node wins over an
upstream one on the same chain. The Viewport resolves the mode per atom: each
atom takes the mode of the first stream that covers it and carries an override,
with selection (filtered) streams taking precedence over whole-structure
streams. Atoms no override covers use the first non-`"line"` override, or
`"atoms"` when no stream carries one, so branches that disagree are drawn per
atom.

```python
Representation(
    *,
    mode: Literal["atoms", "licorice", "cartoon", "both", "surface", "line", "illustrative"] = "atoms",
)
```

| Parameter | Type  | Default   | Description                                                                                                                                                                                                                                                                                        |
| --------- | ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `str` | `"atoms"` | Visual representation: `"atoms"` (ball-and-stick), `"licorice"` (equal-radius continuous sticks), `"cartoon"`, `"both"` (cartoon drawn over atoms and bonds), `"surface"`, `"line"` (thin wireframe), or `"illustrative"` (Mol\*-style spacefill spheres shaded toward each sphere's rim, with a dark silhouette outline, bonds hidden) |

**Ports:** `inp.particle`, `out.particle`

### AddBonds

Compute and display bonds.

```python
AddBonds(
    *,
    source: Literal["distance", "structure", "file"] = "distance",
    top: str | None = None,
    vdw_scale: float | None = None,
)
```

| Parameter | Type          | Default      | Description                                                                                                                                   |
| --------- | ------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | `str`         | `"distance"` | `"distance"` for VDW-based inference; `"structure"` (alias `"file"`) to read bonds from the structure file (e.g. CONECT records in PDB)       |
| `top`     | `str \| None` | `None`       | Path to a topology file (GROMACS `.top` or CHARMM/NAMD `.psf`). When provided, `source` is ignored and bonds are read from the topology file; their parsed pairs are written into the JSON as `bondFileData`. |
| `vdw_scale` | `float \| None` | `None` | Threshold scale for distance inference (written as `vdwScale`): atoms bond when their separation is `≤ (vdw_i + vdw_j) * vdw_scale`. `None` uses the viewer's default, `0.6`. |

**Ports:** `inp.particle`, `out.bond`

### AddLabels

Generate text labels at atom positions.

```python
AddLabels(*, source: Literal["element", "resname", "index"] = "element")
```

| Parameter | Type  | Default     | Description                                          |
| --------- | ----- | ----------- | ---------------------------------------------------- |
| `source`  | `str` | `"element"` | Label source: `"element"`, `"resname"`, or `"index"` |

**Ports:** `inp.particle`, `out.label`

### DrawingBoundary

```python
DrawingBoundary(
    *, x_min: float = 0.0, x_max: float = 1.0,
    y_min: float = 0.0, y_max: float = 1.0,
    z_min: float = 0.0, z_max: float = 1.0,
)
```

Drawing Boundary creates periodic display copies inside inclusive fractional
bounds without changing structural atom indices or enlarging the cell (use
`Replicate` for a real supercell).

**Ports:** `inp.particle`, `out.particle`

### BoundaryCompletion

```python
BoundaryCompletion(*, mode: Literal["neighbors", "components"] = "neighbors")
```

Adds bond-connected periodic display copies without changing crystallographic
coordinates. `"neighbors"` completes one bond shell. `"components"` completes
finite connected components, but deliberately leaves infinite periodic
networks unexpanded.

**Ports:** `inp.particle`, `inp.bond`, `out.particle`, `out.bond`

### AddCoordination

```python
AddCoordination(
    *,
    excluded_centers: list[int] | None = None,
    excluded_ligands: list[int] | None = None,
    cutoff_tolerance: float = 1.15,
    boundary_mode: Literal["inside", "complete"] = "complete",
)
```

Coordination detects relationships between center atoms and their bonded
neighbors. With `boundary_mode="complete"`, center atoms stay inside Drawing
Boundary while missing periodic images of their neighbors may be added outside
it to complete the visible coordination environment.

**Ports:** `inp.particle`, `out.coordination`, `out.bond`

### AddPolyhedra

Convert directed center-neighbor coordination data to convex polyhedron meshes.
Periodic atom display and completing neighbors outside the drawing range belong
to the two upstream nodes.

```python
AddPolyhedra(
    *,
    opacity: float = 0.5,
    show_edges: bool = False,
    edge_color: str = "#dddddd",
    edge_width: float = 3.0,
)
```

| Parameter    | Type    | Default     | Description                |
| ------------ | ------- | ----------- | -------------------------- |
| `opacity`    | `float` | `0.5`       | Face transparency (0–1)    |
| `show_edges` | `bool`  | `False`     | Display wireframe edges    |
| `edge_color` | `str`   | `"#dddddd"` | Wireframe edge color (hex) |
| `edge_width` | `float` | `3.0`       | Wireframe edge width (px)  |

**Ports:** `inp.coordination`, `out.mesh`

### SurfaceMesh

Wrap the atoms in an OVITO-style alpha-shape surface envelope. The mesh is
computed in the browser from the incoming atom positions; the Python object
only carries the parameters.

```python
SurfaceMesh(*, alpha_radius: float = 3.0, color: str = "#4488ff", opacity: float = 0.5)
```

| Parameter      | Type    | Default     | Description                                                         |
| -------------- | ------- | ----------- | ------------------------------------------------------------------- |
| `alpha_radius` | `float` | `3.0`       | Probe sphere radius in Å (larger = smoother, smaller = more detail) |
| `color`        | `str`   | `"#4488ff"` | Surface color (hex)                                                 |
| `opacity`      | `float` | `0.5`       | Surface transparency (0–1)                                          |

```python
from megane import Pipeline, LoadStructure, SurfaceMesh, Viewport

pipe = Pipeline()
s = pipe.add_node(LoadStructure("au_nanoparticle.xyz"))
surf = pipe.add_node(SurfaceMesh(alpha_radius=3.0, opacity=0.4))
v = pipe.add_node(Viewport())
pipe.add_edge(s.out.particle, surf.inp.particle)
pipe.add_edge(s.out.particle, v.inp.particle)
pipe.add_edge(surf.out.mesh, v.inp.mesh)
```

**Ports:** `inp.particle`, `out.mesh`

### VectorOverlay

Configure per-atom vector visualization (e.g. forces, velocities).

```python
VectorOverlay(*, scale: float = 1.0)
```

| Parameter | Type    | Default | Description                    |
| --------- | ------- | ------- | ------------------------------ |
| `scale`   | `float` | `1.0`   | Vector arrow length multiplier |

**Ports:** `inp.vector`, `out.vector`

### LoadSpectrum / SpectrumPlot

Load a JCAMP-DX spectrum (`.jdx` / `.jcamp`) and draw it as a 2D line chart.
A spectrum has no 3D coordinates, so it feeds `SpectrumPlot` (a terminal node)
rather than `Viewport`. The file is decoded in the browser; the Python object
only tracks the filename.

```python
LoadSpectrum(path: str = "")
SpectrumPlot(*, reverse_x: bool = True, color: str = "#84cc16")
```

| Parameter   | Type   | Default     | Description                                                  |
| ----------- | ------ | ----------- | ------------------------------------------------------------ |
| `path`      | `str`  | `""`        | Path to the JCAMP-DX file (`LoadSpectrum`)                   |
| `reverse_x` | `bool` | `True`      | Draw the abscissa high-to-low, the IR / NMR convention       |
| `color`     | `str`  | `"#84cc16"` | Hex stroke color of the trace                                |

**Ports:** `LoadSpectrum` — `out.spectrum`; `SpectrumPlot` — `inp.spectrum`

### Viewport

3D rendering output node. All data to be rendered must be explicitly connected to this node.

```python
Viewport(*, perspective: bool = False, cell_axes_visible: bool = True, pivot_marker_visible: bool = True)
```

| Parameter              | Type   | Default | Description                                         |
| ---------------------- | ------ | ------- | --------------------------------------------------- |
| `perspective`          | `bool` | `False` | Toggle perspective / orthographic projection        |
| `cell_axes_visible`    | `bool` | `True`  | Show simulation cell axes with labels               |
| `pivot_marker_visible` | `bool` | `True`  | Show the rotation pivot marker at the camera target |

**Ports:** `inp.particle`, `inp.bond`, `inp.cell`, `inp.traj`, `inp.label`, `inp.mesh`, `inp.vector`

## Ports

After `add_node()`, each node exposes two port namespaces:

- `node.out.<name>` — output port (pass as first arg to `add_edge`)
- `node.inp.<name>` — input port (pass as second arg to `add_edge`)

The port name `.traj` maps to the `"trajectory"` wire handle internally. Accessing an undefined port raises `AttributeError` with a helpful message listing available ports.

## Example: Basic Structure with Bonds

```python
from megane import Pipeline, LoadStructure, AddBonds, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("protein.pdb"))
bonds = pipe.add_node(AddBonds(source="distance"))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, bonds.inp.particle)
pipe.add_edge(s.out.particle, v.inp.particle)
pipe.add_edge(bonds.out.bond, v.inp.bond)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```

## Example: Filter and Modify

```python
from megane import Pipeline, LoadStructure, Filter, Modify, AddBonds, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("protein.pdb"))
carbons = pipe.add_node(Filter(query="element == 'C'"))
big = pipe.add_node(Modify(scale=1.5, opacity=0.8))
bonds = pipe.add_node(AddBonds(source="distance"))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, carbons.inp.particle)
pipe.add_edge(carbons.out.particle, big.inp.particle)
pipe.add_edge(s.out.particle, bonds.inp.particle)
pipe.add_edge(big.out.particle, v.inp.particle)
pipe.add_edge(bonds.out.bond, v.inp.bond)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```

## Example: Trajectory Playback

```python
from megane import Pipeline, LoadStructure, LoadTrajectory, AddBonds, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("protein.pdb"))
t = pipe.add_node(LoadTrajectory(xtc="trajectory.xtc"))
bonds = pipe.add_node(AddBonds(source="structure"))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, t.inp.particle)
pipe.add_edge(s.out.particle, bonds.inp.particle)
pipe.add_edge(s.out.particle, v.inp.particle)
pipe.add_edge(t.out.traj, v.inp.traj)
pipe.add_edge(bonds.out.bond, v.inp.bond)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer.frame_index = 50  # jump to frame 50
```

Frames stay in the kernel and are sent as they are shown. Pass
`set_pipeline(pipe, embed_trajectory=True)` (or `"auto"`, which embeds only
when the encoded frames are small enough) to send every frame to the front end
so playback works without a running kernel.

## Example: Make Solvent Translucent

```python
from megane import Pipeline, LoadStructure, Filter, Modify, AddBonds, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("protein.pdb"))

# Filter water molecules and make them translucent
water = pipe.add_node(Filter(query='resname == "HOH"'))
transparent = pipe.add_node(Modify(scale=0.5, opacity=0.2))

bonds = pipe.add_node(AddBonds(source="distance"))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, water.inp.particle)
pipe.add_edge(water.out.particle, transparent.inp.particle)
pipe.add_edge(s.out.particle, bonds.inp.particle)
pipe.add_edge(s.out.particle, v.inp.particle)       # protein particle + cell
pipe.add_edge(transparent.out.particle, v.inp.particle)  # translucent water
pipe.add_edge(bonds.out.bond, v.inp.bond)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```

## Example: TiO₆ Coordination Polyhedra

```python
from megane import (
    Pipeline, LoadStructure, DrawingBoundary, AddCoordination,
    AddPolyhedra, Viewport, MolecularViewer,
)

pipe = Pipeline()
s = pipe.add_node(LoadStructure("SrTiO3_supercell.pdb"))
boundary = pipe.add_node(DrawingBoundary())
coordination = pipe.add_node(AddCoordination(
    excluded_centers=[38],  # exclude Sr; Ti (22) is kept
    boundary_mode="complete",
))
polyhedra = pipe.add_node(AddPolyhedra(opacity=0.5, show_edges=True))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, boundary.inp.particle)
pipe.add_edge(boundary.out.particle, coordination.inp.particle)
pipe.add_edge(boundary.out.particle, v.inp.particle)
pipe.add_edge(coordination.out.coordination, polyhedra.inp.coordination)
pipe.add_edge(coordination.out.bond, v.inp.bond)
pipe.add_edge(polyhedra.out.mesh, v.inp.mesh)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```

## Example: DAG Branching (Multiple Filters)

```python
from megane import Pipeline, LoadStructure, Filter, AddLabels, AddBonds, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("protein.pdb"))

# Two independent filters from the same source
carbon = pipe.add_node(Filter(query="element == 'C'"))
nitrogen = pipe.add_node(Filter(query="element == 'N'"))
labels = pipe.add_node(AddLabels(source="element"))
bonds = pipe.add_node(AddBonds(source="distance"))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, carbon.inp.particle)
pipe.add_edge(s.out.particle, nitrogen.inp.particle)
pipe.add_edge(s.out.particle, labels.inp.particle)
pipe.add_edge(s.out.particle, bonds.inp.particle)
pipe.add_edge(carbon.out.particle, v.inp.particle)
pipe.add_edge(nitrogen.out.particle, v.inp.particle)
pipe.add_edge(labels.out.label, v.inp.label)
pipe.add_edge(bonds.out.bond, v.inp.bond)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```

## Example: Multiple Structure Layers

```python
from megane import Pipeline, LoadStructure, AddBonds, Viewport, MolecularViewer

pipe = Pipeline()
protein = pipe.add_node(LoadStructure("protein.pdb"))
ligand = pipe.add_node(LoadStructure("ligand.mol"))
bonds_p = pipe.add_node(AddBonds(source="distance"))
bonds_l = pipe.add_node(AddBonds(source="structure"))
v = pipe.add_node(Viewport())

pipe.add_edge(protein.out.particle, bonds_p.inp.particle)
pipe.add_edge(ligand.out.particle, bonds_l.inp.particle)
pipe.add_edge(protein.out.particle, v.inp.particle)
pipe.add_edge(bonds_p.out.bond, v.inp.bond)
pipe.add_edge(ligand.out.particle, v.inp.particle)
pipe.add_edge(bonds_l.out.bond, v.inp.bond)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```

## Example: ASE .traj Trajectory

```python
from megane import Pipeline, LoadStructure, LoadTrajectory, Viewport, MolecularViewer

pipe = Pipeline()
s = pipe.add_node(LoadStructure("structure.pdb"))
t = pipe.add_node(LoadTrajectory(traj="simulation.traj"))
v = pipe.add_node(Viewport())

pipe.add_edge(s.out.particle, t.inp.particle)
pipe.add_edge(s.out.particle, v.inp.particle)
pipe.add_edge(t.out.traj, v.inp.traj)

viewer = MolecularViewer()
viewer.set_pipeline(pipe)
viewer
```
