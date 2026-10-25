---
sidebar_label: TypeScript
---

# TypeScript Pipeline API

Pipelines can be built programmatically in JavaScript/TypeScript using the `Pipeline` builder. The API mirrors the [Python interface](./python.md) — same node names, same port names, same `SerializedPipeline` v3 output — making it straightforward to port pipelines between languages. The TypeScript builder has a class for every pipeline node type; see [Differences from Python](#differences-from-python) for the few API differences.

For real-world examples, see the [Gallery](/gallery).

## Overview

```typescript
import { Pipeline, LoadStructure, AddBonds, ViewportNode } from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("protein.pdb"));
const b = pipe.addNode(new AddBonds());
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, b.inp.particle);
pipe.addEdge(s.out.particle, v.inp.particle);
pipe.addEdge(b.out.bond, v.inp.bond);

// Serialize to JSON
const json = pipe.toJSON();
const obj = pipe.toObject();
```

Render the pipeline in React with `PipelineViewer`:

```tsx
import { PipelineViewer } from "megane-viewer/lib";

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```

After `addNode()`, each node exposes `.out` and `.inp` accessors for its ports. Pass these `NodePort` objects to `addEdge()` to wire nodes together. The pipeline serializes to the same `SerializedPipeline` v3 format used by the TypeScript engine — `toObject()` output can be passed directly to `deserializePipeline()`.

A node's parameters are captured when it is added, so set them in the constructor; changing a field after `addNode()` does not change the serialized pipeline. Adding the same node instance twice throws.

## Pipeline class

| Method                            | Description                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `addNode(node)`                   | Add a node to the pipeline. Returns the same node (with `.out`/`.inp` ports) for use in `addEdge()` |
| `addEdge(sourcePort, targetPort)` | Connect `node.out.<name>` → `node.inp.<name>`                                                       |
| `toObject()`                      | Serialize to v3 plain object (`SerializedPipeline`)                                                 |
| `toJSON(indent?)`                 | Serialize to a JSON string (default indent = 2)                                                     |

## Node classes

All node classes are importable from `megane-viewer/lib`:

```typescript
import {
  LoadStructure,
  LoadTrajectory,
  Streaming,
  LoadVector,
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
  VectorOverlay,
  LoadVolumetric,
  Isosurface,
  LoadSpectrum,
  SpectrumPlot,
  ViewportNode,
  Pipeline,
} from "megane-viewer/lib";
```

Constructor parameters mirror the Python API (using an options object instead of keyword args):

| Python                                   | JavaScript/TypeScript                            |
| ---------------------------------------- | ------------------------------------------------ |
| `LoadStructure("path")`                  | `new LoadStructure('path')`                      |
| `LoadStructure("path", edits=[...])`     | `new LoadStructure('path', { edits: [...] })`    |
| `Filter(query="element == 'C'")`         | `new Filter({ query: "element == 'C'" })`        |
| `Filter(bond_query="...")`               | `new Filter({ bondQuery: "..." })`               |
| `Modify(scale=1.3, opacity=0.8)`         | `new Modify({ scale: 1.3, opacity: 0.8 })`       |
| `Color(mode="byElement")`                | `new Color({ mode: "byElement" })`               |
| `Representation(mode="cartoon")`         | `new Representation({ mode: "cartoon" })`        |
| `AddBonds(source="distance")`            | `new AddBonds({ source: 'distance' })`           |
| `AddLabels(source="element")`            | `new AddLabels({ source: 'element' })`           |
| `DrawingBoundary(x_min=0, x_max=1)`      | `new DrawingBoundary({ xMin: 0, xMax: 1 })`      |
| `BoundaryCompletion(mode="components")`  | `new BoundaryCompletion({ mode: "components" })` |
| `AddCoordination(excluded_centers=[38])` | `new AddCoordination({ excludedCenters: [38] })` |
| `AddPolyhedra(opacity=0.5)`              | `new AddPolyhedra({ opacity: 0.5 })`             |
| `VectorOverlay(scale=2.0)`               | `new VectorOverlay({ scale: 2.0 })`              |
| `LoadTrajectory(xtc="traj.xtc")`         | `new LoadTrajectory({ xtc: 'traj.xtc' })`        |
| `LoadTrajectory(dcd="run.dcd")`          | `new LoadTrajectory('run.dcd')`                  |
| `Symmetry(mode="expand")`                | `new Symmetry({ mode: "expand" })`               |
| `Wrap(mode="unwrap")`                    | `new Wrap({ mode: "unwrap" })`                   |
| `Replicate(nx=2, ny=2, nz=1)`            | `new Replicate({ nx: 2, ny: 2, nz: 1 })`         |
| `LoadVolumetric("density.cube")`         | `new LoadVolumetric('density.cube')`             |
| `Isosurface(iso_level=0.02)`             | `new Isosurface({ isoLevel: 0.02 })`             |
| `LoadSpectrum("ir.jdx")`                 | `new LoadSpectrum('ir.jdx')`                     |
| `SpectrumPlot(reverse_x=False)`          | `new SpectrumPlot({ reverseX: false })`          |
| `SurfaceMesh(alpha_radius=3.0)`          | `new SurfaceMesh({ alphaRadius: 3.0 })`          |
| `Viewport(perspective=True)`             | `new ViewportNode({ perspective: true })`        |

The Viewport class is exported as `ViewportNode` so it does not clash with the `Viewport` React component exported from the same entry point.

### Differences from Python

- **Node coverage:** every pipeline node type has a TypeScript builder class (a compile-time check keeps it that way). The Python builder covers the same node types (a drift test checks it against the TypeScript node contract). A builder node starts with the same parameter values as a node added in the editor (`defaultParams`), except `Filter`, whose `query` defaults to `"all"` — it selects the same atoms as the editor's empty query.
- **`LoadTrajectory`** takes the file path directly — `new LoadTrajectory("run.dcd")` or `{ path }` — in any format the Load Trajectory node opens (XTC, DCD, AMBER NetCDF `.nc`, LAMMPS dump `.lammpstrj` / `.dump` / `.trj`). The Python-style per-format keys (`{ xtc }`, `{ dcd }`, `{ nc }`, `{ traj }`, `{ xyz }`, `{ lammpstrj }`) also work, and `{ source: "structure" }` forwards the frames embedded in the structure file.
- **`AddBonds`** takes only `{ source }`; there is no `top` option for topology files.
- **`Pipeline`** has `addNode`, `addEdge`, `toObject`, and `toJSON` only — there is no `fromDict` / `load` / `save`. Use `deserializePipeline()` to turn a `SerializedPipeline` back into editor nodes and edges.

## Ports

After `addNode()`, each node exposes two port accessors:

- `node.out.<name>` — output port (first arg to `addEdge`)
- `node.inp.<name>` — input port (second arg to `addEdge`)

Port names are identical to Python, except the Isosurface coloring input: `iso.inp.colorVolumetric` in TypeScript, `iso.inp.color_volumetric` in Python (both map to the `"colorVolumetric"` wire handle). The `.traj` port maps to the `"trajectory"` wire handle internally. Accessing an undefined port throws an `Error` with a message listing available ports.

## React Components

### PipelineViewer

An embeddable viewer that renders a pipeline. Each instance is independent — no global state.

```tsx
import { PipelineViewer } from "megane-viewer/lib";

<PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
```

| Prop       | Type                 | Default  | Description                            |
| ---------- | -------------------- | -------- | -------------------------------------- |
| `pipeline` | `SerializedPipeline` | —        | Pipeline object from `pipe.toObject()` |
| `width`    | `string \| number`   | `"100%"` | Container width                        |
| `height`   | `string \| number`   | `500`    | Container height                       |

`PipelineViewer` fetches each `load_structure` node's `fileUrl` and parses it in the browser. The builder's `LoadStructure(path)` writes `path` as both `fileName` and `fileUrl`, so pass a URL the page can fetch (relative or absolute). Only structure files are fetched: a `LoadTrajectory` file is not, so for playback use a multi-frame structure file (see [Trajectory Playback](#example-trajectory-playback)).

### MeganeViewer

A full-featured viewer with the pipeline editor, timeline, and measurement tools. It renders whatever pipeline the pipeline store holds (the module-global `usePipelineStore`, or the store of an enclosing `MeganeProvider`); `onUploadStructure` is its only required prop.

```tsx
import { MeganeViewer, usePipelineStore } from "megane-viewer/lib";

<MeganeViewer onUploadStructure={(file) => usePipelineStore.getState().openFile(file)} />;
```

#### Switching tools off (`ui`)

Every tool except the 3D Viewport can be hidden at construction time through
the `ui` prop. Omitted keys stay visible, so you only list what you want gone:

```tsx
import { MeganeViewer, usePipelineStore } from "megane-viewer/lib";

// Read-only embed: 3D view and playback only.
<MeganeViewer
  ui={{ pipelineEditor: false, resetView: false, perfHud: false }}
  onUploadStructure={(file) => usePipelineStore.getState().openFile(file)}
/>;
```

`onUploadStructure` is required even when the editor is hidden — see the note
under the table.

| Key | Default | Hides |
|------|---------|-------|
| `pipelineEditor` | `true` | Pipeline editor panel on the right (toolbar, node graph, share/render dialogs, **and the viewer's only file-open UI**) |
| `resetView` | `true` | "Reset View" button in the top-left corner |
| `viewAxes` | `true` | Axis-alignment buttons (±a/±b/±c while a cell is loaded, ±x/±y/±z always) under Reset View |
| `perfHud` | `true` | Atoms / Bonds / Draws / FPS / CPU / Mem readout (see [Performance readout](../web.md#performance-readout)) |
| `timeline` | `true` | Playback timeline along the bottom |
| `tooltip` | `true` | Hover tooltip over atoms and bonds |
| `measurement` | `true` | Measurement readout panel and saved-measurement list |

Hiding a tool removes it from the DOM but changes nothing about the scene: the
pipeline still executes and the renderer still receives every update. With
`pipelineEditor: false` the viewer also reclaims the width the panel reserved,
so the structure is centred in the full canvas, and with `timeline: false` the
measurement panels drop to the bottom corner instead of hovering above an
empty strip.

Right-click atom selection stays wired whichever way `measurement` is set —
hosts consume `onSelectionChange` / `onMeasurementChange` without necessarily
showing the panel — so **Escape clears the current selection**. That is the
only way out when `measurement: false` removes the panel's Clear button.

:::note Loading files with the editor hidden
The file-open UI lives inside the pipeline editor (the Load Structure node), so
`pipelineEditor: false` leaves the required `onUploadStructure` callback with
nothing to trigger it. Drive the pipeline yourself instead — for example
`usePipelineStore.getState().openFile(file)` from your own drop target or
fetch — and keep passing `onUploadStructure` to satisfy the prop type.
:::

The option type and the all-visible defaults are exported for typed configs:

```ts
import type { MeganeViewerUiOptions } from "megane-viewer/lib";
import { DEFAULT_MEGANE_VIEWER_UI } from "megane-viewer/lib";

const embedUi: MeganeViewerUiOptions = { ...DEFAULT_MEGANE_VIEWER_UI, pipelineEditor: false };
```

## Example: Basic Structure with Bonds

```typescript
import { PipelineViewer, Pipeline, LoadStructure, AddBonds, ViewportNode } from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("protein.pdb"));
const b = pipe.addNode(new AddBonds({ source: "distance" }));
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, b.inp.particle);
pipe.addEdge(s.out.particle, v.inp.particle);
pipe.addEdge(b.out.bond, v.inp.bond);

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```

## Example: Filter and Modify

```typescript
import { PipelineViewer, Pipeline, LoadStructure, Filter, Modify, AddBonds, ViewportNode } from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("protein.pdb"));
const carbons = pipe.addNode(new Filter({ query: "element == 'C'" }));
const big = pipe.addNode(new Modify({ scale: 1.5, opacity: 0.8 }));
const bonds = pipe.addNode(new AddBonds());
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, carbons.inp.particle);
pipe.addEdge(carbons.out.particle, big.inp.particle);
pipe.addEdge(s.out.particle, bonds.inp.particle);
pipe.addEdge(big.out.particle, v.inp.particle);
pipe.addEdge(bonds.out.bond, v.inp.bond);

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```

## Example: Trajectory Playback

A multi-frame structure file (multi-frame XYZ / PDB, ASE `.traj`) carries its own frames on `LoadStructure`'s `out.traj` port, which `PipelineViewer` plays back:

```typescript
import { PipelineViewer, Pipeline, LoadStructure, AddBonds, ViewportNode } from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("trajectory.xyz"));
const bonds = pipe.addNode(new AddBonds({ source: "distance" }));
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, bonds.inp.particle);
pipe.addEdge(s.out.particle, v.inp.particle);
pipe.addEdge(s.out.traj, v.inp.traj);
pipe.addEdge(bonds.out.bond, v.inp.bond);

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```

An external trajectory is wired the same way as in Python — `pipe.addEdge(s.out.particle, traj.inp.particle)` and `pipe.addEdge(traj.out.traj, v.inp.traj)` with `traj = pipe.addNode(new LoadTrajectory({ xtc: "trajectory.xtc" }))` — and serializes normally, but `PipelineViewer` does not fetch the XTC file, so it shows the static structure without playback.

## Example: TiO₆ Coordination Polyhedra

```typescript
import {
  PipelineViewer, Pipeline, LoadStructure, DrawingBoundary,
  AddCoordination, AddPolyhedra, ViewportNode,
} from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("SrTiO3_supercell.pdb"));
const boundary = pipe.addNode(new DrawingBoundary());
// Coordination finds center-neighbor pairs and can include periodic neighbors
// just outside the drawing range to complete visible centers.
const coordination = pipe.addNode(new AddCoordination({
  excludedCenters: [38], // exclude Sr; Ti (22) is kept
  boundaryMode: "complete",
}));
const polyhedra = pipe.addNode(
  new AddPolyhedra({
    opacity: 0.5,
    showEdges: true,
  })
);
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, boundary.inp.particle);
pipe.addEdge(boundary.out.particle, coordination.inp.particle);
pipe.addEdge(boundary.out.particle, v.inp.particle);
pipe.addEdge(coordination.out.coordination, polyhedra.inp.coordination);
pipe.addEdge(coordination.out.bond, v.inp.bond);
pipe.addEdge(polyhedra.out.mesh, v.inp.mesh);

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```

## Example: DAG Branching (Multiple Filters)

```typescript
import { PipelineViewer, Pipeline, LoadStructure, Filter, AddLabels, AddBonds, ViewportNode } from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("protein.pdb"));
const carbon = pipe.addNode(new Filter({ query: "element == 'C'" }));
const nitrogen = pipe.addNode(new Filter({ query: "element == 'N'" }));
const labels = pipe.addNode(new AddLabels({ source: "element" }));
const bonds = pipe.addNode(new AddBonds());
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, carbon.inp.particle);
pipe.addEdge(s.out.particle, nitrogen.inp.particle);
pipe.addEdge(s.out.particle, labels.inp.particle);
pipe.addEdge(s.out.particle, bonds.inp.particle);
pipe.addEdge(carbon.out.particle, v.inp.particle);
pipe.addEdge(nitrogen.out.particle, v.inp.particle);
pipe.addEdge(labels.out.label, v.inp.label);
pipe.addEdge(bonds.out.bond, v.inp.bond);

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```
