---
title: Structure Editor Design
---

How structure editing (**megane Builder**, the standalone editor at
`/builder.html`, and the edit engine it shares with the viewer's
`load_structure` node) is built, why it lives where it does, and what is
deliberately left for later. Read this before extending the editor or wiring
it to a simulation backend.

## Where it lives

Editing is implemented **inside megane** — a second app entry in the same
repository (`builder.html` → `src/builder/`) on top of a shared edit engine —
not as a separate repository and not inside a simulation engine:

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

## The edit list lives on the loader (rule #11 in `AGENTS.md`)

Parsers read files as-is, so edits are never applied inside a parser. They are
also not a node of the view pipeline: the graph describes how a structure is
*shown*, while an edit changes what it *is*. The two are kept apart by storing
the ordered operation list (`EditOp` in `src/pipeline/types.ts`) on the primary
`load_structure` node (`LoadStructureParams.edits`, helpers in
`src/pipeline/editHistory.ts`). The loader executor
(`src/pipeline/executors/loadStructure.ts`) replays the list on the loaded
`Snapshot` through `applyEditOps` (`src/pipeline/executors/edit.ts`) and emits
the edited structure as a brand-new immutable `Snapshot`, so every downstream
node only ever sees the edited atoms and the graph gains no node. This gives
undo (drop the last op), preview (`editsBypassed` in the pipeline store, the
panel's "Show original"), sharing (the list rides in the `.megane.json` with the
loader) and LLM authoring (`edits` is documented on `load_structure` in
`NODE_CATALOG`) without any new persistence path.

An earlier iteration made the history a standalone `edit` node spliced after
the loader. It worked, but it put "what the molecule is" and "how it looks" in
the same graph, and the node had to be placed and re-wired by the panel; the
loader-level list removes both problems.

### Atom identity

Ops never refer to atoms by their position in the *current* array, which would
shift on every deletion. An `EditAtomRef` is either

- a **number** — an index into the structure as the file declares it, or
- a **string** — the id assigned by an earlier `add_atom` (`id`) or
  `add_fragment` (`<fragmentId>:<k>`) op in the same list.

The executor keeps a working copy keyed by ref, rebuilds the ref → index map
after deletions, and materialises indices only when it builds the output
`Snapshot`. It also reports, per output atom, which ref it came from
(`EditResult.outputRefs`); the Builder uses that to translate a click on
rendered atom *i* into the ref an op must name.

Because refs address the file's atoms, the list is replayed *before* anything
else runs. Nodes that change the atom count (`replicate`, `symmetry`) come
after; if such a node is active the panel cannot map rendered indices back and
pauses with a notice rather than writing ops against the wrong atoms. The
history belongs to the file it was authored against: `updateNodeParams` clears
a loader's `edits` when its `fileName` changes, and an op that no longer
applies is skipped with a warning on the loader.

### What the executor guarantees

- Pure: the input `Snapshot` is never mutated.
- Tolerant: an unknown ref or malformed op is skipped and reported as a node
  warning; one bad op never blanks the structure.
- Complete: chain ids, B-factors and the Cα backbone arrays are carried and
  remapped; `nFileBonds` is set to the full bond count because every surviving
  bond is now asserted by the edit. Nothing upstream carries per-atom
  overrides or selections (the loader is the source), so none need remapping.
- Cell-aware: `set_cell` replaces or removes the box and the loader emits the
  edited `cell` stream. The `trajectory` output follows the file: its frames
  index the atoms as loaded.

## The Builder app and the 3D view

The Builder is its own application, not a panel or a mode of the viewer.
Building changes what a structure *is*; the viewer's pipeline describes how a
structure is *shown*, and every attempt to host editing inside the viewer
(a tab in the Pipeline panel, a stacked panel, an exclusive "edit mode" that
swapped the view) ended up with the two competing for the same column and
users unsure which of them the picture reflected. So `src/builder/` mounts
its own page (`builder.html`, a Vite entry beside `index.html` and the
multi-instance harness) with a top bar (Open / New / Undo / Redo / Save), the
3D view, a sidebar (tools, element, selection, new cell, history, export) and
a status bar. Nothing in the viewer imports the Builder; the Builder reuses
the viewer's renderer, parsers, writers and edit engine. Bringing a Builder
document into the viewer is the planned integration, and the shared history
format (below) is its seam.

**Document.** `useBuilderStore` (`src/builder/store.ts`) holds a source
`Snapshot` (the opened file, or `emptyCellSnapshot(edge)` for *New*), its
per-atom labels and file name, the ordered `edits: EditOp[]`, a `redoStack`,
the *Show original* flag, and `result = applyEditOps(source, edits)`
recomputed on every change. The source is never mutated; what the view shows
(`shownSnapshot`) is the result, or the source alone under the preview. Undo
pops the last op onto the redo stack, Redo pushes it back, any new op clears
the stack; `replaceLastOp` rewrites the tail while a drag is in progress. A
`revision` counter bumps on every change that reshapes the rendered
structure without replacing the document, and the app hands it to
`Viewport.preserveCameraKey` so edits never move the camera while a new file
or cell still re-fits. There is no pipeline graph anywhere in the app.

