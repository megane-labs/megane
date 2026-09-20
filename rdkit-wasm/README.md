# rdkit-wasm

RDKit's ETKDG conformer embedding and MMFF94/UFF minimisation compiled to
WebAssembly with Emscripten, for megane Builder's "embed a flat sketch in 3D"
feature. It exists because the official RDKit.js (`@rdkit/rdkit`, MinimalLib)
exposes only 2D coordinate generation (`set_new_coords`), and a pure-JS
alternative (openchemlib-js) measured 10–50× slower than RDKit on the same
molecules.

The wrapper is intentionally tiny (`src/rdkit_embed.cpp`, three functions)
and RDKit itself is built unmodified from a pinned release tag, so upgrading
RDKit is a one-line change to `RDKIT_TAG` in `scripts/build.sh`.

## Build

Requirements: git, curl, cmake ≥ 3.20, ninja (optional), a host C++ compiler
for Boost's `bootstrap.sh`, Python 3 (emsdk), Node 22+. Eigen headers are
taken from `/usr/include/eigen3` when present (`apt install libeigen3-dev`)
and cloned otherwise.

```bash
bash rdkit-wasm/scripts/build.sh          # deps → rdkit → wrapper → test
bash rdkit-wasm/scripts/build.sh rdkit    # just rebuild the RDKit libraries
bash rdkit-wasm/scripts/build.sh wrapper  # just relink the wrapper into dist/
node rdkit-wasm/test/smoke.mjs
```

Everything the build downloads or compiles lives in `rdkit-wasm/.deps/`
(override with `RDKIT_WASM_DEPS_DIR`), which the CI workflow caches so only
the wrapper relinks on a normal run. Only the four RDKit targets the wrapper
links (`DistGeomHelpers`, `ForceFieldHelpers`, `FileParsers`, `SmilesParse`)
and their dependencies are compiled; drawing, fingerprints, reactions, InChI,
coordgen and the other externals are switched off, and RDKit's configure-time
downloads (RingDecomposerLib, …) are disabled so the build also works behind
egress policies that block GitHub release archives.

Outputs: `dist/rdkit-embed.mjs` (Emscripten ES-module glue) and
`dist/rdkit-embed.wasm`. Neither is committed; the CI workflow
(`.github/workflows/rdkit-wasm.yml`) uploads them as a build artifact.

## API

```ts
import { loadRDKitEmbed } from "@megane-labs/rdkit-embed-wasm";

const rdkit = await loadRDKitEmbed({ locateFile: (f) => new URL(`./dist/${f}`, import.meta.url).href });
rdkit.version(); // "2026.03.6"

const { molblocks, energies, converged, forceField, warnings } = rdkit.embed(molfileFromKetcher, {
  numConfs: 1,          // ETKDG conformers to generate
  forceField: "MMFF94s", // "MMFF94s" | "MMFF94" | "UFF" | "none"; MMFF falls back to UFF when untyped
  maxIters: 500,
  randomSeed: 42,       // the loader's default; -1 lets RDKit pick
  embedParams: { useRandomCoords: true }, // any RDKit EmbedParameters override
});
```

`embed` accepts a SMILES or an MDL mol block (auto-detected). Hydrogens are
added before embedding (`addHs: true`) and kept in the output unless
`removeHs: true`. Stereo from wedge bonds in the mol block is honoured by ETKDG
(`enforceChirality`). The result is one V2000 mol block per conformer, which
megane's existing MOL parser reads directly.

The call is synchronous and takes tens to hundreds of milliseconds for
drug-sized molecules, so run it in a Web Worker in the browser.

## Layout and where this should live

This directory is self-contained (no imports from `src/`, its own
`package.json`, build script and CI workflow) so it can be moved into its own
repository with `git subtree split -P rdkit-wasm` when publishing to npm is
wanted. The reasons to split it out are the ones that apply to any vendored
toolchain: the build takes tens of minutes and needs emsdk, Boost and a C++
compiler that the rest of megane never touches; the artifact is a versioned
binary that megane should consume as a dependency rather than rebuild; and
RDKit's release cadence is independent of megane's.

Until then, megane consumes the workflow artifact and the directory is
excluded from the root `npm` workspaces, ESLint/Prettier (`src/` only) and
vitest (`tests/ts/` only) configuration.

## Licensing

RDKit is BSD-3-Clause, Boost is BSL-1.0, zlib is the zlib licence and Eigen is
MPL-2.0 (header only); all are compatible with megane's MIT licence. Open Babel
was ruled out for being GPL-2.
