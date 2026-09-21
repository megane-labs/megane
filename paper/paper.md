---
title: 'megane: a Rust/WebAssembly molecular viewer for notebooks, browsers, and editors'
tags:
  - molecular visualization
  - molecular dynamics
  - materials science
  - Jupyter
  - WebAssembly
  - Rust
  - Three.js
authors:
  - name: Hodaka Mori
    orcid: 0000-0000-0000-0000
    corresponding: true
    affiliation: 1
affiliations:
  - name: TODO Affiliation, Country
    index: 1
date: 12 September 2026
bibliography: paper.bib
---

<!--
TODO before submission:
- Fill in ORCID and affiliation; decide whether other contributors are co-authors.
- Replace the performance sentence in "Software design" with numbers measured by
  scripts/profile-render-fps.mjs and scripts/profile-streaming.mjs on named hardware.
- Fill in the Research impact statement with download counts and known users.
-->

# Summary

`megane` is an open-source molecular viewer that renders atomistic structures,
molecular-dynamics (MD) trajectories, volumetric grids, and spectra in a web
browser at interactive frame rates. Its file parsers are written once in Rust
and compiled both to WebAssembly (WASM) for the browser and to a native Python
extension, so a file is read identically wherever it is opened. The same viewer
ships on five hosts from one codebase: a Jupyter widget, a JupyterLab document
extension, a standalone web application (`megane serve`), a React component on
npm, and a VS Code custom editor. Visualizations are built as a typed dataflow
graph in a visual pipeline editor and saved as JSON, so a figure is a
version-controllable recipe rather than a sequence of clicks. An optional
language-model assistant turns a natural-language request into such a graph and
checks its own output by executing it.

# Statement of need

Atomistic simulation produces large, heterogeneous output. A single project can
involve GROMACS or LAMMPS trajectories, AMBER or CHARMM topologies, VASP,
CASTEP, or GAMESS runs, ASE trajectories, and Gaussian cube files, and the
people inspecting them increasingly work in notebooks, documentation sites, and
code editors rather than in a dedicated desktop application. Four practical
problems follow.

*Format fragmentation.* Browser viewers usually implement parsers in
JavaScript while the analysis stack is in Python, so the two disagree on edge
cases and support different format subsets. `megane` implements 26 formats in
one Rust crate (`megane-core`) and exposes the same code through `wasm-bindgen`
[@wasmbindgen] and PyO3 [@pyo3]. The parsers are deliberately pure: they return
what the file asserts, and every transformation a user might want to inspect or
disable (symmetry expansion, wrapping, supercell replication, bond inference on
top of file-declared bonds, coloring) is a pipeline node instead.

*Scale.* Web viewers typically degrade well below a million atoms. `megane`
draws each atom as a screen-aligned quad shaded by ray-sphere intersection and
each bond as a ray-cast cylinder, so a million-atom system is a single
instanced draw call. Trajectories are streamed frame by frame over a binary
WebSocket protocol rather than loaded into memory, so long XTC, DCD, or AMBER
NetCDF runs can be scrubbed without a size limit set by the browser.

*Environment fragmentation.* A viewer that works in a notebook but not in a
documentation page or an editor forces users to convert files and relearn a
second tool. `megane` keeps the host adapters thin and documents a per-host
support matrix, so a format or node added to one host is expected on all of
them.

*Reproducibility.* Interactive viewers rarely record how a picture was made.
In `megane` the picture is the output of a serialized directed acyclic graph
(`.megane.json`) that can be committed, diffed, shared as a link, and
re-executed by any host, including from Python through a builder API that
mirrors the visual editor.

The intended users are computational chemists, MD practitioners, and materials
scientists who inspect their own simulations; developers who embed a viewer in
documentation, dashboards, or tools; and educators who need a viewer that runs
in a browser tab with no installation.

# State of the field

Desktop viewers such as VMD [@vmd], PyMOL [@pymol], OVITO [@ovito], ChimeraX
[@chimerax], and VESTA [@vesta] are mature and powerful, but they are
desktop-bound: they cannot be embedded in a notebook cell, a documentation
site, or an editor, and each has its own installation and plugin ecosystem.
Browser-native viewers such as 3Dmol.js [@3dmol], NGL [@ngl], and Mol\*
[@molstar] remove the installation step, and Mol\* in particular sets the
standard for structural biology, but their parsers live in JavaScript and are
therefore separate from the Python code that produced the data; they cover
fewer MD and materials formats, and they expose a scripting API rather than a
visual, serializable pipeline. Notebook wrappers such as nglview [@nglview] and
py3Dmol [@3dmol] bring those viewers into Jupyter but inherit their limits and
add no standalone or editor host. OVITO's modifier stack is the closest
precedent for the pipeline model, and `megane` adopts the same "one modifier
owns one visual property" discipline, but in the browser and with the graph
itself as the exchange format. Trajectory analysis libraries such as MDAnalysis
[@mdanalysis] and ASE [@ase] read many of the same formats but do not render.

