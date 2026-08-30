import LiveViewer from '@site/src/components/LiveViewer';

# React component

megane can be embedded in React applications as a component library, published to npm as `megane-viewer`. It provides both high-level React components (`MeganeViewer`, `PipelineViewer`) and the framework-agnostic `MoleculeRenderer` core renderer.

<LiveViewer data="caffeine_water" caption="The megane renderer running live in this page — the same engine megane-viewer ships to your app." />

## Installation

```bash
npm install megane-viewer
```

`megane-viewer` works with both React 18 and React 19 — it declares a peer dependency of `react@^18.2.0 || ^19.0.0` (and the matching `react-dom`) and uses your app's React instance rather than bundling its own.

The package ships TypeScript declarations for both entry points (`megane-viewer` and `megane-viewer/lib`), so no manual ambient declarations are needed.

Import the bundled stylesheet once (e.g. in your app entry) so the viewer UI is styled:

```ts
import "megane-viewer/styles.css";
```

## Full-Featured Viewer

The easiest way to get started is the `MeganeViewer` component. It includes the 3D viewport, pipeline editor, timeline, tooltip, and measurement panels — everything you need in a single component. Every tool except the 3D viewport can be switched off through the [`ui` prop](#hiding-tools-ui).

```tsx
import { useCallback } from "react";
import "megane-viewer/styles.css";
import { MeganeViewer } from "megane-viewer/lib";
import { usePipelineStore } from "megane-viewer/lib";

function App() {
  const handleUpload = useCallback((file: File) => {
    usePipelineStore.getState().openFile(file);
  }, []);

  return (
    <MeganeViewer
      onUploadStructure={handleUpload}
      width="100%"
      height="600px"
    />
  );
}
```

### `MeganeViewer` Props

`MeganeViewer` is pipeline-store-driven: it manages its own rendering state internally. Host apps supply only the file-ingestion callbacks; viewer state (snapshot, bonds, labels, vectors, etc.) is derived from the internal pipeline graph.

| Prop | Type | Required | Description |
|------|------|:--------:|-------------|
| `onUploadStructure` | `(file: File) => void` | ✓ | Called when the user uploads a structure file |
| `onUploadTrajectory` | `(file: File) => void` | | Called when the user uploads a trajectory file |
| `onBondSourceChange` | `(source: BondSource) => void` | | Bond source change callback |
| `onLabelSourceChange` | `(source: LabelSource) => void` | | Label source change callback |
| `onLoadLabelFile` | `(file: File) => void` | | Called when the user uploads a label file |
| `onVectorSourceChange` | `(source: VectorSource) => void` | | Vector source change callback |
| `onLoadVectorFile` | `(file: File) => void` | | Called when the user uploads a vector file |
| `onLoadDemoVectors` | `() => void` | | Called when the user requests demo vectors |
| `playing` | `boolean` | | Playback state (default: `false`) |
| `fps` | `number` | | Playback speed (default: `30`) |
| `onSeek` | `(frame: number) => void` | | Frame seek handler |
| `onPlayPause` | `() => void` | | Play/pause toggle |
| `onFpsChange` | `(fps: number) => void` | | FPS change handler |
| `width` / `height` | `string \| number` | | Viewer dimensions (default: `"100%"`) |
| `ui` | `Partial<MeganeViewerUiOptions>` | | Hides individual tools — see below (default: everything visible) |

### Hiding tools (`ui`)

Every tool except the 3D viewport can be hidden at construction time. Omitted
keys stay visible, so you only list what you want gone:

```tsx
import { MeganeViewer, usePipelineStore } from "megane-viewer/lib";

// Read-only embed: 3D view and playback only.
<MeganeViewer
  ui={{ pipelineEditor: false, resetView: false, perfHud: false }}
  onUploadStructure={(file) => usePipelineStore.getState().openFile(file)}
/>;
```

| Key | Default | Hides |
|------|---------|-------|
| `pipelineEditor` | `true` | Pipeline editor panel on the right, including the viewer's only file-open UI |
| `resetView` | `true` | "Reset View" button in the top-left corner |
| `perfHud` | `true` | Atoms / Bonds / Draws / FPS readout |
| `timeline` | `true` | Playback timeline along the bottom |
| `tooltip` | `true` | Hover tooltip over atoms and bonds |
| `measurement` | `true` | Measurement readout panel and saved-measurement list (selection itself stays active — press <kbd>Esc</kbd> to clear it) |

Hiding a tool removes it from the DOM but changes nothing about the scene — the
pipeline still executes and the renderer still receives every update. The type
`MeganeViewerUiOptions` and the all-visible defaults `DEFAULT_MEGANE_VIEWER_UI`
are exported for typed configs. With `pipelineEditor: false` you must drive
file loading yourself (`usePipelineStore.getState().openFile(file)`), since the
Load Structure node lives inside the editor.

See the [TypeScript Pipeline API](/guide/pipeline/typescript) for the complete interface.

---

## Multiple viewers on one page

By default `MeganeViewer` reads a set of module-global stores. That is what a
single-viewer app wants, and it is why the snippet above can reach the viewer's
state through `usePipelineStore.getState()` from anywhere. But it also means two
viewers mounted side by side share one pipeline: the second one's `openFile()`
replaces the graph the first is rendering, and both panels end up showing the
same structure.

Wrap each viewer in a `MeganeProvider` and it gets its own state:

```tsx
import { useEffect, useState } from "react";
import "megane-viewer/styles.css";
import {
  MeganeViewer,
  MeganeProvider,
  createMeganeStores,
  type MeganeStores,
} from "megane-viewer/lib";

function Preview({ stores, text, fileName }: {
  stores: MeganeStores;
  text: string;
  fileName: string;
}) {
  useEffect(() => {
    // Straight onto THIS viewer's pipeline store.
    void stores.pipeline.getState().openFile(new File([text], fileName));
  }, [stores, text, fileName]);

  return (
    <MeganeProvider stores={stores}>
      <MeganeViewer onUploadStructure={() => {}} width="100%" height="100%" />
    </MeganeProvider>
  );
}

function App() {
  // Created once — not inside render, or every render starts a new viewer.
  const [left] = useState(() => createMeganeStores());
  const [right] = useState(() => createMeganeStores());

  return (
    <div style={{ display: "flex", height: 500 }}>
      <Preview stores={left} text={crambinPdb} fileName="crambin.pdb" />
      <Preview stores={right} text={butanePdb} fileName="butane.pdb" />
    </div>
  );
}
```

`MeganeProvider` can also create and own its bundle, which is all you need when
nothing outside the viewer has to drive it:

```tsx
<MeganeProvider>
  <MeganeViewer onUploadStructure={handleUpload} />
</MeganeProvider>
```

### What a bundle contains

`createMeganeStores()` returns the six stores that belong to one viewer —
`pipeline`, `playback`, `measurement`, `viewState`, `pipelineUI` and
`inspector` — plus the file-drop handlers its Load nodes route through.

Three stores stay page-level and are deliberately **not** scoped:

| Store | Why it stays global |
|-------|---------------------|
| `useThemeStore` | Writes `data-theme` on `<html>`, and the CSS tokens are defined on `:root`. Two viewers scoping it would fight over one DOM node. |
| `useAIConfigStore` | One API key and model per user. |
| `useTourStore` | One guided-tour overlay per document. |

### Reaching a viewer's state

Inside the provider's subtree, the scoped hooks mirror the global ones:

```tsx
import { useScopedPipelineStore, usePipelineStoreApi } from "megane-viewer/lib";

function AtomCount() {
  // Selector form, for the render path.
  return <>{useScopedPipelineStore((s) => s.viewportState.particles[0]?.source?.nAtoms ?? 0)}</>;
}

function ToggleCellAxes() {
  // Store API, for effects and event handlers. Writing viewportState directly
  // updates the renderer without re-executing the graph, so the camera stays
  // where the user left it.
  const api = usePipelineStoreApi();
  return <button onClick={() => {
    const vs = api.getState().viewportState;
    api.setState({ viewportState: { ...vs, cellAxesVisible: !vs.cellAxesVisible } });
  }}>Toggle cell axes</button>;
}
```

Outside the subtree, hold the bundle you created and use `stores.pipeline`,
`stores.playback`, and so on, as in the two-viewer example above.

### Persistence

A scoped bundle keeps its camera and panel tab **in memory**. The single-viewer
defaults persist them under one fixed key each (`megane-view-state` in
`localStorage`, `megane-pipeline-ui` in `sessionStorage`), which two viewers
would overwrite for each other. Opt in per viewer with a key of your own:

```tsx
createMeganeStores({
  id: "left",
  persist: { camera: "megane-view-state-left", pipelineUI: "megane-pipeline-ui-left" },
});
```

### Compatibility

Mounting no provider changes nothing: every hook falls back to the module-global
stores, so `usePipelineStore.getState().openFile(file)` and the rest of this page
keep working as before.

---

## PipelineViewer (Docs / MDX Embed)

`PipelineViewer` is a self-contained React component designed for embedding molecular visualizations in documentation, blog posts, and MDX pages. It uses **no stores at all** — it holds its state in local React state, so multiple instances on the same page are independent with no extra wiring. `MeganeViewer` can also be mounted more than once per page, by giving each one its own store bundle — see [Multiple viewers on one page](#multiple-viewers-on-one-page).

### Key differences from `MeganeViewer`

| Feature | `MeganeViewer` | `PipelineViewer` |
|---------|---------------|-----------------|
| UI panels (sidebar, appearance) | Yes | No |
| Pipeline control | Internal editor UI | `pipeline` prop |
| Multiple instances per page | Yes, with [`MeganeProvider`](#multiple-viewers-on-one-page) | Fully independent |
| File loading | Upload / drag-drop | URL fetch via `fileUrl` |
| Trajectory playback | Yes | Yes (Timeline shown automatically) |

### Installation

```bash
npm install megane-viewer
```

### Usage

```tsx
import { PipelineViewer } from "megane-viewer/lib";

<PipelineViewer
  width="100%"
  height={500}
  pipeline={{
    version: 3,
    nodes: [
      {
        id: "s1",
        type: "load_structure",
        fileName: "caffeine_water.pdb",
        fileUrl: "/structures/caffeine_water.pdb",
        hasTrajectory: false,
        hasCell: false,
        position: { x: 0, y: 0 },
      },
      {
        id: "b1",
        type: "add_bond",
        bondSource: "distance",
        position: { x: 200, y: 0 },
      },
      {
        id: "v1",
        type: "viewport",
        perspective: false,
        cellAxesVisible: true,
        pivotMarkerVisible: true,
        position: { x: 400, y: 0 },
      },
    ],
    edges: [
      { source: "s1", target: "b1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "s1", target: "v1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "b1", target: "v1", sourceHandle: "bond",     targetHandle: "bond" },
    ],
  }}
/>
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `pipeline` | `SerializedPipeline` | *(required)* | Pipeline JSON describing the node graph |
| `width` | `string \| number` | `"100%"` | Component width |
| `height` | `string \| number` | `500` | Component height in pixels |

### `SerializedPipeline` format

```ts
import type { PipelineNodeParams, SerializedPipeline } from "megane-viewer/lib";

// SerializedPipeline (exported from megane-viewer/lib):
interface SerializedPipeline {
  version: 3;
  nodes: Array<PipelineNodeParams & {
    id: string;
    position: { x: number; y: number };
    enabled?: boolean;   // false = node is bypassed (default: true)
  }>;
  edges: Array<{
    source: string;
    target: string;
    sourceHandle: string;
    targetHandle: string;
  }>;
}
```

`PipelineNodeParams` is a discriminated union exported by `megane-viewer/lib`. The `type` field on each node determines which parameters are required — see [Node Reference](/reference/node-reference) for the full list.

Each node's `type` field determines which parameters are required. See [Node Reference](/reference/node-reference) for the full list.

#### `load_structure` node — the `fileUrl` field

`PipelineViewer` cannot use a local file picker, so `load_structure` nodes need a `fileUrl` field pointing to a URL where the structure file can be fetched:

```ts
{
  id: "s1",
  type: "load_structure",
  fileName: "protein.pdb",        // displayed name (optional, inferred from URL)
  fileUrl: "/structures/protein.pdb",  // fetched at render time
  hasTrajectory: false,
  hasCell: false,
  position: { x: 0, y: 0 },
}
```

The component fetches all `fileUrl` values in parallel at mount time using the browser's `fetch()` API, then parses them with the WASM parser.

### Trajectory playback

When the pipeline includes time-dependent data — by loading a multi-frame structure file (such as a multi-frame XYZ or ASE `.traj`) — `PipelineViewer` automatically shows the Timeline bar at the bottom.

```tsx
<PipelineViewer
  height={500}
  pipeline={{
    version: 3,
    nodes: [
      {
        id: "s1",
        type: "load_structure",
        fileName: "simulation.traj",
        fileUrl: "/structures/simulation.traj",
        hasTrajectory: true,
        hasCell: false,
        position: { x: 0, y: 0 },
      },
      {
        id: "v1",
        type: "viewport",
        perspective: false,
        cellAxesVisible: false,
        pivotMarkerVisible: true,
        position: { x: 300, y: 0 },
      },
    ],
    edges: [
      { source: "s1", target: "v1", sourceHandle: "particle",   targetHandle: "particle" },
      { source: "s1", target: "v1", sourceHandle: "trajectory", targetHandle: "trajectory" },
    ],
  }}
/>
```

> **Note:** `PipelineViewer` does not currently support `load_trajectory` nodes. Trajectories must be embedded in the structure file (e.g. ASE `.traj`, multi-frame XYZ). External XTC trajectories require a `MeganeViewer` with a server-side pipeline.

### Usage in MDX (Next.js / Docusaurus)

`PipelineViewer` works in any MDX-based framework — import it directly in your `.mdx` file and drop it in. For full MDX examples, the `MeganeViewer` / viewport-only variants, and the required `next.config.mjs` WASM setup, see the [MDX / Next.js guide](/guide/mdx).

### Using a saved pipeline JSON

You can serialize a pipeline from the megane UI (Pipeline editor → Export) and load it directly:

```tsx
import pipelineJson from "./my-pipeline.json";
import { PipelineViewer } from "megane-viewer/lib";

// Add fileUrl to each load_structure node before rendering
const pipeline = {
  ...pipelineJson,
  nodes: pipelineJson.nodes.map((n) =>
    n.type === "load_structure"
      ? { ...n, fileUrl: `/structures/${n.fileName}` }
      : n,
  ),
};

<PipelineViewer pipeline={pipeline} height={500} />
```

---

## Individual Components

For custom layouts, megane exports each panel as a separate component. This gives you full control over placement and behavior.

### `Viewport` — 3D Canvas Only

The core rendering surface without any UI panels:

```tsx
import { Viewport } from "megane-viewer/lib";
import type { Snapshot, HoverInfo } from "megane-viewer/lib";

function MinimalViewer({ snapshot }: { snapshot: Snapshot }) {
  return (
    <Viewport
      snapshot={snapshot}
      frame={null}
      onRendererReady={(renderer) => {
        renderer.setAtomScale(1.5);
      }}
      onHover={(info: HoverInfo) => {
        if (info?.kind === "atom") {
          console.log(`Atom ${info.atomIndex}: ${info.elementSymbol}`);
        }
      }}
      onAtomRightClick={(atomIndex) => {
        console.log("Selected:", atomIndex);
      }}
    />
  );
}
```

### `Sidebar`, `Timeline`

Combine individual panels for a custom layout:

```tsx
import { useState } from "react";
import { Viewport, Sidebar, Timeline } from "megane-viewer/lib";
import type { BondConfig, TrajectoryConfig } from "megane-viewer/lib";

function CustomLayout({ bondConfig, trajectoryConfig, handleUpload }) {
  const [renderer, setRenderer] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{ position: "relative", width: "100%", height: "100vh" }}>
      {/* Left sidebar */}
      <Sidebar
        mode="local"
        structure={{ atomCount: 0, fileName: null }}
        bonds={bondConfig}
        trajectory={trajectoryConfig}
        onUploadStructure={handleUpload}
        onResetView={() => renderer?.resetView()}
        hasCell={false}
        cellVisible={false}
        onToggleCell={() => {}}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />

      {/* 3D viewport */}
      <Viewport
        snapshot={null}
        frame={null}
        onRendererReady={setRenderer}
      />
    </div>
  );
}
```

---

## Core Renderer (Vue / Svelte / vanilla JS)

For non-React applications (Vue, Svelte, vanilla JS), use `MoleculeRenderer` directly — the same Three.js renderer that powers all megane components. See the [guide to using megane with Vue, Svelte & vanilla JS](/guide/framework-agnostic) for mounting, appearance control, atom selection/measurement, and screen-space picking.

---

## MDX Usage (Next.js)

megane works in MDX-based documentation frameworks like Next.js. For static embeds, `MeganeViewer`/`PipelineViewer` variants, viewport-only embeds, and the required `next.config.mjs` WASM setup, see the [MDX / Next.js guide](/guide/mdx).

---

## Protocol Utilities

Decode binary messages from the `megane serve` backend (WebSocket):

```ts
import {
  decodeSnapshot,
  decodeFrame,
  decodeMetadata,
  decodeHeader,
  MSG_SNAPSHOT,
  MSG_FRAME,
  MSG_METADATA,
} from "megane-viewer/lib";

ws.onmessage = (event) => {
  const buffer = event.data as ArrayBuffer;
  const header = decodeHeader(buffer);

  switch (header.msgType) {
    case MSG_SNAPSHOT:
      const snapshot = decodeSnapshot(buffer);
      renderer.loadSnapshot(snapshot);
      break;
    case MSG_FRAME:
      const frame = decodeFrame(buffer);
      renderer.updateFrame(frame);
      break;
    case MSG_METADATA:
      const meta = decodeMetadata(buffer);
      console.log(`${meta.nFrames} frames, ${meta.timestepPs} ps/step`);
      break;
  }
};
```

## Types

Key TypeScript types exported by megane:

```ts
import type {
  Snapshot,            // Parsed molecular structure (positions, elements, bonds)
  Frame,               // Single trajectory frame (frameId, positions)
  TrajectoryMeta,      // Trajectory metadata (nFrames, timestepPs)
  HoverInfo,           // Atom/bond hover information
  SelectionState,      // Current atom selection
  Measurement,         // Distance/angle/dihedral result
  BondSource,          // "structure" | "file" | "distance" | "none"
  BondConfig,          // Bond panel configuration (for Sidebar)
  TrajectoryConfig,    // Trajectory panel configuration (for Sidebar)
  StructureParseResult,// Parse result from parseStructureFile/Text
} from "megane-viewer/lib";
```

### Parser Functions

```ts
import { parseStructureFile, parseStructureText } from "megane-viewer/lib";

// Parse from File object (drag-and-drop, file input)
const result = await parseStructureFile(file);
// result.snapshot, result.frames, result.labels

// Parse from text string (fetched content)
const result = await parseStructureText(pdbText);
```
