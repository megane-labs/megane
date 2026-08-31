# JOSS paper outline for megane

Working outline for the JOSS submission (`paper/paper.md` + `paper/paper.bib`).
JOSS format constraints (as of 2026): 750–1750 words, Markdown with YAML
front matter, BibTeX in `paper.bib`, citations as `[@key]`. Required sections:
Summary, Statement of Need, State of the Field, Software Design, Research
Impact Statement, AI Usage Disclosure. No API documentation in the paper.

## YAML front matter (draft)

- `title`: "megane: a Rust/WebAssembly-powered molecular viewer for notebooks, browsers, and editors"
- `tags`: molecular visualization, molecular dynamics, Jupyter, WebAssembly, Rust, Three.js
- `authors` / `affiliations`: Hodaka Mori (+ any co-authors) — TODO: affiliation + ORCID
- `date`, `bibliography: paper.bib`

## Summary (~150–250 words)

- One-paragraph description: megane is an open-source molecular viewer that
  renders structures, trajectories, volumetric grids, and spectra in the
  browser at interactive rates (1M+ atoms at 60 fps).
- Single Rust parser core (26 file formats) compiled to both WASM (browser)
  and PyO3 (Python) — "parse once, run anywhere."
- Runs on five host platforms from one codebase: Jupyter widget (anywidget),
  JupyterLab extension, standalone web app (`megane serve`), React/npm
  component, VS Code custom editor.
- Node-based visual pipeline editor (19 node types, 9 typed data channels)
  with JSON serialization for reproducible, shareable visualization recipes;
  optional LLM-assisted pipeline generation from natural language.

## Statement of Need (~250–400 words)

- Research problem: MD/quantum-chemistry/materials workflows produce large
  heterogeneous outputs (GROMACS, LAMMPS, AMBER, CHARMM/NAMD, VASP, CASTEP,
  GAMESS, ASE...); researchers need to inspect them where they work —
  notebooks, docs, editors — without desktop installs or format conversion.
- Pain points megane addresses:
  - Format fragmentation: one Rust parser suite covers 26 formats identically
    in Python and browser; no per-host reimplementation drift.
  - Scale: web viewers typically degrade above ~10^5 atoms; megane
    auto-switches from InstancedMesh to GPU billboard impostors, and streams
    XTC/DCD trajectories over a binary WebSocket protocol instead of loading
    into memory.
  - Environment fragmentation: same viewer and same pipeline JSON in Jupyter,
    JupyterLab, web app, React docs (MDX/Next.js), and VS Code.
  - Reproducibility: visualizations are serialized DAGs (`.megane.json`), so
    figures are version-controllable and re-runnable, not click-path lore.
- Target audience: computational chemists / MD practitioners / materials
  scientists; tool builders embedding a viewer; educators.

## State of the Field (~200–350 words)

- Compare against existing tools (each gets a citation in paper.bib):
  - Desktop: VMD, PyMOL, OVITO, ChimeraX — powerful but desktop-bound,
    plugin/install friction, no notebook/browser embedding of the same tool.
  - Web/JS: 3Dmol.js, Mol* (molstar), NGL — browser-native, but JS-side
    parsers (duplicated logic vs. Python), fewer MD/materials formats,
    no visual pipeline model; Mol* focuses on structural biology.
  - Notebook: nglview, py3Dmol — notebook-only, performance ceiling for
    million-atom systems, no standalone/editor hosts.
  - ASE GUI / matplotlib-based ad hoc scripts for materials formats.
- megane's differentiators to state explicitly: (1) shared Rust core across
  Python + WASM, (2) million-atom impostor rendering + trajectory streaming,
  (3) five hosts from one codebase, (4) typed dataflow pipeline with JSON
  serialization, (5) breadth: structures + trajectories + volumetric
  (CUBE/OpenDX isosurfaces) + spectra (JCAMP-DX) in one tool.

## Software Design (~250–400 words)

- Architecture diagram (optional figure): Rust workspace (megane-core /
  megane-wasm / megane-python) → TypeScript/React + Three.js frontend →
  Python backend (FastAPI + WebSocket, anywidget).
- Key design decisions to narrate:
  - Rust core as single source of truth for parsing and bond inference;
    compiled to WASM (wasm-bindgen) and PyO3 so browser and Python agree
    byte-for-byte.
  - Rendering strategy: high-quality InstancedMesh for small systems,
    automatic switch to billboard impostor shaders for large systems.
  - Binary streaming protocol over WebSocket for trajectories (constant
    memory, scrubbable playback).
  - Pipeline as typed DAG: 19 node types, 9 data channels (particle, bond,
    cell, label, mesh, trajectory, vector, volumetric, spectrum); type-safe
    edge connections; JSON round-trip; Python builder API mirrors the visual
    editor.
  - Host adapters kept thin so features land on all five platforms
    (documented per-platform support matrix).
- Quality practices (reviewers check these): three-language unit tests
  (vitest / cargo test / pytest), Codecov patch gate ≥70%, Playwright E2E
  matrix across all 5 hosts, CI on GitHub Actions.

## Benchmarks / performance evidence (supports Summary + Design claims)

- JOSS does not require benchmarks, but the "1M+ atoms at 60 fps" claim
  must be backed by a measurement. Planned table + methods sentence:
  - Rendering: FPS vs. atom count (1e4 / 1e5 / 1e6 atoms; InstancedMesh vs.
    impostor), fixed hardware + browser recorded.
  - Parsing: throughput for representative formats (PDB, GRO, XTC) via WASM,
    optionally vs. MDAnalysis/ASE wall-time as context.
  - Streaming: memory footprint + time-to-first-frame, streaming vs. eager
    load (existing harness: scripts/profile-streaming.mjs,
    scripts/profile-loading.mjs, src/perf.ts marks).
- One small figure or table max — the paper is short.

## Research Impact Statement (~100–200 words)

- JOSS (2025+) requires evidence of actual or plausible near-term research
  use. TODO — collect before submission:
  - PyPI / npm download counts, GitHub stars/forks/external issues.
  - Known external users, course/tutorial usage, integrations.
  - Any preprints/papers that used megane for figures.
- If no external evidence yet, describe concrete research workflows enabled
  (own group's use) — but external adoption strengthens the case a lot.

## AI Usage Disclosure (short, required)

- Disclose LLM-assisted development (e.g. Claude Code used for
  implementation assistance, with human review), per JOSS policy.
- Note that megane itself contains an optional LLM pipeline-generation
  feature — distinct from the disclosure, but worth a sentence.

## Acknowledgements + References

- Acknowledge contributors, funding (TODO).
- paper.bib entries needed: VMD, PyMOL, OVITO, ChimeraX, Mol*, NGL/nglview,
  3Dmol.js/py3Dmol, ASE, MDAnalysis, GROMACS/LAMMPS/AMBER (format
  provenance), Three.js, wasm-bindgen/PyO3, anywidget.

## Submission checklist (repo-level, outside the paper)

- [ ] OSI license: MIT ✓
- [ ] Public repo, issues, docs, tests, releases ✓
- [ ] `paper/paper.md` + `paper/paper.bib` on a dedicated branch
- [ ] Word count 750–1750
- [ ] Development history: JOSS guideline asks for ~6 months of public
      iterative history; first commit is 2026-02-27 (~2,000 commits),
      so the guideline is met from ~2026-09 onward — no need to delay
      submission.
- [ ] Archive a release (Zenodo DOI) at acceptance time
- [ ] Author ORCID + affiliation filled in
