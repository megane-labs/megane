---
description: Pre-release checklist for megane. Run before tagging and publishing a new version. Covers tests, build, versioning, docs, and dry-run validation.
---

# Pre-Release Checklist

Run this skill before creating a release tag. Complete every phase in order.

## Phase 0: Prerequisites

The pre-release sequence is **bump first, then build, then test**. The
JupyterLab labextension embeds its own `package.json` version into the
shipped JS bundle at build time, so building before bumping ships the wheel
with a stale labextension version. The Python wheel and the E2E suites also
depend on those build artifacts, so reordering is not optional.

Confirm the dev environment is set up:
```bash
which wasm-pack maturin uv jupyter   # all four must resolve
node --version                        # 22+
```
If anything is missing, run the **dev-setup** skill first.

If this is a fresh checkout (no `node_modules/`, no `crates/megane-wasm/pkg/`):
```bash
npm install
npm run build:wasm           # required before any other build/test
uv sync --extra dev          # installs Playwright-host jupyterlab into .venv
```

`uv run` puts `.venv/bin` on PATH so subprocesses see the project `jupyter`.
When invoking Playwright directly (e.g. `npx playwright test ...` for a
re-baseline), prefix the command with `PATH="$(pwd)/.venv/bin:$PATH"` or the
`jupyterlab-doc` / `widget-jupyterlab` projects fail with `spawn jupyter
ENOENT`.

## Phase 1: Version bump

### 1.1 Run bump-my-version
Install if not already available:
```bash
uv tool install bump-my-version
```
Choose the appropriate level:
```bash
uv tool run bump-my-version bump patch   # bug fixes
uv tool run bump-my-version bump minor   # new features
uv tool run bump-my-version bump major   # breaking changes
```

### 1.2 Verify all 11 files are updated
The bumpversion config in `pyproject.toml` updates these files:
- `pyproject.toml`
- `package.json`, `package-lock.json`
- `crates/megane-core/Cargo.toml`
- `crates/megane-python/Cargo.toml`
- `crates/megane-wasm/Cargo.toml`
- `python/megane/__init__.py`
- `vscode-megane/package.json`, `vscode-megane/package-lock.json`
- `jupyterlab-megane/package.json`, `jupyterlab-megane/package-lock.json`

Sanity-check no stale references remain (replace `0.6.2` with the previous
version — output should be empty):
```bash
grep -rn "0\.6\.2" pyproject.toml package.json package-lock.json \
  crates/megane-core/Cargo.toml \
  crates/megane-python/Cargo.toml \
  crates/megane-wasm/Cargo.toml \
  python/megane/__init__.py \
  vscode-megane/package.json vscode-megane/package-lock.json \
  jupyterlab-megane/package.json jupyterlab-megane/package-lock.json
```
`docs/scripts/prepare-notebooks.py` reads the version dynamically from
`pyproject.toml`, so no manual update is required.

### 1.3 Update Cargo.lock
```bash
cargo check
```
Ensures `Cargo.lock` is in sync with the bumped Cargo.toml versions.

## Phase 2: Build

### 2.1 Full build (with the new version)
```bash
npm run build
```
Must complete without errors. This covers WASM → TypeScript → Vite app →
widget → lib → JupyterLab labextension. The labextension webpack bundle is
where the `jupyterlab-megane` version is embedded — confirm it picked up
the bump:
```bash
grep -ohE 'megane-jupyterlab@[0-9.]+' \
  wheel-share/data/share/jupyter/labextensions/megane-jupyterlab/static/*.js \
  | head -1
```
The version in the output must match the new release version.

### 2.2 Python wheel build
```bash
maturin build --release
```
Must produce a wheel without errors. The wheel includes `wheel-share/` so
the labextension shipped with the wheel reflects whatever was on disk at
this point.

### 2.3 Editable install (only needed for Phase 3 E2E)
The `jupyterlab-doc` and `widget-jupyterlab` projects spawn `jupyter lab`
and require the labextension to be discoverable in the venv prefix. After
Phase 2.1 the build artifacts are on disk; install them into the venv:
```bash
PATH="$(pwd)/.venv/bin:$PATH" uv run maturin develop --release
PATH="$(pwd)/.venv/bin:$PATH" jupyter labextension list | grep megane
```
The listed `megane-jupyterlab` must show the new version.

## Phase 3: Tests

```bash
uv run make test-all
```
All of Python, TypeScript, Rust, E2E, notebook, and integration tests must
pass.

### 3.1 Full 5-platform E2E matrix is MANDATORY for a release

