---
sidebar_label: JSON
---

# JSON Pipeline Format

Pipelines serialize to the **SerializedPipeline v3** JSON format. This format is used by:

- The **VS Code extension** (`*.megane.json` files open as a pipeline)
- The **pipeline editor** (*File → Import pipeline… / Export pipeline*, which downloads `pipeline.megane.json`; *Copy share link…* embeds the same JSON, compressed, in the URL)
- The TypeScript `pipe.toObject()` / `pipe.toJSON()` methods
- The Python `pipe.to_dict()` / `pipe.to_json()` / `pipe.save(path)` methods, and `Pipeline.from_dict()` / `Pipeline.from_json()` / `Pipeline.load(path)` to read it back

JSON pipelines can be saved, shared, and version-controlled. You can write them by hand or generate them from [Python](./python.md) or [TypeScript](./typescript.md).

For real-world examples, see the [Gallery](/gallery).

## Format

```json
{
  "version": 3,
  "nodes": [
    {
      "id": "s1",
      "type": "load_structure",
      "position": { "x": 0, "y": 0 },
      "fileName": "protein.pdb",
      "fileUrl": "protein.pdb",
      "hasTrajectory": false,
      "hasCell": false
    },
    {
      "id": "ab1",
      "type": "add_bond",
      "position": { "x": 0, "y": 150 },
      "bondSource": "distance"
    },
    {
      "id": "v1",
      "type": "viewport",
      "position": { "x": 0, "y": 300 },
      "perspective": false,
      "cellAxesVisible": false,
      "pivotMarkerVisible": false
    }
  ],
  "edges": [
    { "source": "s1", "target": "ab1", "sourceHandle": "particle", "targetHandle": "particle" },
    { "source": "s1", "target": "v1", "sourceHandle": "particle", "targetHandle": "particle" },
    { "source": "ab1", "target": "v1", "sourceHandle": "bond", "targetHandle": "bond" }
  ]
}
```

## Top-level Fields

| Field     | Type     | Description                            |
| --------- | -------- | -------------------------------------- |
| `version` | `number` | Always `3`; other versions are rejected |
| `nodes`   | `array`  | Array of node objects                  |
| `edges`   | `array`  | Array of edge objects connecting nodes |

## Node Fields

Every node has the following common fields:

| Field      | Type       | Description                                                    |
| ---------- | ---------- | -------------------------------------------------------------- |
| `id`       | `string`   | Unique node identifier                                         |
| `type`     | `string`   | Node type (see below)                                          |
| `position` | `{ x, y }` | Position in the pipeline editor canvas                         |
| `enabled`  | `boolean?` | Optional. Set to `false` to bypass this node (default: `true`) |

Any parameter a node leaves out takes its default (the defaults are listed in
the [Node Reference](/reference/node-reference)). Ephemeral data — parsed
topology bonds, volumetric grids, decoded spectra, trajectory frames — is never
serialized; only file names are.

### Node Types and Parameters

#### `load_structure`

| Field           | Type             | Description                                                                                                                       |
| --------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `fileName`      | `string \| null` | Path/name of the structure file                                                                                                   |
| `fileUrl`       | `string?`        | Optional URL the React `PipelineViewer` fetches the file from                                                                     |
| `hasTrajectory` | `boolean`        | Whether the file contains trajectory data                                                                                         |
| `hasCell`       | `boolean`        | Whether the file contains unit cell data                                                                                          |
| `edits`         | `EditOp[]?`      | Optional structure edits replayed, in order, on the file as loaded — the [Megane Builder](../builder.md) history format (see below) |

Each `edits` entry is an object whose `op` is one of `add_atom`, `delete_atoms`,
`move_atoms`, `set_element`, `add_bond`, `delete_bond`, `add_fragment`,
`set_cell`, `supercell`, `slab`, `expand_symmetry`, `wrap`, or `center`. Atom
references are either indices into the file's atoms (numbers) or the `id` of an
atom created by an earlier op in the list (strings; the whole-structure ops
`supercell` / `slab` / `expand_symmetry` re-key every atom as `<id>:<k>`).
Elements are atomic numbers and positions are in Å:

