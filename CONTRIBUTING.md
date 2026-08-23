# Contributing to megane

Thank you for your interest in contributing to megane. This document covers the development setup, testing, and submission process.

## Development Setup

Prerequisites: Node.js 22+, Rust (stable), Python 3.10+, [uv](https://github.com/astral-sh/uv).

```bash
# Install dependencies
npm install
cargo install wasm-pack       # if not already installed
npm run build:wasm             # MUST run before the dev server
uv sync --extra dev            # Python dependencies

# Build the Python extension (editable)
maturin develop --release
```

After setup, you can start the dev server with `npm run dev`.

## Running the VSCode and JupyterLab Extensions Locally

After completing the Development Setup above, you can build and use either extension interactively on your machine.

### VSCode extension (via VSIX)

```bash
cd vscode-megane
npm install
npm run build       # builds webview bundle + extension
npm run package     # produces vscode-megane-<version>.vsix
code --install-extension ./vscode-megane-<version>.vsix
```

Open any supported molecular file (`.pdb`, `.gro`, `.xyz`, `.mol`, `.sdf`, `.mol2`, `.cif`, `.mmcif`, `.data`, `.lammps`, `.prmtop`, `.traj`, `.xtc`, `.dcd`, `.nc`, `.lammpstrj`, `.dump`) or a `.megane.json` pipeline file in VSCode to launch the megane viewer.

To iterate on the extension code without repackaging, open `vscode-megane/` in VSCode and press `F5` to launch the Extension Development Host (after `npm run build`).

### JupyterLab extension

```bash
npm run build:lab          # builds labextension into wheel-share/...
maturin develop --release  # installs python pkg + ships labextension into the env
jupyter labextension list  # confirm "megane-jupyterlab" is enabled
jupyter lab
```

Double-click any supported structure file in the JupyterLab file browser, or use the anywidget API in a notebook:

```python
import megane
megane.view("path/to/protein.pdb")
```

If `jupyter labextension list` does not show megane after `maturin develop`, copy the labextension manually:

```bash
mkdir -p "$(jupyter --data-dir)/labextensions"
cp -r wheel-share/data/share/jupyter/labextensions/megane-jupyterlab \
      "$(jupyter --data-dir)/labextensions/"
```

## Running Tests

| Command | Scope |
|---|---|
| `npm test` | TypeScript unit tests (vitest) |
| `cargo test -p megane-core` | Rust parser tests |
| `python -m pytest` | Python tests (requires `maturin develop` first) |
| `make test-all` | All of the above combined |

Please run `make test-all` before submitting a pull request.

### E2E tests and pixel baselines

UI-affecting changes are covered by a Playwright E2E suite with pixel-diff baselines. It runs in two places:

- **CI** runs the webapp-host and JupyterLab-host projects inside a pinned Playwright container (`.github/workflows/e2e.yml`), comparing against `tests/e2e/baselines-ci/`. If your change intentionally alters rendered pixels, re-record those baselines by adding the **`update-e2e-baselines`** label to your PR (or dispatching the **"E2E update baselines"** workflow on your branch from the Actions tab) — it re-captures them in the same container and commits the PNGs. Do not capture `baselines-ci` PNGs on your own machine; they only match when recorded inside the container. For fork PRs, a maintainer will run the workflow for you.
- **Locally** you can run the full matrix, including the VSCode-hosted projects that CI does not cover (`npm run test:e2e`, or per-project scripts like `npm run test:e2e:webapp`). Local runs use the separate `tests/e2e/baselines/` set; re-baseline with `MEGANE_E2E_UPDATE=1` when a pixel change is intended.

Codecov measures unit-test coverage only (patch coverage ≥ 70 % is required on every PR); E2E does not count toward it, so new code still needs unit tests.

### CI on fork pull requests

Everything you need runs automatically on PRs from forks — no secrets or special setup required on your side:

- The full CI suite (lint, Rust/TS/Python tests, builds) and the E2E pixel checks run on fork PRs; the E2E jobs compare against the `tests/e2e/baselines-ci/` PNGs committed in the repository.
- Coverage uploads work without a token: this is a public repository, so codecov-action falls back to a tokenless upload for fork PRs. If the upload step itself fails transiently (e.g. a rate limit), ask a maintainer to re-run the job — do not try to work around the coverage gate.
- The **"E2E update baselines"** flow (the `update-e2e-baselines` label) cannot push to fork branches, so if your change intentionally shifts pixels, say so in the PR description and a maintainer will re-record `baselines-ci/` for you.
- The `llm-eval` label is maintainer-only (it triggers paid API calls) and is a no-op for other users.

## Code Style

- **TypeScript** -- Strict mode enabled. Use the `@/` import alias for paths under `src/`.
- **Rust** -- Stable toolchain. Run `cargo fmt` and `cargo clippy` before committing.
- **Python** -- Target Python 3.10+. Follow PEP 8 conventions.

Commit messages must be written in English.

## Design Rules

A few project-wide rules come up in almost every review — knowing them up
front saves a round trip:

- **Parsers read files as-is.** A parser must return exactly what the file
  asserts — nothing added, dropped, reordered, or restyled. Anything that
  changes what the user *sees* (symmetry expansion, unwrapping, filtering,
  supercells, bond rewrites, coloring, …) belongs in a pipeline node, so the
  user can see and disable it in the editor. The only transformations allowed
  inside a parser are lossless canonicalizations (unit conversion declared by
  the file/format, element resolution, bond inference *only* when the format
  carries no connectivity, identity-preserving reindexing). Per-atom data
  megane doesn't render yet belongs in `ParsedStructure::scalar_channels`,
  and anything a parser must skip surfaces through
  `ParsedStructure::warnings` — please do not introduce new violations.
- **New file formats and pipeline nodes must work on every host.** megane
  ships as a webapp, Jupyter widget, JupyterLab extension, VSCode extension,
  and Python API. When you add a format or node, register it on all of them
  (the walkthroughs in
  [`docs/docs/dev/architecture.md`](docs/docs/dev/architecture.md) and
  [`docs/docs/dev/custom-nodes.md`](docs/docs/dev/custom-nodes.md) list every
  registration point) and update the tables in
  [`docs/docs/platform-support.md`](docs/docs/platform-support.md) in the same
  PR. Host drift is the #1 source of "works in the webapp but not in VSCode"
  bugs.
- **Performance changes must be measured.** A change justified as "faster"
  needs a before/after A/B measurement (see `scripts/profile-loading.mjs` and
  `scripts/profile-streaming.mjs`), and is only merged if the numbers show a
  win. Include the before/after table in the PR description.

## Submitting a Pull Request

1. Fork the repository and create a feature branch from `main`.
2. Make your changes, keeping commits focused and well-described.
3. Run `make test-all` and confirm all tests pass.
4. Open a pull request against `main` and fill out the PR template.
5. A maintainer will review your PR. Please address any feedback promptly.

## Reporting Issues

Use the GitHub issue templates for bug reports and feature requests. Include as much detail as possible, especially the file format you were viewing and steps to reproduce the problem.

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
