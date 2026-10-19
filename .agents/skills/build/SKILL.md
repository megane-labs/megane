---
name: build
description: Build Megane components (WASM, frontend, Python wheel). Use when asked to build or when build errors occur.
---

# Building Megane

## Build Order (IMPORTANT)

WASM must be built BEFORE TypeScript/Vite. The dependency chain is:

1. `npm run build:wasm` — Compiles Rust to WASM (creates `crates/megane-wasm/pkg/`)
2. `tsc` — TypeScript compilation (imports from WASM pkg)
3. `vite build` — Bundles the app
4. `vite build --config vite.widget.config.ts` — Bundles the widget

`npm run build` does all of these in order.

## Individual Build Commands

| Command | What | When to use |
|---|---|---|
| `npm run build:wasm` | Rust → WASM | After Rust code changes, or if pkg/ is missing |
| `npm run build:app` | WASM + tsc + Vite app | For standalone web app |
| `npm run build:widget` | Widget bundle only | After TS changes to widget code |
| `npm run build:lib` | WASM + widget lib | For npm publishing |
| `npm run build` | Everything | Full release build |
| `maturin develop --release` | Python extension | After Rust changes, for Python testing |
| `maturin build --release` | Python wheel | For distribution |

## Prerequisites

- `wasm-pack` must be installed (`cargo install wasm-pack` if missing)
- `maturin` must be installed for Python builds (`pip install maturin`)
- `npm install` must have been run

## Checking WASM Build Status

If `crates/megane-wasm/pkg/` directory exists, WASM is built.
If not, run `npm run build:wasm` before anything else.

> Note: a partial `pkg/` (has `.wasm`/`.js` but **no `package.json`**) is a
> failed build, not a successful one — Vite will 500 on `parseCore.ts`. See the
> sandbox section below.

## Sandbox / blocked wasm-opt

`npm run build:wasm` goes through `scripts/build-wasm.mjs`, which self-heals the
sandbox case: `wasm-pack` normally downloads the `wasm-opt` (binaryen) binary to
run `-O3` (configured in `crates/megane-wasm/Cargo.toml`), but that download is
blocked (HTTP 403) in sandboxed/proxied environments. When the download fails —
wasm-pack aborts after emitting the `.wasm`/`.js` but before writing
`pkg/package.json`, breaking Vite — the wrapper automatically retries with
`wasm-pack … --no-opt`, which skips wasm-opt entirely and writes a complete
`pkg/`.

- **No manual `Cargo.toml` editing** is needed anymore (the old workaround of
  toggling `wasm-opt = false` and restoring it is obsolete).
- Set `MEGANE_WASM_NO_OPT=1 npm run build:wasm` to skip the doomed optimized
  attempt and go straight to `--no-opt` in a known sandbox.
- The fallback produces an **unoptimized** `.wasm`. It is functionally identical
  and fine for dev/E2E, but absolute perf numbers are inflated — see AGENTS.md
  CRITICAL RULE #10. Optimized `-O3` builds are still produced automatically in
  CI / any networked environment.

## Dev Server

```
npm run dev
```
Starts Vite on port 5173. Requires WASM to already be built.