`megane` therefore occupies a distinct position: a shared Rust parser core for
Python and the browser, million-atom impostor rendering with streamed
trajectories, five hosts from one codebase, a typed and serializable dataflow
pipeline, and one tool spanning structures, trajectories, volumetric data
(Gaussian CUBE and OpenDX isosurfaces), and spectra (JCAMP-DX).

# Software design

`megane` is a Cargo workspace with three crates and a TypeScript/React
frontend. `megane-core` holds the parsers and bond inference; `megane-wasm`
wraps it with `wasm-bindgen`; `megane-python` wraps it with PyO3. The Python
package adds a FastAPI server with WebSocket streaming for the standalone
application and an anywidget [@anywidget] implementation for Jupyter. The
frontend renders with Three.js [@threejs] and hosts the pipeline editor with
xyflow.

The pipeline is a directed acyclic graph in which every edge carries one of ten
typed channels (particle, bond, coordination, cell, label, mesh, trajectory,
vector, volumetric, spectrum). Twenty-four node types load data, add or filter
bonds, modify, color, and choose representations for atoms, apply crystal
symmetry, wrap or replicate periodic cells, generate labels, coordination
polyhedra, surface meshes, isosurfaces, and vector overlays, and finally draw
to a 3D viewport or a 2D spectrum plot. The editor refuses connections between
mismatched channel types, so each executor can trust the shape of its inputs.
Execution is separated from rendering: the engine produces a plain
`ViewportState` with no graphics dependency, which a thin layer maps onto
renderer calls. This lets the pipeline be unit-tested without WebGL and lets
every host reuse one engine.

Rendering uses two strategies. Small systems use instanced meshes for the
highest visual quality; large systems switch automatically to billboard
impostors whose fragment shaders ray-cast spheres and cylinders, with atom
positions stored in a data texture so that per-frame updates cost O(number of
atoms) regardless of bond count. Trajectories arrive over a compact binary
protocol that carries positions, and optionally per-frame elements and cell,
so heterogeneous trajectories (variable atom count or variable cell) play back
without a special path. The stated design target, over one million atoms at
60 frames per second on mid-range hardware, is verified with the profiling
scripts kept in the repository.

The natural-language assistant generates a pipeline from a prompt, then runs
a self-check: schema validation, selection-syntax parsing, edge typing, and,
when a structure is loaded, actual execution so that real node errors are fed
back to the model for repair. A prompt-evaluation benchmark of prompt, golden
pipeline, and rendered image triples grades the generator in CI.

Quality is enforced at three levels: unit tests in Rust, TypeScript, and
Python with a Codecov patch-coverage gate of 70 %, a Playwright end-to-end
matrix that exercises each feature on all five hosts against pixel baselines,
and continuous integration on GitHub Actions that publishes the PyPI, npm, and
VS Code Marketplace artifacts from one release tag.

# Research impact statement

<!-- TODO: replace with concrete evidence (PyPI/npm downloads, GitHub stars,
external issues, courses, papers using megane) collected shortly before
submission. -->

`megane` is distributed on PyPI, npm, and the VS Code Marketplace and is used
to inspect MD and electronic-structure output directly inside the notebooks
and documentation where that output is analysed. Because a `megane` figure is
a JSON graph, groups can publish the exact recipe behind a visualization
alongside the simulation inputs, which is not possible with click-driven
viewers. The shared Rust core also makes the parser suite reusable on its own:
the Python package exposes every format without the viewer, and the npm
package exposes the framework-agnostic renderer for dashboards and teaching
material.

# AI usage disclosure

Large language models were used during development of `megane`, primarily
through the Claude Code agent, to implement features, write tests, and draft
documentation. Every such change was reviewed by a human maintainer, passed
the project's unit, coverage, and end-to-end gates, and was merged through a
pull request. The software itself contains an optional feature that, only when the user
supplies an API key or a build provides a proxy, calls a language model to
generate pipelines from natural language; that feature is a user-facing
capability and is distinct from the development use disclosed here. This manuscript was drafted with language-model
assistance and edited by the authors.

# Acknowledgements

We thank the contributors to the `megane` repository for bug reports, patches,
and testing across hosts. <!-- TODO: funding -->

# References