`make test-all` only runs the E2E *subset* `webapp`, `contract`,
`widget-jupyterlab`, `jupyterlab-doc`. **A release is different from a normal
PR: it MUST verify the viewer renders on ALL 5 host platforms** — webapp,
JupyterLab DocWidget, VSCode custom editor, Jupyter widget in JupyterLab, and
Jupyter widget in a VSCode notebook. A version bump changes the shipped
artifacts on every host, so every host has to be exercised, not just the four
in the subset. Run the **full** Playwright matrix per the `e2e-coverage`
skill, including:

- every host project (`webapp`, `contract`, `widget-jupyterlab`,
  `widget-vscode`, `jupyterlab-doc`, `vscode`),
- the single-feature projects (`format-loading`, `playback`, `sidebar`,
  `licorice`, `water-line`, `pipeline-editor`, `pipeline-file`,
  `render-modal`, `resname-filter-opacity`, `widget-api`, `widget-examples`,
  `heterogeneous-traj`, `trajectory-bonds-vdw-leak`), and
- the Phase-2 cross-host matrix (`modify-node`, `camera`, `measurement`,
  `subsystem-rendering`, `trajectory-bonds`) across all 5 hosts.

The VSCode hosts (`vscode`, `widget-vscode`, and the `*__vscode` /
`*__widget-vscode` Phase-2 variants) require the code-server setup from the
`e2e-coverage` skill (`sudo apt-get install -y libkrb5-dev`,
`MEGANE_CODE_SERVER_USE_NPM=1 bash scripts/install-code-server.sh`,
`MEGANE_E2E_MODE=1`). Because E2E is local-only (not in CI), release is the
one checkpoint that catches drift/regressions that accumulated across merged
PRs — do **not** skip a host because it needs extra setup.

**Triage rule for each failure** (see also the drift note below):
- *Pixel diff only* (`full-page`/`viewer-region diff X% > 2%`) from intended
  merged changes → visually inspect the `.new.png`, then re-baseline.
- *Timeout / runtime error / non-deterministic (flaky) diff* → a **real
  regression**; fix the root cause. Never re-baseline a flaky or functional
  failure. The `vscode` project's ~9 format tests intentionally diff heavily
  off the baseline host — do **not** re-baseline those (the DOM-contract layer
  still validates them).

The release commit will run through CI on the way to `main`, and CI uploads
to Codecov with `fail_ci_on_error: true` (`codecov.yml` patch target 70 %).
The release diff is mostly version bumps + CHANGELOG, which Codecov ignores
(`pyproject.toml`, `Cargo.toml`, `*.md`), so the gate normally passes
trivially. If the release branch happens to also include source-code
changes, run `make coverage-all` locally first — see CRITICAL RULE #8 in
`CLAUDE.md` and the `testing` skill's "Coverage & Codecov" section.

**E2E baseline drift.** Per `CLAUDE.md`, E2E is local-only and font /
fontconfig differences across machines can cause baseline diffs. If E2E
fails only with `full-page diff X.XX% > 2%` style errors (not timeouts or
app errors), re-baseline the affected projects and commit the new PNGs:
```bash
PATH="$(pwd)/.venv/bin:$PATH" MEGANE_E2E_UPDATE=1 \
  npx playwright test --project=<failing-project> [--project=<...>]
```
Then `git add tests/e2e/baselines/<project>/` and commit as a separate
`test(e2e): re-baseline ...` commit *before* the release commit. If
failures are timeouts or runtime errors, fix the underlying cause — do not
paper over with a re-baseline.

## Phase 4: CHANGELOG

### 4.1 Pre-condition check
Confirm that `CHANGELOG.md` has an `[Unreleased]` section at the top:
```bash
head -10 CHANGELOG.md
```
If `[Unreleased]` is missing or empty, populate it from
`git log --no-merges <last-tag>..HEAD` before proceeding. An empty
`[Unreleased]` is a sign there are no user-facing changes to release —
double-check before continuing.

