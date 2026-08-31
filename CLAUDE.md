# megane - Claude Code Instructions

## CRITICAL RULES

1. **Commit messages MUST be in English.** Never use Japanese or any other language in commit messages.
2. **NEVER use Puppeteer.** The repo uses **Playwright**:
   - The current `*.spec.ts` E2E suite uses `@playwright/test` via the local `playwright` 1.56 devDependency (installed by `npm ci`).
   - Legacy `*.mjs` scripts (`scripts/dev-preview.mjs`, `scripts/capture-screenshots.mjs`, `tests/e2e/test_vscode_render.mjs`, `tests/e2e/vscode_full_screen.test.mjs`, etc.) resolve Playwright from the global install via `createRequire("/opt/node22/lib/node_modules/")`. The shared helper is `tests/e2e/utils/playwright.mjs` — reuse it instead of duplicating the `createRequire` block.
   - `puppeteer` is **not** a dependency. Do not add it.
3. **Always build WASM before running the dev server or full build.** The WASM pkg directory (`crates/megane-wasm/pkg/`) does not exist until `npm run build:wasm` is run. In sandboxes the `wasm-opt` download is blocked, but `npm run build:wasm` now self-heals via `scripts/build-wasm.mjs` (auto-retries `wasm-pack --no-opt` so `pkg/package.json` is always written) — do **not** hand-edit `Cargo.toml` to toggle `wasm-opt` anymore. Force the fast path with `MEGANE_WASM_NO_OPT=1`. See the `build` skill.
4. **Always create a PR after pushing changes.** Use `gh pr create` to open a pull request. PR titles and descriptions must be in English. See the `github-cli` skill for remote URL workaround. Before reporting completion, verify CI passes with `gh run list`.
5. **In plan mode, strictly follow the approved plan.** Do not skip steps, reorder them, or add unplanned work. If the plan needs changes, explain the reason and get approval before deviating.
6. **All file formats should behave consistently across hosts.** When you add a parser or feature to one platform (standalone webapp, Jupyter widget, JupyterLab labextension, VSCode extension), register it on every host unless there is a host-specific reason not to. The single source of truth is `docs/docs/platform-support.md`; update its tables in the same PR. Host registration points: `crates/megane-wasm/src/lib.rs` (browser parsers), `src/components/nodes/LoadStructureNode.tsx` / `LoadTrajectoryNode.tsx` (standalone accept lists), `jupyterlab-megane/src/filetypes.ts`, `vscode-megane/package.json` `customEditors`. Walk the full checklist in the `add-format` skill — drift between hosts is the #1 source of "format X works in the webapp but not in VSCode/JupyterLab" bugs.
7. **The Jupyter widget (anywidget `MolecularViewer`) does not mount the visual pipeline editor.** Pipeline data still flows in via `MolecularViewer.set_pipeline()` (`_pipeline_json` + `_node_snapshots_data`), but the in-cell `PipelineEditor` UI is intentionally not rendered — the host cell chrome cannot reliably lay it out. Do not re-introduce a `pipeline=True` opt-in or a `_pipeline_enabled` traitlet. Visual editing lives in the standalone webapp, JupyterLab labextension, and VSCode extension only.
8. **Codecov is a hard merge gate — write tests for every new line you add.** The `test-rust`, `test-ts`, and `test-python` jobs in `.github/workflows/ci.yml` upload coverage to Codecov with `fail_ci_on_error: true`, and `codecov.yml` requires **patch coverage ≥ 70 %** on every PR (project coverage is off, only the diff is gated). New parsers, pipeline nodes, React components, Python API, and Rust modules MUST ship with unit tests in the same PR — relying on E2E does not count because E2E coverage is unmeasured by Codecov. Reproduce the gate locally before pushing: `npm test -- --coverage` (TS → `coverage/ts/lcov.info`), `cargo llvm-cov --package megane-core --lcov --output-path lcov.info` (Rust), `python -m pytest --cov-report=xml:coverage.xml` (Python). The `make coverage-all` target (or `make coverage-ts` / `coverage` / `coverage-rust`) wraps these. If you genuinely cannot cover a line (e.g. unreachable defensive branch) document why in the PR description rather than disabling the check. See the `testing` skill for details.
9. **UI-affecting changes require E2E verification before PR creation.** Any edit under `src/`, `vscode-megane/src/`, `vscode-megane/media/`, `jupyterlab-megane/src/`, `crates/megane-wasm/src/`, the Vite configs (`vite.config.ts`, `vite.widget.config.ts`, `vite.lib.config.ts`, `vscode-megane/vite.webview.config.ts`), or `crates/megane-core/src/` paths whose output the renderer consumes counts as UI-affecting. Before opening the PR you MUST: (a) run every Playwright host project that exercises the changed host(s) (`webapp`, `widget-jupyterlab`, `widget-vscode`, `jupyterlab-doc`, `vscode`) plus the per-feature projects in the neighborhood (`format-loading`, `playback`, `sidebar`, `pipeline-editor`, `pipeline-file`, `render-modal`, `widget-api`, `camera`, `measurement`, `subsystems`, `trajectory-bonds`, `modify-node`, `phase2`); the `e2e-coverage` skill has the full table. (b) Confirm the **intended** UI change is reflected — extend specs or re-baseline only when the diff is genuinely intended, and visually inspect any new baseline PNG before committing it. (c) Sweep the rest of the matrix for **side effects** and treat unexpected pixel diffs, timeouts, or runtime errors as regressions to fix at the root, not baselines to update. (d) Commit any intentional baseline updates under `tests/e2e/baselines/<project>/` in the same PR, and if the intended change shifts pixels on a webapp or JupyterLab host, add the `update-e2e-baselines` label to the PR (or dispatch the "E2E update baselines" workflow on the branch) so `tests/e2e/baselines-ci/` is re-recorded (the E2E CI check fails on stale or missing CI baselines). (e) Note in the PR description which Playwright projects you ran and which baselines moved. Codecov (rule #8) covers unit coverage only; the E2E CI workflow covers webapp/JupyterLab pixel regressions, but the VSCode hosts and the local baseline set are still verified only by your local runs. See the `e2e-coverage`, `testing`, and `commit` skills. **This remote/sandbox environment CAN run E2E — do not skip rule #9 on the assumption that it can't; follow the `e2e-coverage` skill.** The webapp-hosted projects (`webapp`, `contract`, `format-loading`, `playback`, `sidebar`, `pipeline-editor`, `pipeline-file`, `render-modal`, and each feature matrix's `:webapp` variant) run here directly: `npm run build:wasm && npm run build:app`, then `PATH="$(pwd)/.venv/bin:$PATH" npx playwright test --project=<name>` (Chromium is preinstalled at `/opt/pw-browsers`; the config launches it headless with `--use-gl=swiftshader`). The JupyterLab hosts (`jupyterlab-doc`, `widget-jupyterlab`, `widget-api`) additionally need `uv sync --extra dev` + `npm run build:lab` and the labextension copy; the VSCode hosts (`vscode`, `widget-vscode`) need the npm-built code-server (`MEGANE_CODE_SERVER_USE_NPM=1 bash scripts/install-code-server.sh`, `libkrb5-dev`, `rg` on PATH) plus `MEGANE_E2E_MODE=1`. All setup, per-host quirks, and the sandbox pixel-drift notes are in the `e2e-coverage` skill. **Releases go further than a normal PR: a version bump MUST verify the viewer renders on ALL 5 host platforms by running the _full_ Playwright matrix (every host project + every feature project + the Phase-2 5×5 cross-host matrix), not just the `make test-all` subset — because the bump changes the shipped artifacts on every host and CI's E2E workflow covers only the webapp/JupyterLab hosts. See the `pre-release` skill Phase 3 and the `e2e-coverage` skill.**
10. **Every performance optimization MUST be measured before/after, and kept only if the numbers prove it helps.** A change justified as "faster" is not done until you have run an A/B measurement and shown the win in real numbers — never ship a perf change on reasoning alone. Reuse the perf harness: `scripts/profile-streaming.mjs` (eager-vs-lazy structure loading, flips `window.__MEGANE_LAZY_XTC__`), `scripts/profile-loading.mjs`, `tests/e2e/utils/playwright.mjs` (`setupPerfHooks`/`collectPerf`), and the `megane:*` perf marks under the `window.__MEGANE_PERF__` gate (`src/perf.ts`). If the measurement shows no improvement — or a regression — do NOT merge the change: revert it or redesign until the numbers are favorable, and report the before/after table. (A real example: the first multi-frame XYZ/PDB streaming implementation measured 1.3–1.5× _slower_ than eager because it read the file twice; it had to be reworked before it was worth keeping.) When the local WASM is unoptimized (`wasm-opt = false` in sandboxes), note that absolute numbers are inflated but the relative A/B on the same `.wasm` is still valid. See the `testing` skill.
11. **Parsers read files as-is — anything that changes what the user sees is a pipeline node's job.** A parser (`crates/megane-core/src/`, the TS-side parsers in `src/parsers/` and `src/pipeline/executors/parse*.ts`, `python/megane/parsers/`) must return exactly what the file asserts: nothing added, dropped, reordered, shifted, or restyled. Symmetry expansion, molecule (un)wrapping, coordinate shifts, atom/bond filtering, supercell replication, PBC ghost atoms, bond-order rewrites, secondary-structure invention, coloring, and representation choices are node work (`add_bond`, `modify`, `filter`, `replicate`, `color`, `representation`, …) so the user can see, edit, and disable them in the pipeline editor. The **only** transformations allowed inside a parser are lossless canonicalizations: (a) unit / coordinate-system conversion to the canonical Å–Cartesian representation, but only when the source unit is read from the file (`magres`, `molden`, `gamess` style) or fixed by the format spec (GRO/XTC nm) — and it must be applied uniformly to *every* length-valued channel, velocities and cells included; (b) element resolution from the most authoritative field the file carries, in precedence order explicit atomic number > mass > type symbol > atom-name guess (`amber.rs` is the model; a bare type-id-as-Z proxy like LAMMPS dump is a documented last resort); (c) distance-based bond inference **only when the format carries no connectivity at all** for those atoms — never layered on top of file-declared bonds — with `n_file_bonds` kept accurate so downstream code can tell file bonds from inferred ones; (d) identity-preserving reindexing required for trajectory frame alignment (the LAMMPS dump id sort). Two corollaries: host components must never reimplement a node executor's transform (viewer code calls the executor, it doesn't fork it), and information the file carries but megane doesn't render yet should still be parsed into `ParsedStructure` channels rather than silently discarded when another host/tool would use it. The 2026-08 parser-purity audit fixed every catalogued violation (PR #667) and its document was retired — do not introduce new ones. The only tolerated fallback is the LAMMPS dump type-id-as-Z proxy under carve-out (b); use `ParsedStructure::scalar_channels` for per-atom data megane doesn't render yet and `ParsedStructure::warnings` for anything a parser must skip, so nothing is dropped silently. Remaining host-consistency follow-ups (rule #6 territory) are tracked in issue #668.

## Dev Environment Setup

Required tools (install if missing):

- `wasm-pack`: `cargo install wasm-pack`
- `maturin`: `pip install maturin` or `uv pip install maturin`
- Node.js 22+, Rust/Cargo, Python 3.10+, uv

Setup sequence:

```
npm install
cargo install wasm-pack     # if `which wasm-pack` fails
npm run build:wasm           # MUST run before dev server
uv sync --extra dev          # Python dependencies
```

## Project Overview

megane is a molecular viewer: Rust core (parsers) + TypeScript/React frontend (Three.js) + Python backend (FastAPI/anywidget) + VSCode extension.
Rust compiles to both PyO3 (Python) and WASM (browser) via a Cargo workspace with three crates:

- `megane-core` — Core parsers (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, LAMMPS data, LAMMPS dump, AMBER topology (.prmtop), GROMACS topology (.top), PSF topology (.psf), XTC, DCD, AMBER NetCDF (.nc), ASE `.traj`)
- `megane-wasm` — WASM bindings (wasm-bindgen)
- `megane-python` — PyO3 Python extension

## Key Commands

### Build

| Command                     | What it does                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `npm run build:wasm`        | Compile Rust to WASM (MUST run first)                                                |
| `npm run build`             | Full build: WASM + tsc + Vite app + Vite widget + Vite lib + JupyterLab labextension |
| `npm run build:app`         | WASM + tsc + Vite app only                                                           |
| `npm run build:widget`      | Vite widget bundle only                                                              |
| `npm run build:lib`         | WASM + widget bundle + npm library bundle (`vite.lib.config.ts`)                     |
| `npm run build:lab`         | Build only the JupyterLab labextension (`jupyterlab-megane/`)                        |
| `npm run dev`               | Vite dev server (requires WASM already built)                                        |
| `maturin develop --release` | Build+install Python extension (editable)                                            |

### Test

| Command                                                               | What it does                                                                      |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm test`                                                            | TypeScript unit tests (vitest)                                                    |
| `npm test -- --coverage`                                              | vitest with V8 coverage → `coverage/ts/lcov.info` (matches Codecov upload)        |
| `cargo test -p megane-core`                                           | Rust parser tests                                                                 |
| `cargo llvm-cov --package megane-core --lcov --output-path lcov.info` | Rust coverage in the exact form CI uploads                                        |
| `python -m pytest`                                                    | Python tests (needs maturin develop first); pytest config already enables `--cov` |
| `python -m pytest --cov-report=xml:coverage.xml`                      | Python coverage in the exact form CI uploads                                      |
| `make coverage-all`                                                   | Run all three coverage targets locally before pushing                             |
| `npm run test:all`                                                    | vitest + full Playwright suite                                                    |
| `make test-all`                                                       | Python + TypeScript + Rust + active Playwright projects + notebooks + integration |

#### E2E (Playwright)

E2E runs in two places with two separate baseline sets:

- **CI** (`.github/workflows/e2e.yml`) runs the webapp-host and JupyterLab-host projects inside the pinned Playwright container (`mcr.microsoft.com/playwright:v<playwright-version>-noble` — the tag must match the `playwright` devDependency; bump them together) against `tests/e2e/baselines-ci/`. Those baselines are re-recorded **in CI itself** by the "E2E update baselines" `workflow_dispatch` workflow (add the `update-e2e-baselines` label to the PR, or Actions → E2E update baselines → pick the branch), which commits the PNGs back to the branch — never capture `baselines-ci` PNGs outside that container. A missing CI baseline fails the check (`MEGANE_E2E_REQUIRE_BASELINE=1`), so a PR that adds pixel specs must also dispatch the update workflow. The VSCode-hosted projects (`vscode`, `widget-vscode`) are **not** in CI.
- **Locally** (including this sandbox), the full matrix runs against `tests/e2e/baselines/<project>/` exactly as before — re-baseline locally and commit PNGs there. `MEGANE_E2E_BASELINE_DIR` switches the baseline root; leave it unset for local work.

Full runbook including environment setup, per-host quirks, and matrix expansion lives in `.claude/skills/e2e-coverage/SKILL.md`.

| Category                  | Scripts                                                                                                                                         | Notes                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full sweep                | `npm run test:e2e`                                                                                                                              | All Playwright projects                                                                                                                                                          |
| Host projects             | `:webapp`, `:contract`, `:widget-jupyterlab`, `:widget-vscode`, `:jupyterlab-doc`, `:vscode`                                                    | `:webapp` / `:contract` run a Vite static server on port 15173; `:widget-vscode` / `:vscode` need `MEGANE_E2E_MODE=1` + code-server (see below)                                  |
| Feature × 5-host matrices | `:modify-node`, `:camera`, `:measurement`, `:subsystems`, `:trajectory-bonds`                                                                   | Each runs the feature on `webapp`, `jupyterlab-doc`, `vscode`, `widget-jupyterlab`, `widget-vscode`. Per-host variants exist (e.g. `:trajectory-bonds:webapp`, `:camera:webapp`) |
| Single-feature projects   | `:format-loading`, `:playback`, `:sidebar`, `:licorice`, `:illustrative`, `:widget-api`, `:widget-examples`, `:pipeline-editor`, `:pipeline-file`, `:render-modal`, `:atom-bond-junction`, `:isosurface-opacity`, `:phase2` | Webapp host unless the project name encodes another                                                                                                                              |
| Legacy mjs runner         | `:vscode:legacy`, `:vscode:legacy:update`                                                                                                       | `tests/e2e/vscode_full_screen.test.mjs`                                                                                                                                          |
| Re-baseline flag          | `MEGANE_E2E_UPDATE=1 npm run test:e2e:<project>`                                                                                                | Unlinks the existing baseline before capture                                                                                                                                     |

This table lists the npm-scripted projects; the **authoritative project list is `playwright.config.ts`**. Some webapp-hosted regression projects (`heterogeneous-traj`, `trajectory-bonds-vdw-leak`, `water-line`, `inspector`, `resname-filter-opacity`, `multi-instance`) have no npm script and run via `npx playwright test --project=<name>`; the feature × host matrix projects use `<feature>__<host>` internal names (e.g. `trajectory-bonds__webapp`).

When invoking Playwright directly (`npx playwright test ...`), prefix with `PATH="$(pwd)/.venv/bin:$PATH"` so the `jupyterlab-doc` / `widget-jupyterlab` projects can spawn the venv `jupyter`. `uv run make test-all` already does this implicitly. Re-baseline only when the failure is a pixel diff; treat timeouts and runtime errors as real regressions and fix the root cause instead.

The `:vscode` / `:widget-vscode` projects need code-server. In a sandboxed/proxied env the default `code-server.dev` binary download is blocked (HTTP 403); build from npm instead with `sudo apt-get install -y libkrb5-dev && MEGANE_CODE_SERVER_USE_NPM=1 bash scripts/install-code-server.sh`, then point the run at `MEGANE_CODE_SERVER_BIN="$(pwd)/.code-server/node_modules/.bin/code-server"`. The `e2e-coverage` skill has the full runbook.

### Lint / Format / Preview

| Command                                     | What it does             |
| ------------------------------------------- | ------------------------ |
| `npm run lint` / `lint:fix`                 | ESLint over `src/`       |
| `npm run format` / `format:check`           | Prettier over `src/`     |
| `node scripts/dev-preview.mjs --screenshot` | Dev preview screenshots  |
| `node scripts/capture-screenshots.mjs`      | Hero screenshot for docs |

## LLM Prompt-Eval CI (bench/llm)

`bench/llm/` is a prompt-suite + scorer that grades megane's LLM pipeline
generator (`src/ai/prompt.ts` + skills) on a fixed dataset of requests. Adding
the **`llm-eval`** label to a PR runs `.github/workflows/llm-prompt-eval.yml`,
which scores the PR branch and its base branch via Preferred Networks' PLaMo
API or OpenRouter — the provider comes from the `MEGANE_LLM_BENCH_PROVIDER`
repository variable (`plamo`, the default, or `openrouter`), reading the
matching `PLAMO_API_KEY` / `OPENROUTER_API_KEY` repository secret; the model
defaults per provider (`plamo-3.0-prime` / `anthropic/claude-haiku-4.5`) and is
overridable via the `MEGANE_LLM_BENCH_MODEL` repository variable — and posts a
before/after score comparison as a PR comment. It is opt-in (real, paid API calls) and only runs for PRs from
branches within this repository (forks don't get secrets). The job also only
runs for actors listed in the `LLM_EVAL_ALLOWED_USERS` repository variable (a
JSON array of usernames, defaults to `["hodakamori"]`), so applying the label
as another user is a no-op. See `bench/llm/README.md` for the full rubric and
local usage.

## Skills

Project-specific skills are defined in `.claude/skills/`. Each skill provides instructions for a specific workflow. Always follow the skill's instructions when performing the corresponding task.

A SessionStart hook (`.claude/hooks/session-start.sh`) injects a reminder pointing here at the start of every session and asks the agent to verify the skills below appear in the system reminder's `available skills` list.

| Skill          | What it covers                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `commit`       | Git commit guidelines (English-only messages, conventional style, post-commit CI verification) |
| `github-cli`   | `gh` CLI usage, including the remote-URL workaround for sandboxed envs                         |
| `dev-setup`    | Verifying / installing the dev toolchain (wasm-pack, maturin, uv, Node 22+)                    |
| `build`        | Build commands and required ordering (WASM first)                                              |
| `testing`      | Test taxonomy across TypeScript, Rust, Python, and E2E                                         |
| `e2e-coverage` | Full Playwright matrix runbook across the 5 host platforms                                     |
| `preview`      | Screenshot/video capture for visual review                                                     |
| `pre-release`  | Pre-release checklist (tests, version bump, **full 5-platform E2E matrix**, dry-run, tag)      |
| `post-release` | Post-release verification (publish workflows, package availability, docs)                      |
| `add-format`   | Per-host registration checklist for new file formats (enforces CRITICAL RULE #6)               |
| `add-node`     | Registration checklist for new visual-pipeline node types (types, catalog, executor, UI, builders) |

Total: 11 skills.

## Architecture

- TypeScript source: `src/` (import alias `@/` → `src/`)
- Python source: `python/megane/`
- Rust crates: `crates/{megane-core,megane-python,megane-wasm}/`
- VSCode extension workspace: `vscode-megane/` (extension code + `vite.webview.config.ts` for the webview bundle)
- JupyterLab labextension source: `jupyterlab-megane/` (built with `@jupyterlab/builder` / webpack, imports the shared `src/` viewer via webpack alias `@megane/*`)
- Vite configs at repo root:
  - `vite.config.ts` — webapp
  - `vite.widget.config.ts` — anywidget bundle
  - `vite.lib.config.ts` — npm library (`megane-viewer`) bundle
  - `vite.docs-demo.config.ts` — docs demo build
  - VSCode webview config lives at `vscode-megane/vite.webview.config.ts` (not at repo root)
- Playwright config at repo root: `playwright.config.ts` (declares all E2E projects)
- App builds to: `python/megane/static/app/`
- Widget builds to: `dist/`
- JupyterLab labextension builds to: `wheel-share/data/share/jupyter/labextensions/megane-jupyterlab/` and is shipped in the wheel via `[tool.maturin] data = "wheel-share"`
- Test fixtures: `tests/fixtures/` (PDB, XYZ, XTC files)
- E2E baselines: `tests/e2e/baselines/<project>/` (committed PNGs for the `*.spec.ts` 3-layer suite)
- Legacy `*.test.mjs` snapshots: `tests/e2e/snapshots/` (kept while the legacy runners survive)
