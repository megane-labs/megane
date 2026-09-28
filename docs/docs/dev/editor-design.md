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
`Snapshot`. The working copy is typed arrays plus an implicit ref table (the
atoms of the file, or of the last whole-structure op, are addressed by their
index in it; only atoms an `add_atom` / `add_fragment` created carry an
explicit ref), so a supercell or a slab of a million atoms costs bytes per
atom rather than a string and a map entry each. It also reports, per output
atom, which ref it came from (`EditResult.refAt(i)`, or the materialised
`EditResult.outputRefs` list); the Builder uses that to translate a click on
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
- Cell-aware: `set_cell` replaces or removes the box (and, with `scaleAtoms`,
  keeps the atoms' fractional coordinates) and the loader emits the edited
  `cell` stream. The `trajectory` output follows the file: its frames index
  the atoms as loaded.

### Whole-structure ops (crystal tools)

`supercell`, `slab` and `expand_symmetry` do not edit atoms one by one: they
replace the working structure. The executor materialises the working copy
as a Snapshot, runs the transform (`src/crystal/transform.ts` —
`makeSupercell`, `buildSlab` — or the Symmetry node's own `expandSymmetry`),
and rebuilds the working copy from the result with every atom re-keyed as
`<id>:<k>`. Refs written before such an op therefore stop resolving after
it (a later `delete_atoms: [0]` is skipped with a warning), which is
intended: the Builder always addresses the structure it currently shows, and
the alternative — tracking each source atom through a supercell so that
"atom 3" means eight atoms — would make later ops ambiguous. `wrap` and
`center` only move atoms (and, with a vacuum, resize the cell) and keep
every ref. All of them mark the file's space-group operations as consumed
(`symmetryOps` is dropped from the output), so the viewer's Symmetry node
does not expand an already expanded or re-celled structure a second time.

The transforms live in `src/crystal/` because they are pure Snapshot →
Snapshot functions with no Builder or pipeline dependency: `cell.ts`
(parameters ⇄ vectors, fractional ⇄ Cartesian, the integer helpers),
`bulk.ts` (the prototype structures behind *New bulk crystal*) and
`transform.ts`. They are TypeScript ports of ASE — `bulk`, `make_supercell`,
`ase.build.surface` (the `general_surface` construction, extended Euclid
included, so slabs come out identical), `Atoms.wrap`, `Atoms.center` — and
ASE is the *test oracle*, never a runtime dependency:
`scripts/gen-crystal-fixtures.py` records what ASE produces for a fixed set
of inputs into `tests/fixtures/crystal/ase-oracle.json`, and
`tests/ts/crystal/` compares atom for atom (modulo lattice translations for
atoms that sit exactly on a cell face, where float32 and float64 wrap to
different sides). Bonds survive a transform by geometry rather than by index
bookkeeping: every source bond is a minimum-image vector, and it is re-drawn
wherever an image of its first atom has an image of its second atom at that
vector modulo the periodic axes of the result — so a supercell keeps every
bond (boundary bonds reach into the neighbouring image, as the Replicate
node draws them) and a slab drops the ones that would cross the vacuum.

## The Builder app and the 3D view

The Builder is its own application, not a panel or a mode of the viewer.
Building changes what a structure *is*; the viewer's pipeline describes how a
structure is *shown*, and every attempt to host editing inside the viewer
(a tab in the Pipeline panel, a stacked panel, an exclusive "edit mode" that
swapped the view) ended up with the two competing for the same column and
users unsure which of them the picture reflected. So `src/builder/` mounts
its own page (`builder.html`, a Vite entry beside `index.html` and the
multi-instance harness). It is laid out in the viewer's design language — the
3D view fills the window and every control floats over it on the viewer's
frosted-glass surfaces (`src/components/toolbarStyles.ts`, shared with the
viewer's Pipeline panel) — so that each control has exactly one home: the
viewer's `CollapsiblePanel` on the right, titled *Builder* with the document's
name beside it, whose header carries toolbar rows built like the Pipeline
panel's (`BuilderToolbar.tsx`: *Document* — the *File* menu for the
**document** (Open, New, Save; `topbarMenus.ts`), Undo / Redo; *Others* — the
viewer's `ThemeCycleButton`) and whose body is the **structure** (`Inspector.tsx`: the
structure summary, or the selected atoms with their positions, distance /
angle / dihedral and actions; the cell as a read-only card; history); the
viewer's Reset View and `ViewAxisControls` in the top-left corner with a
floating tool rail under them (`ToolRail.tsx`, one icon per tool with its
key) and, under that, the operations rail (`OperationsRail.tsx`: the
*Structure*, *Insert* and *Tools* menus for what acts on the structure,
`crystal/structureMenu.ts`, `tools/ToolServer.tsx`, their lists opening to
the right); a context bar over the top of the view (`ContextBar.tsx`, only the
settings the current tool uses — none for Select / Move / Delete); a status
line at the bottom left for what is on screen and what the tool does
(`toolHint`, the one place the hint is written); and one notice line above it
for every message the app has to show (`BuilderStore.notice`, written through
`reportError` / `reportInfo` so no panel keeps an error line of its own). The
menus (`Menu.tsx`) portal their lists to `<body>` because the panel clips its
overflow. `Section` (`src/builder/Section.tsx`)
makes the panel's history section collapsible and
remembers each one in `localStorage`; `shortcuts.ts` holds the key table
(`resolveShortcut`) and applies it to the store (`runShortcut`), ignoring keys
aimed at a text field or a dialog. Starting a document — an empty cell or a
bulk crystal — is one dialog (`NewStructureDialog`), because both replace
what is open. Nothing in the viewer imports the Builder; the Builder reuses
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

**Crystal.** The operations rail's *Structure* menu (`crystal/structureMenu.ts`)
lists every cell and crystal op: *Wrap*, *Remove cell* and *Expand
symmetry* push their op at once; *Set cell*, *Center with vacuum*,
*Supercell* and *Cut slab* open `crystal/CrystalDialog.tsx`, a panel in the
top-right of the view, left of the Builder panel, with one form per op. While a form describes a valid op
the dialog hands it to `BuilderStore.setPreview`, which applies it to the
edited structure without committing it; the view draws `viewSnapshot` (the
preview when there is one), `canEdit` is false so clicks are paused, and any
change to the document drops the preview. *Apply* pushes the op with a fresh
fragment id. Results above `PREVIEW_MAX_ATOMS` are announced but not
previewed, since building the preview is the cost of every keystroke. The
panel keeps only a read-only cell card (`crystal/CellCard.tsx`) with the
symmetry offer. The bulk-crystal form (`crystal/BulkForm.tsx`) is not in the
menu, because `BuilderStore.newBulk` starts a *new document* rather than
editing the open one; it lives in the New structure dialog beside the empty
cell. The slab form runs `slabPreview` on the shown structure to state the
atom count and thickness before the op is written. The Place
tool's *Place on atoms* option (`adsorbHeight` on the store,
`adsorptionSite` in `placement.ts`) stamps a library molecule a given
height above a clicked atom along the cell's c axis, which with a slab is
the surface normal — an adsorbate as one `add_fragment` op.

**Geometry.** `src/builder/geometry.ts` holds what moves together
(`moleculeOf`, and `movingSide` — the far side of a bond, or only the atom
when a ring joins the sides), the numeric edits (`setDistance`, `setAngle`,
`setDihedral`, which return a displacement per atom) and `superpose`, a
Kabsch fit by Horn's quaternion method. `BuilderStore.moveAtoms` writes
displacements as `move_atoms` ops — one per distinct displacement, pushed as
one Undo step — so numeric edits and the clean-up need no new op in the
`load_structure` edit vocabulary. `src/builder/cleanup.ts` is *Clean up
geometry*: `megane-rdkit` only exposes embedding, so each molecule goes to
the existing worker (`library/embed.ts`) as a V2000 block with `addHs` off
(RDKit then keeps our atom order), and the conformer is superposed back on
the old positions. On the way in, `unwrappedPositions` makes a molecule
split across the cell whole (minimum image along its bonds) and
`inferredCharges` writes `M  CHG` for over-bonded N / P / O / S / B, and a
molecule RDKit rejects is counted and left alone rather than failing the
rest. `editSteps` groups the history into Undo steps (an op and
its continuations) for the History list and the edit counts; the op list
itself is unchanged. The right-click menu is `AtomMenu.tsx` (`clampMenuPosition` keeps it on
screen); box selection reuses the viewer's `Viewport` `boxSelectActive` /
`onBoxSelect`, whose `additive` flag (Shift held) unions with the selection.
The element picker's periodic table is `PeriodicTable.tsx` (`tablePosition`).
`addFragment` with no document opens an `emptySnapshot()` (no cell) first, so
the Place tool and its gallery work before anything is open. The 3D view's
background follows the theme store (`themeToHex`), as in the viewer. As in
the viewer, the frustum is inset by the panel's width while it is open
(`setViewInsets`), so the structure centres in the part of the view left of
the panel, and a
Structure preview starting or ending refits the camera (`resetView`, which
keeps the orientation).

**Library.** `src/builder/library/` holds the molecule library the Place
tool's gallery offers (and the Insert menu and the Inspector's *Save as
fragment*): `presets.ts` (small molecules with 3D geometries), a persisted
`useLibraryStore` (`store.ts`, the user's molecules in `localStorage`,
sanitized on read), `fragment.ts` (centring, Hill formulas, the flat-sketch
rescale, `autoPlacement`, and `fragmentOp` — the `add_fragment` op a
placement writes), `hydrogens.ts` (valence-rule hydrogen counts and their
3D placement), `sketch.ts` (a molfile, file or selection → library
molecule, through the shared parsers), the actions and the shared UI state
(`ui.ts`: `useLibraryActions`, and `useLibraryUi` for the one sketch dialog,
the one file input and the gallery's open state, mounted once by
`LibraryHost`), and the UI (`LibraryPanel`, the gallery under the context
bar, and `SketchModal`). Ketcher (`ketcher-react` + the standalone Indigo engine) is
mounted only by `KetcherEditor.tsx`, which `SketchModal` loads lazily, so the
sketcher's bundle and WASM are fetched on first use and the Builder itself
stays small. A molecule enters the document through
`BuilderStore.addFragment`, either at `autoPlacement` (the *Add* button) or
where the *Place* tool's click landed (`BuildHandlers.pick` with
`placeSource` set); the new atoms are selected so a Move drag carries them
together.