### 4.2 Verify CHANGELOG.md has a new entry
- The `[Unreleased]` section must be renamed to `[X.Y.Z] - YYYY-MM-DD` with today's date.
- A fresh empty `[Unreleased]` section should remain at the top.
- Format follows [Keep a Changelog](https://keepachangelog.com/).

Example:
```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD
### Added
- ...
### Fixed
- ...
```

## Phase 5: Documentation & Content

### 5.1 README code examples
Manually verify that install commands and code snippets in `README.md`
reflect the current API.
Check at minimum:
- Installation section (pip, npm, vscode)
- Quick-start Python snippet (`megane.view()` / `megane.view_traj()` are 0.6.0+)
- Quick-start React snippet (imports from `megane-viewer/lib`)
- Supported file formats table

### 5.2 Docs site builds
Docs build is verified by the `release-dry-run.yml` workflow (the "Dry run:
Docs" job). No manual step needed here — Phase 7 covers this.

### 5.3 Feature table alignment
Confirm the README feature table ("Runs Everywhere" section) matches what
is actually supported:
- Supported environments (Jupyter, browser, React, VSCode)
- Supported file formats (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, LAMMPS data, XTC, LAMMPS dump, ASE .traj)
- Cross-host parity per `docs/docs/platform-support.md`

## Phase 6: Visual Verification

### 6.1 Capture screenshots
```bash
node scripts/capture-screenshots.mjs
```
Requires WASM to be built (covered by Phase 2.1 `npm run build`).
The script opens the full app (3D viewport + pipeline editor + timeline)
and saves `docs/public/screenshots/hero.png`. Review it visually for
rendering regressions.

### 6.2 Live demo (AWS S3 + CloudFront) — health check and visual verification

The demo deploy workflow is `.github/workflows/deploy.yml` ("Deploy demo to
AWS S3 + CloudFront"). It runs on every push to `main` and on workflow
dispatch.

**Step 1**: Confirm the latest deploy succeeded and retrieve the URL:
```bash
ORIG_REMOTE=$(git remote get-url origin)
git remote set-url origin https://github.com/megane-labs/megane.git
RUN_ID=$(gh run list --workflow=deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run view "$RUN_ID" --log | grep -E "URL:|cloudfront\.net|distribution_domain"
git remote set-url origin "$ORIG_REMOTE"
```
Note the CloudFront URL.

**Step 2**: Take a screenshot of the live demo with Playwright and verify
rendering:
```bash
node -e "
const { createRequire } = require('module');
const require2 = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require2('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('LIVE_DEMO_URL', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'dev-preview/live-demo.png', fullPage: false });
  await browser.close();
  console.log('Screenshot saved to dev-preview/live-demo.png');
})();
"
```
Replace `LIVE_DEMO_URL` with the URL from Step 1.

**Step 3**: Review the screenshot `dev-preview/live-demo.png` and confirm:
- The viewer loads without blank screen or error messages
- A molecule is rendered (atoms/bonds visible)
- The UI controls (toolbar, sidebar) are present

## Phase 7: Dry Run

### 7.1 Trigger release-dry-run workflow
```bash
gh workflow run release-dry-run.yml
```
Wait for it to complete:
```bash
gh run list --workflow=release-dry-run.yml --limit 1
```
All three publish jobs (PyPI, npm, VSCode) must pass in dry-run mode.

## Phase 8: Release Commit

Only proceed here after all phases above are green.

### 8.1 Verify clean git state
```bash
git status
```
Expected modifications: bump-my-version files (`pyproject.toml`,
`package.json`, `package-lock.json`, the three `Cargo.toml`s,
`python/megane/__init__.py`, both `vscode-megane/package*.json`, both
`jupyterlab-megane/package*.json`), `Cargo.lock`, `CHANGELOG.md`.
`python/megane/static/widget.js` is **gitignored** (a generated bundle
shipped in the wheel via the `[tool.maturin]` `python/megane/static/**`
include, like `python/megane/static/app/`), so it must **not** appear in
`git status` and is **not** part of the release commit. Any unrelated
modifications should already have been split into separate commits (e.g.
E2E baselines from Phase 3).

### 8.2 Create release commit
```bash
git add pyproject.toml package.json package-lock.json \
  crates/megane-core/Cargo.toml \
  crates/megane-python/Cargo.toml \
  crates/megane-wasm/Cargo.toml \
  Cargo.lock \
  python/megane/__init__.py \
  vscode-megane/package.json vscode-megane/package-lock.json \
  jupyterlab-megane/package.json jupyterlab-megane/package-lock.json \
  CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
```

Then push. The push target depends on workflow:
- **Direct main flow**: `git push origin main`
- **Branch + PR flow** (default in Claude Code on web): push to the working
  branch (e.g. `claude/release-vX.Y.Z-...`), open a PR, merge after CI
  passes. The tag must point at the merge commit on `main`.

### 8.3 Hand off to user
After the release commit is on `main`, hand off to the user to create and
push the tag manually:

```
# Run these commands yourself to trigger the publish workflows:
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag triggers all publish workflows automatically:
`publish-pypi.yml`, `publish-npm.yml`, `publish-vscode.yml`, `release.yml`,
`docs.yml`.

## Next Step

After the user pushes the tag, follow the **post-release** skill to verify
the release landed correctly.
