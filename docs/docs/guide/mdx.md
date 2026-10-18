# MDX / Next.js

Embed the megane viewer in MDX-based documentation frameworks like Next.js. Drop `<PipelineViewer />`, `<MeganeViewer />`, or `<Viewport />` into your `.mdx` files — WASM parsing works out of the box with a one-line webpack config.

## Static embed with `PipelineViewer`

For a static embed of a known structure, use [`PipelineViewer`](/guide/web#pipelineviewer-docs--mdx-embed) — it has no global-store dependency, so multiple instances on the same page work independently and you don't need any file-upload plumbing:

```mdx
---
title: Protein Visualization
---

import { PipelineViewer } from "megane-viewer/lib";

# Caffeine in Water

A caffeine molecule solvated by water — 3024 atoms rendered in real time.

<PipelineViewer
  height={500}
  pipeline={{
    version: 3,
    nodes: [
      { id: "s1", type: "load_structure", fileName: "caffeine_water.pdb",
        fileUrl: "/data/caffeine_water.pdb",
        hasTrajectory: false, hasCell: false, position: { x: 0, y: 0 } },
      { id: "b1", type: "add_bond", bondSource: "distance",
        position: { x: 200, y: 0 } },
      { id: "v1", type: "viewport", perspective: false, cellAxesVisible: false,
        pivotMarkerVisible: true, position: { x: 400, y: 0 } },
    ],
    edges: [
      { source: "s1", target: "b1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "s1", target: "v1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "b1", target: "v1", sourceHandle: "bond",     targetHandle: "bond" },
    ],
  }}
/>

The viewer above uses WASM-powered parsing and billboard impostor rendering
to display all 3024 atoms with bonds inferred from van der Waals radii.
```

## Full viewer with `MeganeViewer`

If you specifically need the full pipeline-editor / timeline / measurement UI in an MDX page, use `MeganeViewer` and pipe uploads through `usePipelineStore`:

```mdx
import { useCallback } from "react";
import "megane-viewer/styles.css";
import { MeganeViewer, usePipelineStore } from "megane-viewer/lib";

export function FullViewer() {
  const handleUpload = useCallback((file) => {
    usePipelineStore.getState().openFile(file);
  }, []);
  return (
    <MeganeViewer
      onUploadStructure={handleUpload}
      width="100%"
      height="500px"
    />
  );
}

<FullViewer />
```

Without a provider, `MeganeViewer` reads module-global stores, so two of them
on one page would share a single pipeline. Wrap each one in its own
`MeganeProvider` (see [Multiple viewers on one page](/guide/web#multiple-viewers-on-one-page)),
or use `PipelineViewer` as shown above, which needs no wiring at all.

## Viewport-only in MDX

For a simpler embed without panels:

```mdx
import { useState, useEffect } from "react";
import { Viewport, parseStructureText } from "megane-viewer/lib";

export function SimpleViewer() {
  const [snapshot, setSnapshot] = useState(null);

  useEffect(() => {
    fetch("/data/caffeine_water.pdb")
      .then((r) => r.text())
      .then(async (text) => {
        const result = await parseStructureText(text);
        setSnapshot(result.snapshot);
      });
  }, []);

  return (
    <div style={{ height: "400px" }}>
      <Viewport snapshot={snapshot} frame={null} />
    </div>
  );
}

<SimpleViewer />
```

## Next.js Configuration

Add megane to `next.config.mjs` for WASM support:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

export default nextConfig;
```