Rendered atom indices are translated to op refs through `result.refAt`
before an op is written, so an op always names the atom the user saw. Drags
write one `move_atoms` op at press time and rewrite its delta while the
pointer moves, so the history gains a single op; a drag that ends with a zero
delta is removed again without touching the redo stack.

## Sketch embedding (RDKit)

A Ketcher sketch is a flat molfile; the library turns it into a 3D molecule
with RDKit and with nothing else — no conformer, and no hydrogen placement,
is ever invented in TypeScript. RDKit runs in the browser as
[`megane-rdkit`](https://github.com/hodakamori/megane-rdkit), an Emscripten
build of an unmodified RDKit release that exposes exactly one call today —
`embed(molfile, options)`: ETKDG embedding with the implicit hydrogens
added, then MMFF94s (UFF fallback) minimisation, returning a V2000 mol
block. The build lives in its own repository because it needs emsdk, Boost
and a C++ toolchain nothing else in megane touches; megane depends on the
published npm package and Vite ships its `.wasm` (~3.5 MB, ~1 MB gzipped) as
an asset that is fetched only when the sketch dialog first embeds.

`src/builder/library/embed.ts` is the main-thread client: one lazily created
Web Worker (`embed.worker.ts`) holds the module, requests carry the `.wasm`
URL resolved on the main thread (the worker cannot know the page's base), and
a crashed or silent worker is torn down so the next request starts a fresh
one. `draftFromMolfile` in `sketch.ts` sends the molfile to RDKit, runs the
mol block it returns through the shared MOL parser and centres it; the
Ketcher molfile is kept on the library entry so *Edit* reopens the drawing,
not the conformer. Where RDKit cannot run (no Web Workers, a drawing it
cannot sanitise) the dialog reports the error and adds nothing. The *flat*
mark on a library entry is reserved for imported 2D files, which are only
rescaled to Å.

## Writers

megane had no structure writer before this feature. `crates/megane-core/src/writer.rs`
adds XYZ (extended XYZ when a cell is present), PDB (`CRYST1`, `ATOM`,
`CONECT`) and MOL V2000, exposed as `write_structure` through both WASM
(`src/parsers/parseCore.ts` → `src/export/structureExport.ts`) and PyO3
(`megane.write_structure` / `megane.save_structure`). Delivery uses the existing
host-neutral `downloadBlob`, which the VS Code webview already routes to its
save dialog.

## Deliberately not in this iteration

- **Space-group generation and termination enumeration** — building a bulk
  from a space-group number plus Wyckoff positions (`ase.spacegroup.crystal`)
  needs the 230 groups' operation tables embedded; listing the distinct
  terminations of a slab (pymatgen's `SlabGenerator.get_slabs`) and
  primitive / conventional cell detection need spglib, which would go into
  the `megane-rdkit` Emscripten build as a second module.
- **Bake to file** — collapsing a long history into a re-loaded file. The
  writer makes this possible; it needs a host-specific "replace the loaded
  file" flow.
- **Trajectory editing** — the loader's trajectory output follows the file;
  an edited atom count no longer matches the frames.
- **Save in place** — VS Code's editor is a `CustomReadonlyEditorProvider` and
  JupyterLab's document widget never calls `context.save()`; both stay
  save-as / download for now.
- **Python structure tools** — liquid boxes, polymer chains, solvation and
  other generators that already exist in Python are meant to reach Builder as
  buttons backed by MCP servers rather than as TypeScript ports; the draft
  contract is [Builder Tool Contract (MCP)](/dev/builder-tools).
- **Live-MD integration** — a "reload structure" command on the simulation side
  (stop → rebuild system → re-send topology), driven by megane's exporter.
