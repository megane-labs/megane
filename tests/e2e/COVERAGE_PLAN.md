# megane E2E coverage roadmap

A working list of E2E gaps and the order in which they should be filled.
The goal is to graduate the suite from "viewer mounts and parses files on
five hosts" (current state, ~41 tests) to "every user-facing feature of
megane has at least one cross-host regression test."

Refer to this file when picking up follow-up work; check items off as
they land. Items are grouped by phase — earlier phases unblock later
ones.

---

## Phase 0 — current state (done in PR #307)

- 5 distribution targets exercised end-to-end (webapp / jupyterlab-doc /
  widget-jupyterlab / vscode / widget-vscode).
- 5 file formats (PDB / GRO / XYZ / MOL / SDF) on every host that uses
  the WASM parser path; multiple PDB fixtures on the legacy
  `MolecularViewer.load()` hosts.
- Sidebar collapse, frame seek, playback toggle, fps dropdown,
  pipeline-editor mount, render-modal open, drag-and-drop pipeline
  file (webapp).
- 54 committed pixel baselines.

Everything below is **not** in PR #307.

## Phase 2 — landed in PR #309

Phase 2 (sections 2.1–2.5) plus the Phase 1.4 / 1.7 source-side
prerequisites landed in PR #309 on branch
`claude/e2e-coverage-phase-2-sKNgQ`. 11 source/test commits + 1
prettier autofix; all 8 CI checks green on the merge head.

Highlights:

- `__megane_test` namespace + `__megane_test_pipeline_store` exposing
  `getProjectedAtomPositions`, `getCameraState`,
  `getVisibleSubsystems`, `setCameraMode`, `resetCamera`, `alignCamera`
  (issue #661 axis views), and programmatic pipeline editing.
- `AppearancePanel` mounted in `MeganeViewer` (webapp /
  jupyterlab-doc / vscode shell).
- `MolecularViewer.load()` dispatches by extension (PDB / GRO / XYZ /
  MOL / SDF / CIF / LAMMPS data / .traj).
- New helper modules: `host-fixture.ts` (cross-host boot),
  `pipeline.ts` (graph editing), `widget-api.ts` (notebook rewrite +
  Run All), `render-utils.ts` (typed `__megane_test` wrappers).
- New playwright project matrix: `<feature>__<host>` for 5 features ×
  5 hosts = 25 entries.
- 5 new specs: `appearance.spec.ts`, `modify-node.spec.ts`,
  `camera.spec.ts`, `measurement.spec.ts`,
  `subsystem-rendering.spec.ts`.
- Baselines: 50 → 65 (+15 webapp baselines). Cross-host baselines for
  jupyterlab-doc / vscode / widget-jupyterlab / widget-vscode are a
  mechanical follow-up (`MEGANE_E2E_UPDATE=1 npx playwright test
--project=...`).

What is still OPEN after PR #309 (tracked below):

- All of Phase 1 except 1.4 / 1.7.
- Phase 2.5 vector / arrow rendering (label_generator and
  polyhedron_generator landed; the vector overlay needs a fixture
  `.vec` file that isn't bundled today).
- AppearancePanel mount inside `WidgetViewer` so the appearance spec
  can light up on widget-jupyterlab / widget-vscode (currently
  skipped with an explanatory message).
- Cross-host baseline seeding for the 4 non-webapp hosts.

---

## Phase 1 — easy wins (no source changes required)

Pure spec / fixture additions. Should be doable as a single follow-up
PR per host.

### 1.1 Pipeline graph editing (`pipeline-editor` project, webapp)

- [ ] Drag a node from the palette onto the canvas.
- [ ] Connect two nodes by dragging an edge between their handles.
- [ ] Delete a node via keyboard shortcut.
- [ ] Edit a node's `fileName` parameter and confirm the renderer
      re-runs.
- New testids needed in `src/components/PipelineEditor*` and
  `src/components/nodes/*`. The shell already exposes
  `pipeline-node-${nodeType}` (see `NodeShell.tsx:25`); extend with
  `pipeline-node-handle-${id}-{in,out}` and a palette item testid.
- Acceptance: each test ends with `waitForReady` and a viewer-region
  baseline showing the post-edit render.

### 1.2 Trajectory frame coverage (`playback` project)

- [ ] Sweep all five frames of `caffeine_water` and capture a baseline
      at each. Catches "renderer caches frame 0 buffers" regressions.
- [ ] FPS=1 vs FPS=15 visual baselines after a fixed elapsed time.
- [ ] Loop wrap-around (frame N → frame 0).

### 1.3 Crystal / cell rendering (`format-loading` project)

- [ ] Add a CIF fixture with a small cubic cell (e.g. NaCl is already
      committed). Capture a baseline showing the cell box edges.
- [ ] Add a fixture with a triclinic cell.
- [ ] Toggle cell-axes visibility (needs new testid in
      `CellAxesRenderer` exposure).
- [ ] PBC unwrapping toggle.

### 1.4 Multi-format on widget hosts

Currently widget-jupyterlab / widget-vscode are PDB-only because
`MolecularViewer.load()` is hard-wired. Two paths:

- [ ] Use `viewer.set_pipeline(megane.Pipeline.load(json))` for
      non-PDB formats (programmatic, no API change).
- [x] Or extend `MolecularViewer.load()` to dispatch on extension
      (small Python change in `python/megane/widget.py:86`). **(PR #309)**
      Widget hosts now run an `xyz-si-diamond` regression alongside the
      legacy PDB fixtures.

### 1.5 Pipeline file format on remaining hosts

- [ ] `.megane.json` open in **vscode pipelineViewer** (a custom editor
      view-type already exists; see `vscode-megane/src/extension.ts:18`).
- [ ] `.megane.json` open in **jupyterlab-doc** (DocWidget supports it).

### 1.6 Render-modal output (without FFmpeg)

- [ ] Click "Save PNG" and assert the download triggers (use
      `page.waitForEvent('download')`). FFmpeg-gated GIF/MP4 stays
      skipped; PNG export is pure-canvas and runs on every machine.
- [ ] Verify the resolution / background-color inputs round-trip
      through the renderer.

### 1.7 Widget API quick fixes

- [x] Fix `widget-api.spec.ts:103` failure. **(PR #309)** Replaced the
      `window.jupyterapp` lookup with a notebook-rewrite + Run All
      pattern via the existing `openLabNotebook` helper, removing the
      shim entirely.
- [x] Add coverage for `viewer.set_pipeline(...)` programmatic
      assignment. **(PR #309)** Builds a minimal LoadStructure →
      Viewport pipeline pointing at `water_wrapped.pdb` and asserts
      `data-atom-count` flips from the original fixture's 3024 atoms.

---

## Phase 2 — needs small source changes

These require modest changes in the React/renderer code so the test
runner can observe state. None of them are user-visible.

### 2.1 AppearancePanel coverage

Source state:

- 6 testids already exist (`appearance-{atom,bond}-{opacity,scale}`,
  `appearance-vdw-scale`, `appearance-vector-scale`).
- The panel does **not** mount in the webapp shell currently.

Plan:

- [x] Mount `AppearancePanel` inside the webapp's right sidebar (under
      a CollapsiblePanel). **(PR #309)** Mounted in `MeganeViewer.tsx`
      with `top=60` so it stacks below the pipeline-editor chip.
      `WidgetViewer` mount is open as a follow-up (the
      "AppearancePanel already mounted in widget hosts" assumption
      turned out to be wrong).
- [x] Add `appearance` Playwright project + spec: drag each slider,
      confirm `data-megane-context="webapp"`,
      `expectViewerRegionMatch` baselines per slider end-position.
      **(PR #309)** `tests/e2e/appearance.spec.ts` — 7 webapp
      baselines.
- [x] Cross-host scaffold: same spec routed via `host-fixture.ts`.
      **(PR #309)** Webapp / jupyterlab-doc / vscode wired through
      `phase2Matrix`. Webapp baselines committed; the other two host
      baselines are a mechanical follow-up. Widget hosts skip until
      `WidgetViewer` mounts AppearancePanel.

### 2.2 Modify-node sliders

- 2 testids already in `src/components/nodes/ModifyNode.tsx`
  (`modify-node-opacity`, `modify-node-scale`).
- [x] Insert a Modify node into the default pipeline graph (extends
      Phase 1.1). **(PR #309)** `tests/e2e/modify-node.spec.ts` uses
      `pipeline.insertNode(scope, "modify")` + `connectEdge` to wire
      `loader-1 → modify → viewport-1` programmatically.
- [x] Slide each, assert renderEpoch advances, capture baseline.
      **(PR #309)** Sliders driven via `setNodeParam` (avoids React
      Flow node-DOM coupling); `renderEpoch` advance + viewer-region
      baseline per slider value. 3 webapp baselines committed.

### 2.3 Camera operations

The OrbitControls drag path is non-deterministic. Either:

- [x] Add a `viewer.setCameraMode(...)` and
      `viewer.resetCamera()` programmatic API on the renderer (already
      partially in place, just not exposed) and drive it from the test.
      **(PR #309)** Public `setCameraMode` / `resetCamera` methods on
      `MoleculeRenderer` + `__megane_test` namespace bindings.
- [ ] Or add `data-camera-state` attribute on `viewer-root` so the test
      can poll position / target rather than driving the mouse. — not
      needed; `__megane_test.getCameraState()` provides typed state
      reads.
- Tests:
  - [x] perspective ↔ ortho switch baseline parity **(PR #309)**
  - [x] resetCamera restores fitted target (delta < 1e-3) **(PR #309)**
  - [x] initial view is the VESTA standard orientation of the fixture cell;
        `alignCamera('+c')` and the ±a…±z buttons turn the camera onto an
        axis keeping target / distance / zoom **(issue #661)**
  - [ ] pivot animation (smooth lerp) renderEpoch increments
  - [ ] frustum-inset baseline (camera respects sidebar width)

### 2.4 Atom selection / measurement

Per `e2e-coverage` skill notes, this was pulled from the previous PR
because the renderer does not expose projected atom positions. Plan:

- [x] Add `viewer.getProjectedAtomPositions()` to the renderer, gated on
      `_testMode` (already used by other hooks). **(PR #309)**
- [x] Expose it on `window.__megane_test` (alongside
      `__megane_test_ready`). **(PR #309)**
- [x] Spec: query positions, click on the atom whose projected (x,y)
      matches, assert `[data-testid="measurement-panel"]` shows
      `data-selection-count="1"`. **(PR #309)**
- [x] Coverage for `measurement-clear`, multi-atom selection (count=2).
      **(PR #309)** Count=3 / dihedral coverage left as a follow-up.

### 2.5 Vector / arrow / label / polyhedron rendering

Each of these is a separate Renderer subsystem. They mount when the
pipeline contains a corresponding node.

- [x] Add fixture pipelines that include each kind of node + matching
      data file. **(PR #309)** label_generator and polyhedron_generator
      injected programmatically via `pipeline.insertNode`. The vector
      overlay still needs a bundled `.vec` fixture — left open.
- [x] Cross-host viewer-region baselines. **(PR #309)** Webapp
      baselines committed; cross-host seeding mechanical.
- [ ] Toggle visibility via the AppearancePanel slider for each
      subsystem — depends on `WidgetViewer` mount of AppearancePanel
      and exposing per-subsystem toggles in the panel UI.

---

## Phase 3 — coverage breadth

These are nice-to-haves that take time but no architectural work.

### 3.1 Cross-host fixture

Currently each spec hard-codes its host. The `e2e-coverage` skill
mentions a `tests/e2e/lib/host-fixture.ts` that _should_ exist but
doesn't. Plan:

- [ ] Implement `hostFixture()` that reads `MEGANE_HOST` and returns
      `{ scope, project, context }` (see skill snippet).
- [ ] Migrate **every feature spec** (`format-loading`, `playback`,
      `sidebar`, `pipeline-editor`, `pipeline-file`, `render-modal`,
      `appearance`, `measurement`) to use it.
- [ ] Run each one against all 5 hosts via `for host in ...; do
    MEGANE_HOST=$host npm run test:e2e:<feature>; done`.

This explodes the matrix from ~41 tests to ~150 tests but each new
combination is a free regression-detection seat.

### 3.2 More fixture diversity

- [ ] Large protein (>50k atoms) — performance regression marker.
- [ ] Long trajectory (>1000 frames) — frame-cache regression marker.
- [ ] Mixed-element fixture (>10 distinct atomic numbers) — palette
      regression marker.
- [ ] PDB with HETATM ligands that need bond-perception — bond
      generation regression marker.

### 3.3 Save / dirty-state

- [ ] DocWidget: edit pipeline → Ctrl+S → dirty indicator clears →
      reopen file → state preserved.
- [ ] VSCode pipelineViewer: same.
- [ ] Widget-\* hosts: `viewer.save_pipeline(path)` round-trip.

### 3.4 Error / edge cases

- [ ] Malformed PDB → error banner mounts (testid exists?
      `defaultViewerContract` should add one).
- [ ] Empty trajectory → Timeline does not mount.
- [ ] WASM load failure → fallback message visible.

---

## Phase 4 — out-of-scope for E2E

Recorded here so we don't lose track:

- Rust core unit tests live in `cargo test -p megane-core`.
- TS unit tests live in `vitest`.
- Python tests live in `pytest`.
- `megane server` / CLI is exercised by integration tests, not E2E.

---

## Helpers to write before Phase 2

These are "hot-path" utilities. Doing them once unblocks many tests.

- [x] `tests/e2e/lib/host-fixture.ts` — `MEGANE_HOST`-driven fixture.
      **(PR #309)** Reads `test.info().project.metadata.meganeHost`
      first, falls back to the env var; returns `{scope, host,
    context, teardown}`.
- [x] `tests/e2e/lib/pipeline.ts` — programmatic pipeline editing
      helpers (insertNode, connectEdge, setNodeParam, removeNode,
      listNodes). **(PR #309)** Drives `window.__megane_test_pipeline_store`
      exposed by the Zustand store under testMode.
- [x] `tests/e2e/lib/widget-api.ts` — wrapper around the
      `viewer.frame_index = N` / `viewer.selected_atoms = ...`
      patterns, hiding the `executePython` plumbing. **(PR #309)**
      `reopenWithCells` + builders for setFrameIndex / setSelectedAtoms /
      setPipelineCells.
- [x] `tests/e2e/lib/render-utils.ts` — shared helpers for camera
      reset, frame swap, screenshot wait. **(PR #309)** Typed
      wrappers over the `__megane_test` namespace.

---

## Source-side checklist (what needs adding to ship Phase 2)

Single-PR-sized changes that unblock multiple test categories at once.

- [x] **Mount `AppearancePanel` in the webapp shell.** (Phase 2.1)
      **(PR #309)** Mounted in `MeganeViewer.tsx`. Widget hosts still
      need the same mount inside `WidgetViewer` — open follow-up.
- [x] **Renderer hooks** behind `_testMode`:
  - [x] `getProjectedAtomPositions()` **(PR #309)**
  - [x] `getCameraState()` **(PR #309)**
  - [x] `getVisibleSubsystems()` (atoms / bonds / cell / vectors /
        labels / polyhedra) **(PR #309)**
- [x] **`__megane_test` namespaced object** exposing the above, attached
      next to `__megane_test_ready` so tests have one canonical entry
      point. **(PR #309)** Plus `__megane_test_pipeline_store` exposed
      by the Zustand store for graph editing helpers.
- [x] **`MolecularViewer.load()` extension dispatch** in
      `python/megane/widget.py:86` to enable Phase 1.4. **(PR #309)**
- [x] **`jupyterapp` global shim** in
      `tests/e2e/lib/hosts/jupyterlab.ts:openLabNotebook` for Phase 1.7.
      **(PR #309)** — replaced with notebook-rewrite + Run All
      pattern; the shim is no longer needed.

---

## How to measure progress

```sh
# total test cases
npx playwright test --list | tail -1

# committed baselines
find tests/e2e/baselines -name '*.png' \
  ! -name '*.current.png' ! -name '*.new.png' ! -name '*.diff.png' | wc -l

# per-host coverage
for d in tests/e2e/baselines/*/; do
  printf '%-25s %s\n' "$(basename $d)" \
    "$(find "$d" -maxdepth 1 -name '*.png' \
      ! -name '*.current.png' ! -name '*.new.png' ! -name '*.diff.png' | wc -l)"
done
```

When this file's checkboxes are all green, the suite covers every
user-facing megane feature on every host. Treat unchecked items as
known regressions waiting to happen.
