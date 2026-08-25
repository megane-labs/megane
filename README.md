<h1 align="center">
  <img src="docs/public/logo.png" alt="" width="32" />
  megane
</h1>

<p align="center">Spectacles for atomistic data.</p>
<p align="center"><em>1M+ atoms at 60fps. Visual pipelines. Jupyter widget, standalone web app, React component, VS Code extension.</em></p>

<p align="center">
  <a href="https://github.com/megane-labs/megane/actions/workflows/ci.yml"><img src="https://github.com/megane-labs/megane/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://pypi.org/project/megane/"><img src="https://img.shields.io/pypi/v/megane" alt="PyPI" /></a>
  <a href="https://www.npmjs.com/package/megane-viewer"><img src="https://img.shields.io/npm/v/megane-viewer" alt="npm" /></a>
  <a href="https://github.com/megane-labs/megane/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://pypi.org/project/megane/"><img src="https://img.shields.io/pypi/pyversions/megane" alt="Python" /></a>
  <a href="https://megane-labs.github.io/megane/"><img src="https://img.shields.io/badge/docs-online-blue" alt="Docs" /></a>
  <a href="https://codecov.io/gh/megane-labs/megane"><img src="https://codecov.io/gh/megane-labs/megane/graph/badge.svg" alt="codecov" /></a>
</p>

<p align="center">
  <a href="https://megane-labs.github.io/megane/">Docs</a> &middot;
  <a href="https://megane-labs.github.io/megane/getting-started">Getting Started</a> &middot;
  <a href="https://pypi.org/project/megane/">PyPI</a> &middot;
  <a href="https://www.npmjs.com/package/megane-viewer">npm</a>
</p>

<p align="center">
  <img src="docs/public/screenshots/megane-promo.gif" alt="megane demo" width="640" />
</p>

---

## Features

- **1M+ Atoms at 60fps** — Billboard impostor rendering scales from small molecules to massive complexes in real time. InstancedMesh for small systems auto-switches to GPU-accelerated billboard impostors for large systems. Stream XTC trajectories over WebSocket.
- **Runs Everywhere** — Jupyter widget, standalone web app (`megane serve`), React component (npm), and VS Code extension. Rust-based parsers for 26 formats (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, CML, LAMMPS data, AMBER topology, GROMACS topology, CHARMM/NAMD PSF, XTC, DCD, ASE .traj, LAMMPS dump, AMBER NetCDF, VASP, Molden, XCrySDen XSF, JCAMP-DX, Chem3D XML, Odyssey, CASTEP magres, GAMESS output, CASTEP phonon) shared between Python (PyO3) and browser (WASM) — parse once, run anywhere.
- **Visual Pipeline Editor** — Build visualization workflows by wiring nodes or let the AI generator build them from natural language. 19 node types with 9 typed data channels flowing through color-coded edges. Load multiple structures with layer-based rendering to compare systems side by side.
- **Embed & Integrate** — Control the viewer from Plotly via ipywidgets events. Embed in MDX / Next.js docs. React to `frame_change`, `selection_change`, and `measurement` events. Use the framework-agnostic renderer from Vue, Svelte, or vanilla JS.

### Scale

megane renders over **1 million atoms at 60fps** in the browser. Small systems get high-quality InstancedMesh spheres and cylinders; large systems automatically switch to GPU-accelerated billboard impostors. No desktop app, no plugin — just a browser tab.

Trajectory streaming works over WebSocket via a binary protocol. Load an XTC file and scrub through thousands of frames in real time, without reading everything into memory.

### Anywhere

One codebase, every environment.

| Distribution | How | Install |
|---|---|---|
| **Jupyter widget** | anywidget inline viewer | `pip install megane` |
| **JupyterLab extension** | Open any supported structure, trajectory, volumetric, or spectrum file — plus `.megane.json` pipelines — straight from the file browser | `pip install megane` |
| **Standalone web app** | `megane serve` in the browser | `pip install megane` |
| **React component (npm)** | `<MeganeViewer />` component | `npm install megane-viewer` |
| **VS Code extension** | Custom editor for the same file types, registered by extension and by VASP basename (`POSCAR`/`CONTCAR`/`XDATCAR`) | Extension |

