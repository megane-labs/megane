---
title: Parser Purity Audit
---

Catalogue of known violations of CLAUDE.md **CRITICAL RULE #11** — _"parsers
read files as-is; anything that changes what the user sees is a pipeline
node's job."_ Compiled from a full audit of `crates/megane-core/src/`, the
WASM/TS load path, and `python/megane/` (2026-08). Line numbers are
approximate and will drift; the function/section names are the stable
reference. When you touch one of these areas, fix the violation (or file an
issue for it) rather than building on top of it — and remove the entry here
in the same PR.

The 2026-08 P1–P3 sweep fixed every violation the original audit listed
except the tolerated fallback below (see the CHANGELOG for the user-visible
summary). Supporting infrastructure added by that sweep, available to every
parser:

- `ParsedStructure::scalar_channels` — per-atom scalar data the file carries
  but megane does not render yet (charges, selective-dynamics flags, dump
  computes, …). Parse it into a channel instead of reading past it.
- `ParsedStructure::warnings` — non-fatal parse warnings, surfaced by every
  host. Anything the file declares that the parser cannot represent (dropped
  bonds, skipped extra records, unknown units) must push one aggregated
  warning per category instead of disappearing silently.

Severity tiers: **P1** = the parser visibly changes geometry/topology vs. the
file · **P2** = wrong or invented appearance data · **P3** = file information
silently discarded that another host/tool renders.

## P1 — geometry/topology changed at parse time

None known.

## P2 — wrong or invented appearance data

| Where | What happens | What rule #11 wants instead |
| --- | --- | --- |
| `crates/megane-core/src/lammpstrj.rs` (~346, ~822) | LAMMPS `type` id is used directly as the atomic number, so type 1 renders as hydrogen with H's color/radius. Documented convention, tolerated as a last resort under carve-out (b) — but it must stay labelled as a proxy and never spread to formats that carry better data. | — (allowed fallback; listed for visibility) |

## P3 — file information silently discarded

None known. Note that multi-record files (extra `@<TRIPOS>MOLECULE` sections,
`$$$$`-separated SDF records, sibling CML `<molecule>` documents, extra
Odyssey `<structure>` blocks, JCAMP-DX compound blocks) still show only the
first record by design — megane's viewer displays one structure/spectrum —
but the skipped records are now surfaced through `warnings` rather than
silently discarded.

## Host-consistency notes (rule #6 overlap)

- `src/pipeline/openFile.ts` (`defaultBondSourceForFile`, ~117) picks
  `bondSource: "structure" | "distance"` per file extension at load time,
  while Python (`python/megane/pipeline.py`, ~377) defaults every format to
  `"distance"` — the same file opens with different bonds in the webapp vs.
  Python. Whichever policy wins should live in one shared default table.
- `python/megane/parsers/top.py` / `psf.py` duplicate the Rust
  `parse_top_bonds` / `parse_psf_bonds`; `src/parsers/inferBondsJS.ts`
  duplicates `crates/megane-core/src/bonds.rs`; and
  `src/pipeline/executors/symmetry.ts` is a deliberate port of
  `crates/megane-core/src/crystal.rs` (the two must stay in sync — see the
  doc note at the top of `crystal.rs`). Duplicated parser/inference logic
  drifts — prefer one implementation per algorithm.

## Compliant patterns to imitate

- **Element precedence:** `amber.rs` — explicit `ATOMIC_NUMBER` section first,
  atom-name guess only as a fallback for old prmtops. `psf.rs` resolves from
  the mass column before falling back to the atom name.
- **Unit-from-file conversion:** `magres.rs`, `molden.rs`, `gamess.rs`,
  `cml.rs` — the bohr/Å unit is read from the file, never assumed; GRO's
  spec-fixed nm→Å conversion covers every length-valued channel, velocities
  included.
- **Mass → element:** `lammps_data.rs` resolves elements from the `Masses`
  section the file carries instead of guessing from type ids.
- **Conditional bond inference:** `c3xml.rs`, `cml.rs`, `odydata.rs` infer
  only when the file declared no bonds (c3xml even skips inference for 2D
  drawings where distances are meaningless); `lammps_data.rs` and `mmcif.rs`
  infer only for atoms their file connectivity leaves unconnected.
- **Box anchored via `box_origin`, never by translating atoms:**
  `lammps_data.rs` and `odydata.rs` keep the file's coordinates verbatim and
  tell the renderer where the cell sits.
- **Expansion as a node:** `cif.rs` returns the asymmetric unit plus the raw
  `symmetry_ops`; the space-group expansion lives in the `symmetry` pipeline
  node (`src/pipeline/executors/symmetry.ts`, a port of `crystal.rs`), wired
  into the default pipelines in `expand` mode so the packed cell still renders
  by default while staying visible and toggleable.
- **Load-path routing as a visible node parameter:** opening a multi-frame
  structure file flips the LoadTrajectory node's `source` param to
  `"structure"` instead of silently deleting the node and rewiring edges.
- **Camera-only centering:** `src/renderer/CameraManager.ts` centers the
  *camera target*, never the coordinates; the renderer never drops atoms
  (unknown elements get a fallback color, including ghost/dummy sites kept
  as element 0).
- **Hosts call the executor:** the per-playback-frame distance-bond refresh in
  `MeganeViewer` / `PipelineViewer` / `WidgetViewer` goes through
  `computeFrameDistanceBonds` in `src/pipeline/executors/addBond.ts` — the
  transform lives in the node executor module only. Likewise `add_bond` and
  `coordination_generator` share one Drawing-Boundary site collector
  (`src/pipeline/executors/displaySites.ts`) instead of duplicating it.
