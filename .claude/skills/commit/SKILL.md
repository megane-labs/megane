---
description: Guidelines for making git commits in the megane project. Use when creating commits.
---

# Commit Guidelines

## RULE: All commit messages and PR descriptions MUST be in English

This is a hard requirement. Never write commit messages, PR titles, or PR descriptions in Japanese or any other non-English language.

## Commit Message Style

Use conventional commits:
- `feat:` for new features (e.g., `feat: add CIF file format support`)
- `fix:` for bug fixes (e.g., `fix: resolve infinite re-render loop in sidebar`)
- `chore:` for maintenance (e.g., `chore: update dependencies`)
- `docs:` for documentation
- `refactor:` for code restructuring
- `test:` for test additions/changes
- `perf:` for performance improvements

Keep the first line under 72 characters. Add details in the body if needed.

## Before Committing

1. Run relevant tests for the changed code, **with coverage** so you can confirm the Codecov patch gate (≥ 70 % per `codecov.yml`) before pushing — see CRITICAL RULE #8 in `CLAUDE.md` and the `testing` skill's "Coverage & Codecov" section. CI uploads with `fail_ci_on_error: true`, so an uncovered diff blocks merge.
   - Rust changes: `cargo llvm-cov --package megane-core --lcov --output-path lcov.info` (or `cargo test -p megane-core` if the diff is test-only)
   - TypeScript changes: `npm test -- --coverage`
   - Python changes: `python -m pytest` (coverage is auto-enabled via `pyproject.toml` addopts; use `--cov-report=xml:coverage.xml` to mirror CI)
   If you added new source code, you MUST also add unit tests for it in the same commit. Relying on E2E does not satisfy Codecov — E2E is local-only and unmeasured.
2. Ensure the build succeeds for frontend changes: `npm run build`
3. **If the change touches the UI, run the relevant E2E projects locally before opening the PR (CRITICAL RULE #9 in `CLAUDE.md`).** "UI-affecting" includes any edit under `src/`, `vscode-megane/src/`, `vscode-megane/media/`, `jupyterlab-megane/src/`, `crates/megane-wasm/src/`, the Vite configs (`vite.config.ts`, `vite.widget.config.ts`, `vite.lib.config.ts`, `vscode-megane/vite.webview.config.ts`), or `crates/megane-core/src/` paths whose output the renderer consumes. Required:
   - Run every Playwright host project the change can reach (`webapp`, `widget-jupyterlab`, `widget-vscode`, `jupyterlab-doc`, `vscode`) plus the per-feature projects from the neighborhood (`format-loading`, `playback`, `sidebar`, `pipeline-editor`, `pipeline-file`, `render-modal`, `widget-api`, `camera`, `measurement`, `subsystems`, `trajectory-bonds`, `modify-node`, `phase2`). Use the table in the `e2e-coverage` skill to pick. Set `MEGANE_E2E_MODE=1` for the `:vscode` and `:widget-vscode` projects.
   - Confirm the **intended** change is reflected (extend specs / re-baseline only for intended diffs; visually inspect any new baseline PNG before committing it).
   - Sweep the rest of the matrix for **side effects**: treat unexpected pixel diffs, timeouts, or runtime errors in *other* projects as regressions and fix the root cause — do not silently re-baseline through them.
   - Commit any intentional baseline updates under `tests/e2e/baselines/<project>/` in the same PR.
   - In the PR description, list which Playwright projects you ran and which baselines you updated.
4. If the diff touches a parser or load-path file, hold it to CRITICAL RULE #11 (parsers read files as-is): no transformation beyond the documented lossless canonicalizations, per-atom data megane doesn't render goes into `ParsedStructure::scalar_channels`, and anything the parser must skip pushes a `ParsedStructure::warnings` entry instead of disappearing silently. The 2026-08 purity audit fixed every known violation — do not introduce new ones.
5. Do NOT commit generated files: `crates/megane-wasm/pkg/`, `dist/`, `target/`, `node_modules/`, `dev-preview/`
   Do NOT commit plan files: any file named `plan.md` or matching `*.plan.md` (these are local planning artifacts, not part of the codebase)
6. Check if your changes require documentation updates:
   - Review `README.md`, `CLAUDE.md`, and files under `docs/` for any descriptions affected by your changes
   - If you added/changed/removed features, CLI options, API, commands, configuration, or architecture, update the corresponding documentation
   - Key docs to check:
     - `README.md` — project overview, usage examples
     - `CLAUDE.md` — dev instructions, key commands, architecture notes
     - `CHANGELOG.md` — notable changes
     - `docs/` — user-facing guides and API reference
   - Include doc updates in the same commit (or a separate `docs:` commit if the changes are substantial)
7. If you changed pipeline nodes (`src/pipeline/`), ensure the Python API is also updated:
   - Node classes in `python/megane/pipeline.py` (add/update corresponding `PipelineNode` subclass)
   - Port mappings in `_SOURCE_OUTPUT_MAP` / `_TARGET_PORT_MAP`
   - Public exports in `python/megane/__init__.py`
   - Default parameters must match TypeScript `defaultParams()` in `src/pipeline/types.ts`

## After Committing

Always create a pull request after pushing your changes using `gh pr create`. Include a summary of changes and a test plan in the PR body. See the `github-cli` skill for remote URL workaround if `gh` fails.

If additional commits are pushed after the PR is created, review the PR title and description and update them to accurately reflect all changes. Both the title and summary must always match the actual diff.

## Reporting Results — CI Check Required

Before reporting task completion to the user, always verify that CI has passed on the pushed branch:

```bash
# Check CI status for the current branch
ORIG_REMOTE=$(git remote get-url origin)
git remote set-url origin https://github.com/hodakamori/megane.git
gh run list --branch "$(git branch --show-current)" --limit 1
# For more detail on a specific run:
# gh run view <run-id>
git remote set-url origin "$ORIG_REMOTE"
```

- If CI is still running, wait and re-check before reporting.
- If CI has failed, investigate the failure (`gh run view <run-id> --log-failed`), fix the issue, and push again.
- Only report success to the user after CI passes.