For a per-platform breakdown of supported formats and UI features (including known gaps), see [Platform Support](https://megane-labs.github.io/megane/platform-support).

The secret: parsers for 26 formats (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, CML, LAMMPS data, AMBER topology, GROMACS topology, CHARMM/NAMD PSF, XTC, DCD, ASE .traj, LAMMPS dump, AMBER NetCDF, VASP, Molden, XCrySDen XSF, JCAMP-DX, Chem3D XML, Odyssey, CASTEP magres, GAMESS output, CASTEP phonon) are written in **Rust** and compiled to both **PyO3** (Python) and **WASM** (browser). Parse once, run anywhere. The volumetric readers (Gaussian CUBE, OpenDX) are TypeScript-side.

### Visual Pipelines

Wire nodes to build visualization workflows — no code required.

**19 node types** across 5 categories: load data (structure, trajectory, streaming, vector, volumetric, spectrum), bonds, process (filter, modify, color, representation, replicate), overlay (labels, polyhedra, surface meshes, isosurfaces, vectors), and display in a 3D viewport or a 2D spectrum plot.

**9 typed data channels** — particle, bond, cell, label, mesh, trajectory, vector, volumetric, spectrum — flow through color-coded edges. Only matching types can connect.

Pipelines serialize to JSON, so you can save, share, and version-control your visualization recipes.

### Integrate

megane is not a walled garden. It fits into your existing workflow.

**Plotly** — Click a point on a Plotly `FigureWidget` to jump to a trajectory frame. Use megane's `on_event("frame_change")` callback to update Plotly markers in sync.

**MDX / Next.js** — Drop `<MeganeViewer />` or `<Viewport />` into your `.mdx` documentation. WASM parsing works out of the box with a one-line webpack config.

**ipywidgets** — React to `frame_change`, `selection_change`, and `measurement` events. Compose megane with any widget in the Jupyter ecosystem.

**Framework-agnostic** — `MoleculeRenderer` is a plain Three.js class. Mount it in Vue, Svelte, or a vanilla `<div>`.

## Installation

### Python

```bash
pip install megane
```

### npm (for React embedding)

```bash
npm install megane-viewer
```

Works with React 18 and React 19 (peer dependency: `react@^18.2.0 || ^19.0.0`).

## Quick Start

### Jupyter widget

```python
import megane

viewer = megane.view("protein.pdb")
viewer  # displays in notebook
```

With a trajectory:

```python
viewer = megane.view_traj("protein.pdb", xtc="trajectory.xtc")
viewer.frame_index = 50  # jump to frame 50
```

For advanced usage (filtering, multi-layer rendering, custom pipelines), see the [Pipeline API](https://megane-labs.github.io/megane/guide/pipeline#python-pipeline-api).

### Standalone web app (`megane serve`)

```bash
docker build -t megane .
docker run --rm -p 8080:8080 megane
```

Open http://localhost:8080 in your browser.

To view your own files, mount them into the container:

```bash
docker run --rm -p 8080:8080 -v ./mydata:/data megane \
  megane serve /data/protein.pdb --port 8080 --no-browser
```

### React component (npm)

```tsx
import { useCallback } from "react";
import "megane-viewer/styles.css";
import { MeganeViewer, usePipelineStore } from "megane-viewer/lib";

function App() {
  const handleUpload = useCallback((file: File) => {
    usePipelineStore.getState().openFile(file);
  }, []);

  return (
    <MeganeViewer
      onUploadStructure={handleUpload}
      width="100%"
      height="600px"
    />
  );
}
```

## Supported File Formats

### Structure formats (`LoadStructure` node)

| Format | Extension | Description |
|--------|-----------|-------------|
| PDB | `.pdb` | Protein Data Bank |
| GRO | `.gro` | GROMACS structure file |
| XYZ | `.xyz`, `.jxyz` | Cartesian coordinate format, incl. multi-frame and `Lattice=` extended XYZ. `.jxyz` is Jmol's second extension for the same format |
| MOL/SDF | `.mol`, `.sdf` | MDL Molfile (V2000) |
| MOL2 | `.mol2` | Tripos MOL2 (multi-molecule, aromatic bonds) |
| LAMMPS data | `.data`, `.lammps` | LAMMPS data file |
| CIF | `.cif` | Crystallographic Information File |
| mmCIF | `.mmcif` | Macromolecular CIF (PDBx/mmCIF) |
| AMBER topology | `.prmtop` | AMBER parameter/topology file (atom names, elements, bonds) |
| ASE .traj | `.traj` | ASE trajectory (ULM binary format) — self-contained with elements, bonds, and frames |
| XCrySDen | `.xsf`, `.axsf` | XCrySDen structure; `.axsf` is a multi-frame animation with optional per-frame cell and per-atom forces |
| CML | `.cml` | Chemical Markup Language (Open Babel / Avogadro / ChemDraw), with explicit bonds and optional crystal cell |
| VASP | `POSCAR`, `CONTCAR`, `XDATCAR`, `.vasp` | VASP crystal structure; XDATCAR is multi-frame. Matched by filename as well as extension, since the standard names carry no extension |
| Molden | `.molden` | Molden quantum-chemistry output — `[Atoms]` geometry (AU or Angstrom) and `[GEOMETRIES] XYZ` optimisation frames |
| Chem3D XML | `.c3xml` | PerkinElmer Chem3D / ChemDraw XML (CDXML family) — nodes with explicit bonds and orders |
| Odyssey | `.xodydata`, `.odydata` | Wavefunction Odyssey — the XML layout and the older Spartan-style text layout, told apart by content rather than extension |
| CASTEP magres | `.magres` | CASTEP / Quantum ESPRESSO NMR output — the `[atoms]` block (lattice + labelled atoms) with per-block units |
| GAMESS output | `.gamess` | GAMESS (US / Firefly) log output — every `COORDINATES OF ALL ATOMS ARE` block becomes a frame |
| CASTEP phonon | `.phonon` | CASTEP lattice-dynamics output — the header (cell + fractional coordinates + species) renders as a periodic structure |

### Volumetric formats (`LoadVolumetric` node)

| Format | Extension | Description |
|--------|-----------|-------------|
| Gaussian CUBE | `.cube`, `.cub` | Gaussian cube grid (Bohr, converted to Angstrom on read) |
| OpenDX | `.dx` | OpenDX scalar field — the APBS electrostatics output, also read by VMD and PyMOL |

A grid has no atoms of its own, so it is rendered as an isosurface over a
separately-loaded structure. `.dx` is shared with JCAMP-DX spectra, so the
loader sniffs the content and says so if the file is really a spectrum.
### Spectrum formats (`LoadSpectrum` node)

A spectrum is a 2D (x, y) trace with no atoms or coordinates, so it is drawn by
the terminal `SpectrumPlot` node instead of reaching the 3D renderer.

| Format | Extension | Description |
|--------|-----------|-------------|
| JCAMP-DX | `.jdx`, `.jcamp`, `.dx` | IR / NMR / MS / UV-Vis spectra; AFFN plus the compressed ASDF forms (SQZ, DIF, DUP). `.dx` is shared with OpenDX volumetric grids and resolved by sniffing the file head |

### Trajectory formats (`LoadTrajectory` node)

| Format | Extension | Description |
|--------|-----------|-------------|
| XTC | `.xtc` | GROMACS compressed trajectory |
| DCD | `.dcd` | CHARMM/NAMD binary trajectory |
| AMBER NetCDF | `.nc` | AMBER NetCDF trajectory |
| LAMMPS dump | `.lammpstrj`, `.dump` | LAMMPS dump trajectory |

## Development

### Prerequisites

- Python 3.10+
- Node.js 22+
- Rust (for building the parser)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) (for building WASM bindings)
- [uv](https://docs.astral.sh/uv/)

### Setup

```bash
git clone https://github.com/megane-labs/megane.git
cd megane

# Install wasm-pack (if not already installed)
cargo install wasm-pack

# Python
uv sync --extra dev

# Node.js
npm install
npm run build
```

### Running `megane serve`

After setup, build and install the package, then start the server:

```bash
maturin develop --release
megane serve protein.pdb
```

### Development Mode

```bash
# Terminal 1: Vite dev server
npm run dev

# Terminal 2: Python backend
uv run megane serve protein.pdb --dev --no-browser
```

### Tests

```bash
uv run pytest              # Python tests
npm test                   # TypeScript unit tests
cargo test -p megane-core  # Rust tests
make test-all              # All tests
```

## Project Structure

```
src/                     TypeScript frontend
  renderer/              Three.js rendering (impostor, mesh, shaders)
  protocol/              Binary protocol decoder + web workers
  parsers/               WASM-based file parsers (26 formats: PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, CML, LAMMPS data/dump, AMBER topology/NetCDF, GROMACS topology, CHARMM/NAMD PSF, XTC, DCD, ASE .traj, VASP, Molden, XCrySDen XSF, JCAMP-DX, Chem3D XML, Odyssey, CASTEP magres, GAMESS output, CASTEP phonon)
  logic/                 Bond / label / vector source logic
  components/            React UI components
  hooks/                 Custom React hooks
  stream/                WebSocket client
crates/                  Rust workspace
  megane-core/           Core parsers and bond inference
  megane-python/         PyO3 Python extension
  megane-wasm/           WASM bindings (wasm-bindgen)
python/megane/           Python backend
  parsers/               Python wrappers for 22 of the 26 supported formats, plus the PSF / GROMACS .top topology sidecars (mmCIF and AMBER prmtop are accessible via the raw megane_parser PyO3 extension; Gaussian CUBE and OpenDX are browser-side only)
  pipeline.py            Pipeline builder (NetworkX-style DAG)
  protocol.py            Binary protocol encoder
  server.py              `megane serve` backend (FastAPI + WebSocket)
  widget.py              anywidget Jupyter widget
tests/                   Tests (Python, TypeScript, E2E)
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for the
development setup, test commands, and project design rules. Fork PRs run the
full CI and E2E pixel checks automatically — no tokens or setup needed on
your side. This project follows the
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md); security issues
should be reported privately per [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
