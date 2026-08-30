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
    Filter,
    Modify,
    DrawingBoundary,
    BoundaryCompletion,
    Color,
    Representation,
    AddBonds,
    AddCoordination,
    AddLabels,
    AddPolyhedra,
    Isosurface,
    VectorOverlay,
    Viewport,
    Pipeline,
)
```

:::note
The **Surface Mesh** node (alpha-shape envelope) is available in the visual pipeline editor but does not have a Python class. Use the standalone app, JupyterLab, or VS Code to add it interactively, or author the pipeline JSON directly.
:::

### LoadStructure

Load a molecular structure file.

```python
LoadStructure(path: str)
```

| Parameter | Type  | Description                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`    | `str` | File path. Auto-detected by extension. Supported by the Python-side parser: `.pdb`, `.gro`, `.xyz`, `.mol`, `.sdf` (routed through the MOL parser), `.mol2`, `.cif`, `.data`, `.lammps`, `.traj` (ASE binary). The browser-side (WASM) parser additionally accepts `.mmcif` and `.prmtop` (AMBER topology) when the pipeline runs inside `MolecularViewer`. |

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
)
```

| Parameter   | Type          | Default | Description                                             |
| ----------- | ------------- | ------- | ------------------------------------------------------- |
| `xtc`       | `str \| None` | `None`  | Path to XTC trajectory file                             |
| `dcd`       | `str \| None` | `None`  | Path to DCD trajectory file (CHARMM/NAMD/X-PLOR)        |
| `nc`        | `str \| None` | `None`  | Path to AMBER NetCDF trajectory file                    |
| `traj`      | `str \| None` | `None`  | Path to ASE `.traj` trajectory file                     |
| `xyz`       | `str \| None` | `None`  | Path to a multi-frame XYZ trajectory file               |
| `lammpstrj` | `str \| None` | `None`  | Path to LAMMPS dump trajectory (`.lammpstrj` / `.dump`) |

Pass exactly one. **Ports:** `inp.particle`, `out.traj`

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

Load a Gaussian CUBE file and output volumetric data for isosurface rendering.

```python
LoadVolumetric(path: str = "")
```

| Parameter | Type  | Description                                                                                                     |
| --------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `path`    | `str` | File path to a Gaussian CUBE file (`.cube`). Parsed in the browser; the Python object only tracks the filename. |

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
density = LoadVolumetric("density.cube")
esp = LoadVolumetric("esp.cube")
iso = Isosurface(iso_level=0.02, color_mode="volume", colormap="rwb")
pipe.add_edge(density.out.volumetric, iso.inp.volumetric)
pipe.add_edge(esp.out.volumetric, iso.inp.color_volumetric)
pipe.add_edge(iso.out.mesh, viewport.inp.mesh)
```

### Filter

Select atoms by a query expression.

```python
Filter(*, query: str = "all", bond_query: str = "")
```

| Parameter    | Type  | Default | Description                                                                                                                |
| ------------ | ----- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `query`      | `str` | `"all"` | Atom selection expression (see [Filter DSL](./index.md#filter-dsl))                                                        |
| `bond_query` | `str` | `""`    | Bond selection expression (see [Bond Selection DSL](./index.md#bond-selection-dsl)). Empty string means no bond filtering. |

**Ports:** `inp.particle`, `out.particle`

### Modify

Override per-atom visual properties.

```python
Modify(*, scale: float = 1.0, opacity: float = 1.0)
```

| Parameter | Type    | Default | Description                              |
| --------- | ------- | ------- | ---------------------------------------- |
| `scale`   | `float` | `1.0`   | Atom sphere radius multiplier (0.1–2.0)  |
| `opacity` | `float` | `1.0`   | Transparency (0 = invisible, 1 = opaque) |

**Ports:** `inp.particle`, `out.particle`

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
display. Stacks Ovito-style: the Viewport reads the override from the first
particle stream that carries one, so a downstream `Representation` node
wins over an upstream one on the same chain. When no chain has an override,
the Viewport falls back to `"atoms"`.

```python
Representation(
    *,
    mode: Literal["atoms", "licorice", "cartoon", "both", "surface", "line", "illustrative"] = "atoms",
)
```

| Parameter | Type  | Default   | Description                                                                                                                                                                                                                                                                                        |
| --------- | ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `str` | `"atoms"` | Visual representation: `"atoms"` (ball-and-stick), `"licorice"` (equal-radius continuous sticks), `"cartoon"`, `"both"`, `"surface"`, `"line"` (thin wireframe), or `"illustrative"` (Mol\*-style spacefill spheres shaded toward each sphere's rim, with a dark silhouette outline, bonds hidden) |

**Ports:** `inp.particle`, `out.particle`

### AddBonds

Compute and display bonds.

```python
AddBonds(*, source: Literal["distance", "structure", "file"] = "distance", top: str | None = None)
```

| Parameter | Type          | Default      | Description                                                                                                                                   |
| --------- | ------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`  | `str`         | `"distance"` | `"distance"` for VDW-based inference; `"structure"` (alias `"file"`) to read bonds from the structure file (e.g. CONECT records in PDB)       |
| `top`     | `str \| None` | `None`       | Path to a topology file (GROMACS `.top` or CHARMM/NAMD `.psf`). When provided, `source` is ignored and bonds are read from the topology file. |

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
bounds without changing structural atom indices or enlarging the cell.

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

### VectorOverlay

Configure per-atom vector visualization (e.g. forces, velocities).

```python
VectorOverlay(*, scale: float = 1.0)
```

| Parameter | Type    | Default | Description                    |
| --------- | ------- | ------- | ------------------------------ |
| `scale`   | `float` | `1.0`   | Vector arrow length multiplier |

**Ports:** `inp.vector`, `out.vector`

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
