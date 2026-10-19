# Megane E2E test suite

This suite uses **Playwright Test** (`playwright test`) and asserts against
the cross-platform **3-layer contract** described in
`/root/.claude/plans/jupyter-extension-jupyter-widget-merry-gizmo.md`.

## Layers

Every interaction step in every spec asserts:

1. **DOM contract** (`assertDomContract`) — required `data-testid` set,
   visibility, attribute values (e.g. `data-megane-context="webapp"`).
2. **Full-page pixel-diff** (`expectFullPageMatch`) — entire window
   capture, including host UI (sidebars, tabs, status bars). Catches
   "widget didn't appear in output cell" and "error banner is showing".
3. **Viewer-region pixel-diff** (`expectViewerRegionMatch`) — clipped to
   `data-testid="viewer-root"`. Used by `contract.spec.ts` for
   cross-platform Parity (the same fixed input must produce the same
   viewer pixels regardless of host).

The earlier "canvas exists + non-white pixel ratio > 0.1%" smoke check is
**not present** in this suite — it was the principal cause of regressions
slipping through historically.

## Determinism

The renderer (`src/renderer/MoleculeRenderer.ts`) detects `?test=1` (or
`globalThis.__MEGANE_TEST__ === true`) at module load and exposes
`window.__megane_test_ready = { firstFrame, dataLoaded, frame, renderEpoch, atomCount }`.

Specs wait on this signal via `waitForReady(scope, { needsData, untilEpoch })`.
For interaction tests, snapshot `renderEpoch` before the action and pass
`untilEpoch: before.renderEpoch + 1` afterwards — this guarantees the
renderer has produced at least one frame reflecting the new state.

If a UI seems to render but `__megane_test_ready` never advances, the
React/wasm path that loads the snapshot is broken — exactly the kind of
regression earlier smoke tests missed.

## Local commands

```sh
# build prerequisites (run once)
npm run build:wasm
npm run build:widget       # for widget-* projects
npm run build:lab          # for jupyterlab-* projects

# install python widget
pip install -e ".[dev]" jupyterlab

# run a project
npm run test:e2e:webapp
npm run test:e2e:contract
npm run test:e2e:widget-jupyterlab
npm run test:e2e:jupyterlab-doc

# update baselines (when the change is intentional)
npx playwright test --project=webapp --update-snapshots
# Or: delete the .png in tests/e2e/baselines/<platform>/ and re-run.
```

## Baseline updates

Baselines live under `tests/e2e/baselines/<project>/`. On first run a
baseline is created automatically. On subsequent runs, a failed
comparison writes:

- `<name>.diff.png` — pixelmatch overlay
- `<name>.new.png` — the new screenshot

Inspect both before deciding whether to overwrite the baseline. Diff
percentage thresholds are intentionally tight: do **not** loosen them to
hide flakiness. If the diff is caused by host UI noise (clock, hover
state, kernel-banner timestamps), add a `mask` region in `stabilizeUi()`
or in the spec call — never widen the tolerance.

## Adding new tests

1. Add `data-testid="..."` to the new control in the React component. Use
   the same id across all four entry points (MeganeViewer / WidgetViewer
   / DocBody / vscode webview main).
2. Add an item to `defaultViewerContract()` in `lib/setup.ts` if the
   testid is required on every host.
3. Write a `test()` that:
   - opens the host
   - exercises the interaction (click, drag, programmatic state change)
   - calls `waitForReady(scope, { untilEpoch: before.renderEpoch + 1 })`
   - calls `assertDomContract` + `expectFullPageMatch` + `expectViewerRegionMatch`

## Project status

| Project           | State    | Where it runs  | Notes                                               |
| ----------------- | -------- | -------------- | --------------------------------------------------- |
| webapp            | active   | **local-only** | Vite preview / Node static server                   |
| contract          | active   | **local-only** | WebApp viewer-region baseline used by all platforms |
| widget-jupyterlab | active   | **local-only** | anywidget + JupyterLab                              |
| jupyterlab-doc    | active   | **local-only** | DocWidget direct-open path                          |
| widget-vscode     | scaffold | n/a (skipped)  | needs code-server + ms-toolsai.jupyter              |
| vscode            | scaffold | n/a (skipped)  | needs local VSIX + code-server                      |

**All four E2E projects are local-only.** Two CI-environment-specific
issues made GH-hosted runs unreliable:

- `webapp` / `contract`: Playwright's `webServer` manager hits a
  non-deterministic port-bind race against our Node static server
  (failure within ~5 seconds, before any spec runs).
- `widget-jupyterlab` / `jupyterlab-doc`: pixel-diff baseline drift
  between the dev-container Chromium and the CI Chromium fonts /
  fontconfig (small but enough to exceed our 2 % tolerance).

Run all four projects locally before pushing changes to MeganeViewer,
Viewport, MoleculeRenderer, the widget bundle, or DocWidget. See
`.agents/skills/testing/SKILL.md` for commands.

Follow-up milestones (more interaction matrices, more dynamic-update
matrices, more host options) are tracked in the planning doc.

## Migrating from snapshot.test.mjs

The legacy `tests/e2e/snapshot.test.mjs` is retained for one release as
`npm run test:e2e:legacy`. It will be removed once the new webapp suite
has parity coverage for all original 8 scenarios.