```json
"edits": [
  { "op": "set_element", "atoms": [3], "element": 7 },
  { "op": "add_atom", "id": "h1", "element": 1, "position": [1.2, 0.0, 0.4], "bondTo": 3 }
]
```

The full op schema is in the [Node Reference](/reference/node-reference#load_structure).

#### `load_trajectory`

| Field      | Type                     | Description                                                                                                                         |
| ---------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fileName` | `string \| null`         | Path/name of the trajectory file (XTC, DCD, NetCDF, LAMMPS dump)                                                                    |
| `source`   | `"file" \| "structure"`  | `"file"` (default) plays the trajectory file; `"structure"` forwards the frames embedded in a multi-frame structure file (XYZ/PDB/.traj) |

#### `streaming`

| Field       | Type      | Description                                         |
| ----------- | --------- | --------------------------------------------------- |
| `connected` | `boolean` | Whether the WebSocket stream is connected (default `false`) |

#### `load_vector`

| Field      | Type     | Description              |
| ---------- | -------- | ------------------------ |
| `fileName` | `string` | Path to vector data file |

#### `filter`

| Field        | Type      | Description          |
| ------------ | --------- | -------------------- |
| `query`      | `string`  | Atom selection query |
| `bond_query` | `string?` | Bond selection query |

#### `modify`

| Field     | Type     | Description                             |
| --------- | -------- | --------------------------------------- |
| `scale`   | `number` | Atom sphere radius multiplier (the editor slider spans 0.1–2.0) |
| `opacity` | `number` | Transparency (0–1)                      |

#### `symmetry`

Expands a CIF's asymmetric unit into the full unit cell using the space-group
operations the parser captured. Structures without symmetry operations or
without a cell pass through unchanged. Ports: `particle`, `trajectory` in and out.

| Field  | Type                 | Description                                                          |
| ------ | -------------------- | -------------------------------------------------------------------- |
| `mode` | `"expand" \| "none"` | `"expand"` (default) applies the operations; `"none"` passes through |

#### `wrap`

Periodic-image coordinate mapping for the particle stream and its trajectory.
Ports: `particle`, `trajectory` in and out.

| Field  | Type                             | Description                                                                                                                          |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `mode` | `"none" \| "wrap" \| "unwrap"`   | `"none"` (default) passes through; `"wrap"` folds atoms into the home cell; `"unwrap"` makes molecules split across a periodic face whole |

#### `replicate`

Builds an `nx × ny × nz` supercell, copying atoms and bonds and enlarging the
cell. Requires a unit cell. Ports: `particle`, `cell`, `trajectory` in and out.

| Field              | Type     | Description                                                   |
| ------------------ | -------- | ------------------------------------------------------------- |
| `nx`, `ny`, `nz`   | `number` | Repeats along lattice vectors a, b, c (integers ≥ 1, default `1`) |

#### `color`

Per-stream coloring (Ovito-style). Accepts a `particle` input on the `in`
handle and emits the recolored particle stream on `out`.

| Field          | Type                | Description                                                                              |
| -------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `mode`         | `string`            | `"uniform"`, `"byElement"`, `"byResidue"`, `"byChain"`, `"byBFactor"`, `"byProperty"`, or `"illustrative"` |
| `uniformColor` | `string`            | Hex color used when `mode === "uniform"`                                                 |
| `range`        | `[number, number]?` | Optional `[min, max]` for `byBFactor` / `byProperty`                                     |

#### `representation`

Per-stream representation override (Ovito-style). The Viewport reads the
mode from the first connected particle stream that carries an override and
falls back to `"atoms"` otherwise. Accepts a `particle` input on the `in`
handle and emits the tagged particle stream on `out`.

| Field  | Type     | Description                                                                        |
| ------ | -------- | ---------------------------------------------------------------------------------- |
| `mode` | `string` | `"atoms"` (default), `"licorice"`, `"cartoon"`, `"both"`, `"surface"`, `"line"`, or `"illustrative"` |

#### `add_bond`

| Field        | Type     | Description                                                                                                                                                                          |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bondSource` | `string` | `"structure"` (bonds from the structure file), `"distance"` (VDW inference, the default), `"file"` (a separate topology file), or `"none"`                                        |
| `bondFileName` | `string?` | Optional. Name of the topology file used when `bondSource` is `"file"` (the parsed bonds themselves are not serialized)                                                    |
| `vdwScale`   | `number` | Optional. Threshold scale for `"distance"` mode: atoms bond when their separation is `≤ (vdw_i + vdw_j) * vdwScale`. Higher loosens (more bonds), lower tightens. Defaults to `0.6`. |

#### `label_generator`

| Field    | Type     | Description                            |
| -------- | -------- | -------------------------------------- |
| `source` | `string` | `"element"`, `"resname"`, or `"index"` |

#### `drawing_boundary`

Creates periodic display copies in an inclusive fractional-coordinate range.
It does not change structural atom indices or enlarge the unit cell.

| Field          | Type     | Description                                                |
| -------------- | -------- | ---------------------------------------------------------- |
| `xMin`, `xMax` | `number` | Inclusive bounds along lattice vector a (default `0`, `1`) |
| `yMin`, `yMax` | `number` | Inclusive bounds along lattice vector b (default `0`, `1`) |
| `zMin`, `zMax` | `number` | Inclusive bounds along lattice vector c (default `0`, `1`) |

#### `boundary_completion`

Adds bond-connected periodic display copies outside Drawing Boundary without
changing crystallographic coordinates. It requires both particle and bond
inputs and emits completed versions of both streams.

| Field  | Type     | Description                                                                                                               |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mode` | `string` | `"neighbors"` completes one bond shell; `"components"` completes only finite connected components (default `"neighbors"`) |

#### `coordination_generator`

Finds directed relationships between center atoms and their bonded neighbors.
It consumes Drawing Boundary copies and emits both reusable coordination data
and a renderable bond stream.

| Field             | Type       | Description                                                                                                                                  |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `excludedCenters` | `number[]` | Atomic numbers excluded from center detection (default `[]`)                                                                                 |
| `excludedLigands` | `number[]` | Atomic numbers excluded from neighbor detection (default `[]`)                                                                               |
| `cutoffTolerance` | `number`   | Multiplier applied to the sum of covalent radii (default `1.15`)                                                                             |
| `boundaryMode`    | `string`   | `"complete"` includes periodic neighbors outside the drawing range when needed by a visible center; `"inside"` searches only displayed atoms |

#### `polyhedron_generator`

Converts incoming center-neighbor coordination data to convex polyhedron meshes.
It owns only mesh appearance; periodic atom display and completing neighbors
outside the drawing range are handled upstream.

| Field       | Type      | Description                |
| ----------- | --------- | -------------------------- |
| `opacity`   | `number`  | Face transparency (0–1)    |
| `showEdges` | `boolean` | Display wireframe edges    |
| `edgeColor` | `string`  | Wireframe edge color (hex) |
| `edgeWidth` | `number`  | Wireframe edge width (px)  |

#### `surface_mesh`

| Field         | Type     | Description                                                                               |
| ------------- | -------- | ----------------------------------------------------------------------------------------- |
| `alphaRadius` | `number` | Probe sphere radius in Å (alpha value). Larger = smoother surface, smaller = more detail. |
| `color`       | `string` | Surface color (hex, e.g. `"#4488ff"`)                                                     |
| `opacity`     | `number` | Surface transparency (0–1)                                                                |

#### `load_volumetric`

| Field      | Type             | Description                                                                                        |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `fileName` | `string \| null` | Display name of the volumetric file (CUBE or OpenDX). Volumetric data (`volumetricData`) is ephemeral and not serialized. |

#### `isosurface`

| Field           | Type                          | Description                                                                                                            |
| --------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `isoLevel`      | `number`                      | Contour value for the positive isosurface                                                                              |
| `color`         | `string`                      | Hex color for the positive isosurface                                                                                  |
| `opacity`       | `number`                      | Surface transparency (0–1)                                                                                             |
| `showNegative`  | `boolean`                     | Show a second isosurface at −isoLevel (dual-contour for ESP maps)                                                      |
| `negativeColor` | `string`                      | Hex color for the negative isosurface                                                                                  |
| `colorMode`     | `"solid" \| "volume"`         | `"volume"` paints the surface by sampling the volume connected to the `colorVolumetric` input (e.g. ESP on a density)  |
| `colormap`      | `"rwb" \| "bwr" \| "rainbow"` | Colormap for `colorMode: "volume"` (`rwb` = red→white→blue, the chemistry ESP convention)                              |
| `colorRange`    | `[number, number]` (optional) | Explicit colormap range; omit for auto (symmetric around 0 for the diverging maps)                                     |

To color a charge-density isosurface by electrostatic potential, add a second
`load_volumetric` node for the ESP cube and connect its `volumetric` output to
the isosurface node's `colorVolumetric` input, then set `colorMode` to
`"volume"`.

#### `load_spectrum`

Loads a JCAMP-DX spectrum (`.jdx` / `.jcamp`). A spectrum has no 3D
coordinates, so its `spectrum` output feeds `spectrum_plot`, not the Viewport.

| Field      | Type             | Description                                                                 |
| ---------- | ---------------- | --------------------------------------------------------------------------- |
| `fileName` | `string \| null` | Display name of the JCAMP-DX file. The decoded spectrum is not serialized. |

#### `spectrum_plot`

Terminal node that draws its `spectrum` input as a 2D line chart.

| Field      | Type      | Description                                                             |
| ---------- | --------- | ----------------------------------------------------------------------- |
| `reverseX` | `boolean` | Draw the x axis high-to-low, the IR/NMR convention (default `true`)     |
| `color`    | `string`  | Hex stroke color of the trace (default `"#84cc16"`)                     |

#### `vector_overlay`

| Field   | Type     | Description                    |
| ------- | -------- | ------------------------------ |
| `scale` | `number` | Vector arrow length multiplier |

#### `viewport`

| Field                | Type      | Description                           |
| -------------------- | --------- | ------------------------------------- |
| `perspective`        | `boolean` | Perspective (`true`) or orthographic (`false`, default) projection |
| `cellAxesVisible`    | `boolean` | Show unit cell axes (default `true`)  |
| `pivotMarkerVisible` | `boolean` | Show rotation pivot marker (default `true`) |

## Edge Fields

| Field          | Type     | Description                                               |
| -------------- | -------- | --------------------------------------------------------- |
| `source`       | `string` | Source node `id`                                          |
| `target`       | `string` | Target node `id`                                          |
| `sourceHandle` | `string` | Output port name (e.g., `"particle"`, `"bond"`, `"mesh"`) |
| `targetHandle` | `string` | Input port name (e.g., `"particle"`, `"bond"`, `"in"`)    |

## Loading Behavior

When a pipeline is loaded (editor import, a share link, a `.megane.json` in VS
Code, `PipelineViewer`), Megane:

- rejects any `version` other than `3` and any unknown node `type`;
- fills missing parameters with the node's defaults and drops fields from older
  formats (e.g. `colorScheme` / `representationMode` on `viewport`, color fields
  on `modify`);
- migrates the older `particle → polyhedron_generator` shape by inserting
  `drawing_boundary` and `coordination_generator` nodes;
- completes the canonical `load_structure → add_bond → viewport` wiring: for
  each structure loader that feeds a viewport, an `add_bond` node is injected
  when no bond stream reaches the viewport, and the loader's `cell` (and, when
  `hasTrajectory` is `true`, its `trajectory`) output is connected to the
  viewport. Existing nodes and edges are never removed.

File names are resolved per host. VS Code reads `load_structure` and
`load_trajectory` files relative to the `.megane.json` file's directory
(absolute paths and paths that leave that directory are ignored). The React
`PipelineViewer` fetches each `load_structure` node's `fileUrl`. Python's
`Pipeline.from_dict()` resolves relative paths from the current working
directory.

## Example: Crystal with Polyhedra

```json
{
  "version": 3,
  "nodes": [
    {
      "id": "s1",
      "type": "load_structure",
      "position": { "x": 0, "y": 0 },
      "fileName": "perovskite_srtio3_3x3x3.xyz",
      "fileUrl": "perovskite_srtio3_3x3x3.xyz",
      "hasTrajectory": false,
      "hasCell": true
    },
    {
      "id": "boundary1",
      "type": "drawing_boundary",
      "position": { "x": 0, "y": 180 },
      "xMin": 0,
      "xMax": 1,
      "yMin": 0,
      "yMax": 1,
      "zMin": 0,
      "zMax": 1
    },
    {
      "id": "coord1",
      "type": "coordination_generator",
      "position": { "x": 0, "y": 360 },
      "excludedCenters": [38],
      "excludedLigands": [],
      "cutoffTolerance": 1.15,
      "boundaryMode": "complete"
    },
    {
      "id": "poly1",
      "type": "polyhedron_generator",
      "position": { "x": 170, "y": 530 },
      "opacity": 0.5,
      "showEdges": true,
      "edgeColor": "#dddddd",
      "edgeWidth": 2
    },
    {
      "id": "v1",
      "type": "viewport",
      "position": { "x": 0, "y": 615 },
      "perspective": false,
      "cellAxesVisible": true,
      "pivotMarkerVisible": true
    }
  ],
  "edges": [
    {
      "source": "s1",
      "target": "boundary1",
      "sourceHandle": "particle",
      "targetHandle": "particle"
    },
    {
      "source": "boundary1",
      "target": "coord1",
      "sourceHandle": "particle",
      "targetHandle": "particle"
    },
    {
      "source": "boundary1",
      "target": "v1",
      "sourceHandle": "particle",
      "targetHandle": "particle"
    },
    { "source": "s1", "target": "v1", "sourceHandle": "cell", "targetHandle": "cell" },
    { "source": "coord1", "target": "v1", "sourceHandle": "bond", "targetHandle": "bond" },
    {
      "source": "coord1",
      "target": "poly1",
      "sourceHandle": "coordination",
      "targetHandle": "coordination"
    },
    { "source": "poly1", "target": "v1", "sourceHandle": "mesh", "targetHandle": "mesh" }
  ]
}
```

## Example: Atom Filter with Branching

```json
{
  "version": 3,
  "nodes": [
    {
      "id": "s1",
      "type": "load_structure",
      "position": { "x": 170, "y": 0 },
      "fileName": "caffeine_water.pdb",
      "fileUrl": "caffeine_water.pdb",
      "hasTrajectory": false,
      "hasCell": false
    },
    {
      "id": "fc1",
      "type": "filter",
      "position": { "x": 0, "y": 150 },
      "query": "index < 24"
    },
    {
      "id": "mc1",
      "type": "modify",
      "position": { "x": 0, "y": 300 },
      "scale": 3.0,
      "opacity": 1.0
    },
    {
      "id": "fw1",
      "type": "filter",
      "position": { "x": 340, "y": 150 },
      "query": "index >= 24"
    },
    {
      "id": "mw1",
      "type": "modify",
      "position": { "x": 340, "y": 300 },
      "scale": 1.0,
      "opacity": 0.15
    },
    {
      "id": "v1",
      "type": "viewport",
      "position": { "x": 170, "y": 450 },
      "perspective": false,
      "cellAxesVisible": false,
      "pivotMarkerVisible": false
    }
  ],
  "edges": [
    { "source": "s1", "target": "fc1", "sourceHandle": "particle", "targetHandle": "in" },
    { "source": "fc1", "target": "mc1", "sourceHandle": "out", "targetHandle": "in" },
    { "source": "mc1", "target": "v1", "sourceHandle": "out", "targetHandle": "particle" },
    { "source": "s1", "target": "fw1", "sourceHandle": "particle", "targetHandle": "in" },
    { "source": "fw1", "target": "mw1", "sourceHandle": "out", "targetHandle": "in" },
    { "source": "mw1", "target": "v1", "sourceHandle": "out", "targetHandle": "particle" }
  ]
}
```
