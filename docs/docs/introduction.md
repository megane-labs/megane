# Introduction

**Megane** is a high-performance molecular viewer that works wherever you do — as a Jupyter widget, a standalone web app, an embeddable React component, and a VS Code extension.

## What can Megane do?

- **Render 1M+ atoms at 60 fps** in the browser using billboard impostor rendering
- **Load 28 file formats** — structures (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, LAMMPS data, VASP, Molden, XCrySDen, CML and more), trajectories (XTC, DCD, ASE `.traj`, LAMMPS dump, AMBER NetCDF), volumetric grids (Gaussian CUBE, OpenDX) and spectra (JCAMP-DX)
- **Scrub large trajectories** — the standalone web app, JupyterLab, and VS Code parse in a Web Worker and decode XTC / DCD / AMBER NetCDF / LAMMPS dump trajectories, multi-frame XYZ / PDB files and ASE `.traj` files of 8 MB or more on demand, reading each frame from the file when it is shown, so you can scrub multi-GB files without loading the file or every frame into memory; the Jupyter widget sends frames from the kernel one at a time, and the kernel reads XTC / DCD / NetCDF frames from the file the same way. The `megane serve` backend also exposes a binary WebSocket protocol for the Streaming pipeline node
- **Build visual pipelines** with a drag-and-drop node editor, describe them in natural language to the AI pipeline generator (docked in the pipeline editor, under the graph), or write them as Python/TypeScript code
- **Edit structures in [Megane Builder](./guide/builder)** — add, delete, move and re-element atoms, draw bonds, build bulk crystals, supercells and slabs, and save as XYZ / PDB / MOL — or, for anything with a unit cell, CIF / VASP POSCAR. It runs at `/builder.html` in the standalone web app, from the Megane view in VS Code's activity bar and the Megane panel in JupyterLab's left sidebar, and as `megane.Builder()` in notebooks
- **Integrate with Plotly**, MDX/Next.js, ipywidgets, and any framework via the framework-agnostic renderer
- **Light, dark, and auto themes** — cycle through Light / Dark / Auto via the Theme button on the Pipeline panel's left rail; persisted across sessions. Auto follows the VS Code or JupyterLab theme when Megane runs inside one, and the OS preference elsewhere

## Choose your distribution

Megane ships in six distributions, grouped by what you want to do — **view** your data interactively, **embed** the viewer in your own app, or **parse** files programmatically.

| Category | Distribution | Install | Start here |
|----------|--------------|---------|------------|
| **View** | Standalone web app | `pip install megane`, then `megane serve` | [Standalone web app](./guide/cli) |
| **View** | Jupyter widget | `pip install megane` | [Jupyter widget](./guide/jupyter) |
| **View** | JupyterLab extension | `pip install megane` | [JupyterLab extension](./guide/jupyterlab) |
| **View** | VS Code extension | Install the Megane extension | [VS Code extension](./guide/vscode) |
| **Embed** | React component | `npm install megane-viewer` | [React component](./guide/web) |
| **Parse** | Python package | `pip install megane` | [Python Pipeline API](./guide/pipeline/python) |

For a side-by-side comparison of which formats and UI features each distribution supports — including known gaps — see [Platform Support](./platform-support).

## Supported file formats

### Structures

| Format | Extension |
|--------|-----------|
| Protein Data Bank | `.pdb` |
| GROMACS structure | `.gro` |
| XYZ (single- or multi-frame, incl. extended `Lattice=`) | `.xyz`, `.jxyz`, `.extxyz` |
| MDL Molfile (V2000 and V3000) | `.mol` |
| MDL SDfile (parsed via the Molfile reader) | `.sdf` |
| Tripos MOL2 | `.mol2` |
| Crystallographic Information File | `.cif` |
| Macromolecular CIF (mmCIF/PDBx) | `.mmcif` |
| LAMMPS data | `.data`, `.lammps` |
| AMBER topology | `.prmtop` |
| ASE trajectory | `.traj` |
| LAMMPS dump (opens standalone as a multi-frame structure) | `.lammpstrj`, `.dump`, `.trj` |
| VASP (matched by filename as well as extension; `XDATCAR` is multi-frame) | `POSCAR`, `CONTCAR`, `XDATCAR`, `.vasp` |
| Molden (`[Atoms]` geometry and `[GEOMETRIES] XYZ` frames) | `.molden` |
| XCrySDen (`.axsf` is a multi-frame animation) | `.xsf`, `.axsf` |
| Chemical Markup Language | `.cml` |
| Chem3D XML | `.c3xml` |
| Wavefunction Odyssey (XML and Spartan-style text layouts) | `.xodydata`, `.odydata` |
| CASTEP NMR magres | `.magres` |
| GAMESS output (each coordinate block becomes a frame) | `.gamess` |
| CASTEP phonon (structure half) | `.phonon` |

### Trajectories

| Format | Extension |
|--------|-----------|
| GROMACS trajectory | `.xtc` |
| CHARMM/NAMD DCD trajectory | `.dcd` |
| AMBER NetCDF trajectory | `.nc` |
| LAMMPS dump (also loadable standalone, above) | `.lammpstrj`, `.dump`, `.trj` |

### Volumetric grids and spectra

| Format | Extension |
|--------|-----------|
| Gaussian CUBE | `.cube`, `.cub` |
| OpenDX scalar field | `.dx` |
| JCAMP-DX spectra (AFFN plus the SQZ/DIF/DUP compressed forms) | `.jdx`, `.jcamp`, `.dx` |

A grid is rendered as an isosurface over a separately-loaded structure; a spectrum is a 2D trace drawn by the terminal `SpectrumPlot` node. `.dx` is claimed by both OpenDX and JCAMP-DX, so the loader sniffs the file head and tells you if it is really the other one.

### Bonds and topology

| Format | Extension |
|--------|-----------|
| GROMACS topology | `.top` |
| CHARMM/NAMD PSF | `.psf` |

Per-host coverage (which formats each platform's UI can open vs. parser-only access) is enumerated in [Platform Support](./platform-support).

## Architecture at a glance

Megane is a Rust core compiled to both WebAssembly (browser) and a Python extension (PyO3), with a TypeScript/React frontend built on Three.js.

```
┌────────────┐     ┌────────────────────┐     ┌──────────────────┐
│  Rust core │────▶│  WASM (browser)    │────▶│  React / Three.js│
│ megane-core│     └────────────────────┘     └──────────────────┘
│            │     ┌────────────────────┐     ┌──────────────────┐
│            │────▶│  PyO3 (Python)     │────▶│  Jupyter widget  │
└────────────┘     └────────────────────┘     └──────────────────┘
```

All environments share the same parser and pipeline execution engine — a pipeline defined in Python produces identical output to the same pipeline in the browser.

## Next steps

- [Installation & Quick Start](./getting-started) — get Megane running in 2 minutes
- [Gallery](/gallery) — live 3D examples with copy-paste code
- [Live Demo](https://megane-labs.github.io/megane/app/) — interactive viewer in the browser