**View.** `builderViewportState(shown)` (`src/builder/view.ts`) turns the
shown snapshot into a `ViewportState`: one particle stream with every atom,
the structure's own bonds drawn straight from the snapshot regardless of
`nFileBonds` (`bondDataFromSnapshotBonds`, so parser-inferred bonds and the
ones the user drew are shown alike, PBC half-bonds included), the cell, no
trajectory, no overlays, ball-and-stick. `BuilderApp` drives the renderer
through the same `applyViewportState` the viewer uses, so the Builder does not
fork the renderer.

**Clicks.** `useBuilderHandlers` installs four callbacks (`pick`, `dragStart`,
`dragMove`, `dragEnd`) as `BuildHandlers` (`src/builder/types.ts`), and the
app passes them to the `Viewport` with `buildActive` permanently on. The
Viewport already implements the "suspend camera, hit-test, act" pattern for
the Inspector's box select:

- a left press on an atom asks `dragStart`; if the Move tool accepts, camera
  controls are suspended for that drag only, and `dragMove` receives the world
  displacement in the camera-facing plane through the atom
  (`screenDragToWorldDelta` in `Picking.ts`);
- otherwise a press that barely moves is a click, reported to `pick` with the
  atom index or, on empty space, the world point at the pivot's depth.

**Library.** `src/builder/library/` holds the molecule library the sidebar
offers: `presets.ts` (small molecules with 3D geometries), a persisted
`useLibraryStore` (`store.ts`, the user's molecules in `localStorage`,
sanitized on read), `fragment.ts` (centring, Hill formulas, the flat-sketch
rescale, `autoPlacement`, and `fragmentOp` — the `add_fragment` op a
placement writes), `hydrogens.ts` (valence-rule hydrogen counts and their
3D placement), `sketch.ts` (a molfile, file or selection → library
molecule, through the shared parsers), and the UI (`LibrarySection`,
`SketchModal`). Ketcher (`ketcher-react` + the standalone Indigo engine) is
mounted only by `KetcherEditor.tsx`, which `SketchModal` loads lazily, so the
sketcher's bundle and WASM are fetched on first use and the Builder itself
stays small. A molecule enters the document through
`BuilderStore.addFragment`, either at `autoPlacement` (the *Add* button) or
where the *Place* tool's click landed (`BuildHandlers.pick` with
`placeSource` set); the new atoms are selected so a Move drag carries them
together.

Rendered atom indices are translated to op refs through `result.outputRefs`
before an op is written, so an op always names the atom the user saw. Drags
write one `move_atoms` op at press time and rewrite its delta while the
pointer moves, so the history gains a single op; a drag that ends with a zero
delta is removed again without touching the redo stack.

## Sketch embedding (RDKit)

A Ketcher sketch is a flat molfile; the library turns it into a 3D molecule
with RDKit rather than inventing a conformer in TypeScript. RDKit runs in the
browser as [`megane-rdkit`](https://github.com/hodakamori/megane-rdkit), an
Emscripten build of an unmodified RDKit release that exposes exactly one
call today — `embed(molfile, options)`: ETKDG embedding with the implicit
hydrogens added, then MMFF94s (UFF fallback) minimisation, returning a V2000
mol block. The build lives in its own repository because it needs emsdk,
Boost and a C++ toolchain nothing else in megane touches; megane depends on
the published npm package and Vite ships its `.wasm` (~3.5 MB, ~1 MB gzipped)
as an asset that is fetched only when the sketch dialog first embeds.

`src/builder/library/embed.ts` is the main-thread client: one lazily created
Web Worker (`embed.worker.ts`) holds the module, requests carry the `.wasm`
URL resolved on the main thread (the worker cannot know the page's base), and
a crashed or silent worker is torn down so the next request starts a fresh
one. `draftFromMolfile` in `sketch.ts` takes `embed3D`: on, RDKit's mol block
goes through the shared MOL parser and is centred (nothing else is touched —
the geometry is RDKit's); off, the sketch is read as drawn, rescaled to Å and
completed with the valence-rule hydrogens of `hydrogens.ts` placed by steric
number, and the entry is marked *flat*. The dialog defaults to embedding
wherever Web Workers exist and leaves the flat path as the user's opt-out and
the fallback for a drawing RDKit cannot sanitise. Either way the Ketcher
molfile is kept on the library entry so *Edit* reopens the drawing, not the
conformer.

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
- **Trajectory editing** — the loader's trajectory output follows the file;
  an edited atom count no longer matches the frames.
- **Save in place** — VS Code's editor is a `CustomReadonlyEditorProvider` and
  JupyterLab's document widget never calls `context.save()`; both stay
  save-as / download for now.
- **Live-MD integration** — a "reload structure" command on the simulation side
  (stop → rebuild system → re-send topology), driven by megane's exporter.
