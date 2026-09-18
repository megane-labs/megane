---
title: Structure Editor Design
---

How structure editing (the **Build** panel) is built, why it lives where it
does, and what is deliberately left for later. Read this before extending the
editor or wiring it to a simulation backend.

## Where it lives

Editing is implemented **inside megane** as a pipeline node plus a panel, not
as a separate repository and not inside a simulation engine:

- It is tightly coupled to megane internals that are not public API — the
  `Snapshot` layout, screen-space picking (`src/renderer/Picking.ts`), the
  renderer facade, and the zustand store bundle. A separate repository would
  first have to expose all of those.
- A live-MD service (such as `livemd`) treats topology as fixed for the life of
  a session: its `Topology` is sent once per connection and the OpenMM context
  cannot grow after creation. Editing there would mean rebuilding the session,
  which is the right *integration* (export the edited structure, start a new
  session) but the wrong place for the editor itself.

The division of labour is: megane builds and repairs the structure *before* it
is simulated; a simulation backend only needs a way to accept a new structure.

## The edit node (rule #11 in `AGENTS.md`)

Anything that changes what the user sees is a pipeline node's job, so edits are
not applied to the loaded `Snapshot`. Instead the **`edit` node** carries an
ordered list of operations (`EditOp` in `src/pipeline/types.ts`) and its
executor (`src/pipeline/executors/edit.ts`) replays them on every run,
emitting a brand-new immutable `Snapshot` exactly like `replicate` does. This
gives undo (drop the last op), disable (toggle the node), sharing (ops ride in
the `.megane.json`) and LLM authoring (the node is in `NODE_CATALOG` with
`inPrompt: true`) without any new persistence path.

### Atom identity

Ops never refer to atoms by their position in the *current* array, which would
shift on every deletion. An `EditAtomRef` is either

- a **number** — an index into the node's *input* stream (the structure as the
  file declares it), or
- a **string** — the id assigned by an earlier `add_atom` (`id`) or
  `add_fragment` (`<fragmentId>:<k>`) op in the same list.

The executor keeps a working copy keyed by ref, rebuilds the ref → index map
after deletions, and materialises indices only when it builds the output
`Snapshot`. It also reports, per output atom, which ref it came from
(`EditResult.outputRefs`); the Build panel uses that to translate a click on
rendered atom *i* into the ref an op must name.

Because refs address the *input* stream, the node is placed **directly after
`load_structure`** (`src/pipeline/editSync.ts` splices it in and re-sources the
loader's `particle` / `cell` consumers). Nodes that change the atom count
(`replicate`, `symmetry`) come after it; if such a node is active the panel
cannot map rendered indices back and pauses with a notice rather than writing
ops against the wrong atoms. `sourceAtomCount` records the atom count the ops
were authored against so a different file under the same history produces a
node warning instead of silent misapplication.

### What the executor guarantees

- Pure: the input `Snapshot` is never mutated.
- Tolerant: an unknown ref or malformed op is skipped and reported as a node
  warning; one bad op never blanks the structure.
- Complete: chain ids, B-factors and the Cα backbone arrays are carried and
  remapped; `nFileBonds` is set to the full bond count because every surviving
  bond is now asserted by the edit; per-atom overrides and selections on the
  incoming `ParticleData` are remapped, and new atoms get neutral values.
- Cell-aware: `set_cell` replaces or removes the box and the node re-emits the
  `cell` stream.

## Build panel and the 3D view

The panel is its own surface, not a tab of the Pipeline panel: `MeganeViewer`
stacks a second `CollapsiblePanel` under the Pipeline panel in the same
column (same width, the Pipeline panel's bottom edge is raised to make room)
and the Pipeline panel header carries the launcher. Two reasons. Editing the
molecule is a different activity from authoring the pipeline, so it should
not compete with Editor / Inspector / Chat for the same tab strip; and the
pipeline *is* the edit history, so the Editor must stay visible while the
`edit` node grows. Whether the 3D view is in edit mode follows one flag
(`buildOpen` in `usePipelineUIStore`), never which tab happens to be in front.
The flag is not persisted: an open panel changes what a click means, so every
session starts with it closed.

`src/components/BuildPanel.tsx` owns no atom data. It holds UI state in
`useBuildStore` (tool, element, bond order, selection, pending bond atom, redo
stack) and installs four callbacks (`pick`, `dragStart`, `dragMove`,
`dragEnd`) in that store. `MeganeViewer` hands them to the `Viewport`, which
already implements the "suspend camera, hit-test, act" pattern for the
Inspector's box select:

- a left press on an atom asks `dragStart`; if the Move tool accepts, camera
  controls are suspended for that drag only, and `dragMove` receives the world
  displacement in the camera-facing plane through the atom
  (`screenDragToWorldDelta` in `Picking.ts`);
- otherwise a press that barely moves is a click, reported to `pick` with the
  atom index or, on empty space, the world point at the pivot's depth.

Drags write one `move_atoms` op at press time and rewrite its delta while the
pointer moves (`replaceLastEditOp`), so the pipeline re-executes for live
preview but the history gains a single op. A drag that ends with a zero delta
is removed again.

Undo is `undoEditOp` (pop) plus a push onto the panel's redo stack; any new op
clears the redo stack. Everything the panel does goes through three store
actions — `pushEditOp`, `replaceLastEditOp`, `undoEditOp` — so a host can drive
the same edits without the panel (the Jupyter widget path).

## Writers

megane had no structure writer before this feature. `crates/megane-core/src/writer.rs`
adds XYZ (extended XYZ when a cell is present), PDB (`CRYST1`, `ATOM`,
`CONECT`) and MOL V2000, exposed as `write_structure` through both WASM
(`src/parsers/parseCore.ts` → `src/export/structureExport.ts`) and PyO3
(`megane.write_structure` / `megane.save_structure`). Delivery uses the existing
host-neutral `downloadBlob`, which the VS Code webview already routes to its
save dialog.

## Deliberately not in this iteration

- **Bake to file** — collapsing a long history into a re-loaded file. The
  writer makes this possible; it needs a host-specific "replace the loaded
  file" flow.
- **Hydrogen addition / valence rules** — chemistry belongs in Python (RDKit as
  an optional dependency), not in the TypeScript panel.
- **Fragment library** — `add_fragment` exists in the op set; a picker UI does
  not yet.
- **Trajectory editing** — the `edit` node does not route trajectories; an
  edited atom count no longer matches the frames.
- **Save in place** — VS Code's editor is a `CustomReadonlyEditorProvider` and
  JupyterLab's document widget never calls `context.save()`; both stay
  save-as / download for now.
- **Live-MD integration** — a "reload structure" command on the simulation side
  (stop → rebuild system → re-send topology), driven by megane's exporter.
