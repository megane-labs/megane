---
name: add-format
description: Register a new file format across every megane host (standalone webapp, Jupyter widget, JupyterLab labextension, VSCode extension, Python). Use whenever you add a parser to `megane-core`, expose it via WASM/PyO3, or notice that an existing parser is missing from one of the host openers. Enforces CRITICAL RULE #6 in AGENTS.md.
---

# Adding a new file format to megane

A new format is **not done** until it is openable on every host where it makes sense. The Rust core, WASM bindings, and Python bindings only get you the parser — each host has a separate registration point and they drift independently. This checklist mirrors CRITICAL RULE #6 in `AGENTS.md`.

## When to use this skill

- Adding a new parser to `crates/megane-core/`.
- Exposing an existing core parser through WASM or PyO3 for the first time.
- Reviewing a bug report like "format X works on the webapp but won't open in VSCode / JupyterLab".
- Bumping an existing format's host coverage (e.g. trajectory format that was Standalone-only).

## Registration checklist

Walk every item. Skipping one means the format silently fails on at least one host.

### 1. Core + bindings

- [ ] `crates/megane-core/src/<format>.rs` — parser implementation + unit tests.
- [ ] `crates/megane-core/src/lib.rs` — module export.
- [ ] `crates/megane-core/src/formats.rs` — add one entry to `for_each_structure_format!` (or `for_each_trajectory_format!`) plus its `extensions()` and `parse()` match arms. Both bindings are generated from this table, so the WASM `#[wasm_bindgen] parse_<format>` and the PyO3 `megane_parser.parse_<format>` appear together with the same name and signature — do not hand-write per-format functions in `crates/megane-wasm/src/lib.rs` / `crates/megane-python/src/lib.rs`. `tests/ts/parsers/formatRegistry.test.ts` and `tests/python/test_format_registry.py` fail until `STRUCTURE_EXTS` / `TRAJECTORY_EXTS` and `python/megane/parsers/dispatch.py` list the same extensions.
- [ ] Run `npm run build:wasm` and `maturin develop --release` so downstream code can resolve the new symbol.

### 2. TypeScript parser dispatch (shared by **all** browser hosts)

- [ ] `src/parsers/parseCore.ts` — add the new export to the `WasmModule` interface and add a `case ".<ext>":` to `getParserForExtension`. (Trajectory formats: extend `TrajectoryKind` and the `switch` in `parseTrajectoryCore` / `indexTrajectoryCore` in the same file instead.) `parseCore.ts` runs both in the parse Web Worker (`parse.worker.ts`) and on the main thread (`parseClientSync.ts`), so one edit covers both paths.

This is the only file that knows how to dispatch by extension; every host below relies on it.

### 3. Standalone webapp openers

- [ ] `src/parsers/fileNames.ts` — append `.<ext>` to `STRUCTURE_EXTS` (or `TRAJECTORY_EXTS` for a trajectory format). `STRUCTURE_ACCEPT` / `TRAJECTORY_ACCEPT` (file dialog filters) are derived from these, and `LoadStructureNode.tsx` / `LoadTrajectoryNode.tsx` import both, so this one list drives the dialog and the drag-drop guard.

### 4. JupyterLab labextension

- [ ] `jupyterlab-megane/src/filetypes.ts` — add a new entry to either `STRUCTURE_FILETYPES_TEXT` or `STRUCTURE_FILETYPES_BINARY` (binary needs `fileFormat: "base64"`). The labextension iterates these arrays at activation, so adding the entry is sufficient — no other wiring needed.

### 5. VSCode extension

- [ ] `vscode-megane/package.json` — add `{ "filenamePattern": "*.<ext>" }` to the `megane.structureViewer` `customEditors[0].selector` array.
- [ ] `vscode-megane/package.json` — extend the top-level `description` so the marketplace listing mentions the new format.

### 6. Documentation

- [ ] `docs/docs/platform-support.md` — add a row to the Structure or Trajectory table with the correct symbols (`✓` / `API` / `—`) for every host. **`platform-support.md` is the single source of truth** — don't leave it stale.
- [ ] `README.md` — add a row to the format table near the existing PDB / GRO / … entries.
- [ ] If the format has format-specific quirks (e.g. trajectory needs topology), add a note next to the table.

### 7. Tests + fixtures

- [ ] `tests/fixtures/<sample>.<ext>` — commit a small but realistic fixture.
- [ ] Rust unit test in the new `<format>.rs`.
- [ ] TypeScript test in `src/parsers/__tests__/` if dispatch logic is non-trivial.
- [ ] Optional: add the fixture to an existing E2E spec (e.g. `tests/e2e/format-loading.spec.ts`) so the matrix exercises the new opener on every host. E2E is local-only — re-baseline with `MEGANE_E2E_UPDATE=1` per the `e2e-coverage` skill.

### 8. Verification

- [ ] `cargo test -p megane-core`
- [ ] `npm run build:wasm && npm test`
- [ ] `npm run build` (catches Vite, JupyterLab, and webview bundle issues at once)
- [ ] Manual smoke test: open the new fixture from the webapp file dialog **and** from at least one host extension (JupyterLab file browser or VSCode explorer) before declaring done.

## Common omissions caught by this checklist

| Symptom | Missing step |
|---|---|
| Format works on webapp but VSCode shows "no editor" | §5 — `customEditors` selector |
| Format silently rejected by drag-drop in webapp | §3 — `STRUCTURE_EXTS` (different from `STRUCTURE_ACCEPT`) |
| Double-click in JupyterLab opens it as plain text | §4 — `filetypes.ts` registration |
| `parseStructureText` falls back to PDB and produces garbage | §2 — `getParserForExtension` switch case |
| `platform-support.md` claims `✓` but the host can't open it | §6 — table not updated alongside code |

## Source-of-truth pointers

These match AGENTS.md CRITICAL RULE #6:

- Format registry (generates the WASM and PyO3 parsers): `crates/megane-core/src/formats.rs`
- Standalone accept lists: `src/parsers/fileNames.ts` (`STRUCTURE_EXTS` / `TRAJECTORY_EXTS`, consumed by `LoadStructureNode.tsx` / `LoadTrajectoryNode.tsx`)
- JupyterLab filetypes: `jupyterlab-megane/src/filetypes.ts`
- VSCode customEditors: `vscode-megane/package.json`
- Cross-host status: `docs/docs/platform-support.md`
