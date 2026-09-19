---
sidebar_label: TypeScript
---

# TypeScript Pipeline API

Pipelines can be built programmatically in JavaScript/TypeScript using the `Pipeline` builder. The API mirrors the [Python interface](./python.md) exactly, making it straightforward to port pipelines between languages.

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
  DrawingBoundary,
  BoundaryCompletion,
  Color,
  Representation,
  AddBonds,
  AddCoordination,
  AddLabels,
  AddPolyhedra,
  VectorOverlay,
  ViewportNode,
  Pipeline,
} from "megane-viewer/lib";
```

Constructor parameters mirror the Python API (using an options object instead of keyword args):

| Python                                   | JavaScript/TypeScript                            |
| ---------------------------------------- | ------------------------------------------------ |
| `LoadStructure("path")`                  | `new LoadStructure('path')`                      |
| `Filter(query="element == 'C'")`         | `new Filter({ query: "element == 'C'" })`        |
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
| `Viewport(perspective=True)`             | `new ViewportNode({ perspective: true })`        |

## Ports

After `addNode()`, each node exposes two port accessors:

- `node.out.<name>` — output port (first arg to `addEdge`)
- `node.inp.<name>` — input port (second arg to `addEdge`)

Port names are identical to Python. The `.traj` port maps to the `"trajectory"` wire handle internally. Accessing an undefined port throws an `Error` with a message listing available ports.

## React Components

### PipelineViewer

An embeddable viewer that renders a pipeline. Each instance is independent — no global state.

```tsx
import { PipelineViewer } from "megane-viewer/lib";

<PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
```

| Prop       | Type                 | Description                            |
| ---------- | -------------------- | -------------------------------------- |
| `pipeline` | `SerializedPipeline` | Pipeline object from `pipe.toObject()` |
| `width`    | `string \| number`   | Container width                        |
| `height`   | `string \| number`   | Container height                       |

### MeganeViewer

A full-featured viewer with sidebar, appearance panel, timeline, and measurement tools.

```tsx
import { MeganeViewer } from "megane-viewer/lib";

<MeganeViewer />;
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
| `perfHud` | `true` | Atoms / Bonds / Draws / FPS readout |
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

```typescript
import { PipelineViewer, Pipeline, LoadStructure, LoadTrajectory, AddBonds, ViewportNode } from "megane-viewer/lib";

const pipe = new Pipeline();
const s = pipe.addNode(new LoadStructure("protein.pdb"));
const traj = pipe.addNode(new LoadTrajectory({ xtc: "trajectory.xtc" }));
const bonds = pipe.addNode(new AddBonds({ source: "structure" }));
const v = pipe.addNode(new ViewportNode());

pipe.addEdge(s.out.particle, traj.inp.particle);
pipe.addEdge(s.out.particle, bonds.inp.particle);
pipe.addEdge(s.out.particle, v.inp.particle);
pipe.addEdge(traj.out.traj, v.inp.traj);
pipe.addEdge(bonds.out.bond, v.inp.bond);

export default function App() {
  return <PipelineViewer pipeline={pipe.toObject()} width="100%" height={500} />;
}
```

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
