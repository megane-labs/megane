# Platform Support

megane ships in six distributions. They share the same Rust parser core (compiled to WASM and PyO3), but the host UI and the set of registered file types differ. This page is the single reference for **what works on which platform**, and it is descriptive of the current state — including known gaps.

## Terminology

The docs describe megane along one axis: the **distribution** (host) you run it in. To keep names consistent everywhere:

- **Standalone web app** — the full viewer served by the `megane serve` command. `megane serve` is the CLI launcher and "the `megane serve` backend" is its FastAPI + WebSocket server; neither is a separate distribution, and Docker is just one way to run it. Do not call this host "CLI", "CLI server", or "Browser".
- **Jupyter widget**, **JupyterLab extension**, **VS Code extension** — the three embedded-in-a-host viewers. Microsoft's editor is written "VS Code"; our distribution is the "VS Code extension".
- **React component (npm)** — the `megane-viewer` package you embed in your own React (or, via the core renderer, non-React) app.
- **Python package** — the PyO3 parser API. No viewer.
- Viewer objects map to hosts: the `MolecularViewer` widget (Jupyter), the `MeganeViewer` React component (npm), and the shared `MoleculeRenderer` core renderer (framework-agnostic). `megane.view()` / `view_traj()` are convenience wrappers that return a `MolecularViewer`.

## Platforms

| Platform | Entry | What it is |
|---|---|---|
| **Standalone web app** | `src/index.tsx`, served by `megane serve` | Full-featured viewer with pipeline editor, drag-and-drop, file dialogs, and WebSocket trajectory streaming. |
| **Jupyter widget** (anywidget) | `src/widget.ts` + `python/megane/widget.py` | Embedded viewer in a notebook cell, driven by Python (`MolecularViewer`). |
| **JupyterLab extension** (labextension) | `jupyterlab-megane/src/index.ts` | Document-style viewer launched from the JupyterLab file browser. |
| **VS Code extension** | `vscode-megane/webview/main.tsx` | Custom editor activated when a registered file type is opened in VS Code. |
| **React component (npm)** | `src/lib.ts`, package `megane-viewer` | Embeddable React components (`MeganeViewer`, `PipelineViewer`, `Viewport`) plus the framework-agnostic `MoleculeRenderer`. The same viewer as Standalone, minus the `megane serve` backend (no built-in WebSocket streaming). |
| **Python package** (PyO3) | `python/megane/parsers/` | Programmatic API for parsing files into Python objects. No viewer. |

## File-format support

Legend:

- **✓** — openable directly from the platform's native UI (file browser, drag-drop, customEditor, `LoadStructure`/`LoadTrajectory` node, etc.)
- **API** — parser exists and is reachable programmatically, but the platform does not expose a UI opener for this format
- **—** — not supported

### Structure formats

| Format | Extensions | Standalone | Jupyter widget | JupyterLab | VS Code | React (npm) | Python |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| PDB | `.pdb` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| GRO | `.gro` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| XYZ | `.xyz`, `.jxyz` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| MOL | `.mol` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| SDF | `.sdf` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| MOL2 | `.mol2` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| CIF | `.cif` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| mmCIF | `.mmcif` | ✓ | API | ✓ | ✓ | ✓ | API |
| LAMMPS data | `.data`, `.lammps` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| AMBER topology | `.prmtop` | ✓ | API | ✓ | ✓ | ✓ | API |
| ASE trajectory | `.traj` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| LAMMPS dump | `.lammpstrj`, `.dump`, `.trj` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| XCrySDen | `.xsf`, `.axsf` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| CML | `.cml` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| VASP | `POSCAR`, `CONTCAR`, `XDATCAR`, `.vasp` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| Molden | `.molden` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| Chem3D XML | `.c3xml` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| Odyssey | `.xodydata`, `.odydata` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| CASTEP magres | `.magres` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| GAMESS output | `.gamess` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| CASTEP phonon | `.phonon` | ✓ | API | ✓ | ✓ | ✓ | ✓ |

The **React component (npm)** column reflects the bundled `MeganeViewer` / `PipelineViewer`, which open these formats through the same WASM parser as Standalone (`parseStructureFile`); the host app wires the upload/drag-drop callbacks. The `MoleculeRenderer` core renderer consumes already-parsed snapshots.

Note: ASE `.traj` is self-contained (elements, bonds, and all frames in one file) and is loaded via the **Load Structure** node, not Load Trajectory. It is listed here because it contains multi-frame trajectory data.

Note: **LAMMPS dump** (`.lammpstrj` / `.dump` / `.trj`) is also loaded via the **Load Structure** node as a self-contained multi-frame structure — frame 0 defines the topology and the remaining frames stream into playback, exactly like a multi-frame XYZ. Because a dump carries no element symbols or masses, the integer per-atom `type` id is used as the atomic-number **proxy** for colouring/sizing (placeholder chemistry, not real elements), and bonds are inferred by distance. A dump can still be **attached onto a separately-loaded topology** (which supplies true elements) via the Load Trajectory node — see the Trajectory formats table below.

Note: **XCrySDen** (`.xsf` / `.axsf`) is one format with two shapes. A static
file carries a dimensionality keyword (`CRYSTAL`, `SLAB`, `POLYMER`, `MOLECULE`,
or `ATOMS`), an optional `PRIMVEC` lattice, and a `PRIMCOORD`/`ATOMS` block;
an animated `.axsf` opens with `ANIMSTEPS n` and repeats those blocks per step,
which megane loads as a multi-frame structure — including **variable-cell**
animations, where each step's `PRIMVEC` animates the box. The first column of an
atom line may be an atomic number or an element symbol, and a negative number
(XCrySDen's ghost-atom convention) is read as its magnitude. The optional
per-atom **force** triple is exposed as a `force` vector channel, so the Vector
Overlay node can draw it with no format-specific wiring. `CONVVEC` is consumed
and discarded — `PRIMVEC` is the cell megane draws — and
`BEGIN_BLOCK_DATAGRID_*` volumetric blocks are skipped; mapping those onto the
isosurface pipeline is a follow-up.
Note: **CML** (Chemical Markup Language) is the first XML format in the core.
The reader loads the **first `<molecule>` that carries atoms** — multi-molecule
files (several `<molecule>` elements under `<cml>` / `<list>`) are not yet
treated as frames. Coordinates are read in this order of preference:
`x3`/`y3`/`z3`, a packed `xyz3="x y z"`, `xFract`/`yFract`/`zFract` (converted
with the `<crystal>` cell parameters), and finally `x2`/`y2`, which is a **2D
depiction projected onto z = 0** so the file still opens — visibly flat, which
is the honest rendering of flat input. A `<bondArray>` supplies explicit
connectivity (including bond orders; aromatic collapses to 1, matching the MOL2
reader), and bonds are inferred by distance only when the file has none.
Fractional coordinates without a `<crystal>` cell are a clear error rather than
a silent misplacement. XML is read with `quick-xml`, a pull parser that performs
no DTD processing and no custom entity expansion, so an untrusted `.cml` cannot
mount an XXE or billion-laughs attack.
Note: **VASP** files are the one format megane dispatches by **filename**, not
only by extension: `POSCAR`, `CONTCAR`, and `XDATCAR` are conventionally written
with no extension at all. `src/parsers/fileNames.ts` maps those bare names (and
their common suffixed forms — `POSCAR.bak`, `CONTCAR_relaxed`, `XDATCAR-run2`)
onto the synthetic `.vasp` extension every other dispatch point already
understands, so drag-drop on Standalone, the JupyterLab file browser (via an
`IFileType.pattern`), and the VS Code `customEditors` selector (`POSCAR*` /
`CONTCAR*` / `XDATCAR*`) all open them. The **file dialog** filter is the one
place that cannot express an extensionless name — an HTML `accept` list only
takes extensions and MIME types — so the Standalone picker offers `.vasp` and
bare `POSCAR`/`CONTCAR`/`XDATCAR` files are opened by dragging them in (or by
switching the picker to "All Files"). An **XDATCAR** opens as a multi-frame
structure, exactly like a multi-frame XYZ; variable-cell runs (ISIF ≥ 3), which
re-emit the whole header before each configuration, animate the cell too. A
**VASP 4** file has no species-name line (species come from POTCAR); rather than
failing, the 1-based species index becomes the atomic-number **proxy** — the same
convention LAMMPS dump uses for its integer `type` ids — and every atom is
labelled `Type<N> (no species line)` so the substitution is visible in the viewer.
`Selective dynamics` flags are parsed and ignored, and a trailing velocity block
is skipped.

Note: **Molden** files are read for their geometry only. The `[Atoms]` block
becomes the structure, and its mandatory `(AU)` / `(Angs)` argument is honoured —
treating Bohr as Angstrom is a 1.889× error, so a file that omits the argument is
read as Angstrom (what every writer that omits it means). A `[GEOMETRIES] XYZ`
block is a concatenated multi-frame XYZ and is handed to the existing XYZ frame
reader, so an optimisation can be scrubbed on the timeline. `[GTO]` / `[MO]`
orbital coefficients and `[FREQ]` / `[FR-NORM-COORD]` normal modes are
deliberately skipped: evaluating orbitals onto a grid and animating vibrational
modes are separate features, and the latter should share one format-agnostic
node with CASTEP `.phonon`. Every unrecognised `[...]` section is skipped
tolerantly — writers emit many vendor-specific blocks and the parser never fails
on one it does not know.
Note: **Chem3D XML** (`.c3xml`) reads `<n>` (node) elements for their
`Element` and `Position` and `<b>` (bond) elements for explicit connectivity and
orders, so no distance inference is needed for genuine 3D input. The schema is
only loosely documented, so the reader is permissive: it accepts the long
spellings (`<node>` / `<bond>` with `Begin` / `End`) some exports use, `Element`
may be an atomic **number or a symbol**, and a node with no `Element` defaults to
carbon — the CDXML convention. Chem3D's **native** export (root
`<C3XML version="…">`, the dialect Chem3D 10+ actually writes) is also read:
atoms are `<atom symbol="C" cartCoords="x y z">` elements and bonds are
`<bond bondAtom1 bondAtom2 bondOrder>` elements. A **2D-only drawing** (`p="x y"` instead of
`Position`) is projected onto z = 0 so the file still opens, matching the CML
reader's decision, and bonds are deliberately **not** inferred for it because
projected 2D distances are meaningless. The binary `.cdx` and general `.cdxml`
variants are out of scope. It shares `quick-xml` with the CML reader, so no new
dependency.
Note: **Odyssey** (Wavefunction Inc.'s teaching package, same vendor as
Spartan) writes **two unrelated layouts** and megane reads both through one
parser that picks by **content, not extension** — either layout turns up under
either name. `.xodydata` is the modern XML default rooted at
`<odyssey_simulation>`: `<atom>` carries `element` and `xyz`, `<bond>` carries
`a`/`b`/`order`, and `<boundary box="x y z"/>` declares an orthorhombic
periodic cell. `.odydata` is the older text layout shared with Spartan's
archive input section (`ENDCART` / `ATOMLABELS` / `HESSIAN` … `ENDHESS`). Bond
orders are spelled `s`/`d`/`t`/`a` or as integers, and **aromatic collapses to
1** for display, matching the `.mol2` reader. Odyssey centres a periodic sample
on the box centre, so atoms are shifted by `+(x/2, y/2, z/2)` into a cell drawn
at the world origin. A file that declares no bonds falls back to distance
inference. Wavefunction publishes **no schema**, so the reader is written
against the element/attribute vocabulary its files use and fails loudly rather
than guessing; `<group charge>` / `<member entity>` formal charges are skipped
because there is no formal-charge channel to put them in, and
wavefunction-based surfaces (orbitals, densities, electrostatic potentials) are
not stored in these files at all. It reuses `quick-xml`, so no new dependency.
Note: **magres** files are read for their `[atoms]` block only — the lattice
and the labelled atoms become a normal periodic structure. Both block-delimiter
spellings found in the wild are accepted: the documented `[atoms]` … `[/atoms]`
and the XML-style `<atoms>` … `</atoms>` that CASTEP itself and CCP-NC's
`format.py` emit. Each block in a
magres file declares its **own** `units` line, and the parser honours them
independently (Angstrom or bohr for the lattice and the atoms separately)
rather than assuming Angstrom. The `ms` / `efg` / `isc` entries in `[magres]`
are 3×3 per-atom tensors with no home in the current renderer — showing them
wants a per-atom scalar channel (e.g. isotropic shielding = trace/3) that the
colour-by-property path could consume, plus optionally an ellipsoid
representation — so they are deliberately left for a follow-up. Only the
new-style `#$magres-abinitio-v1.0` variant is read; the **old-style**
(pre-2010) free-form grammar is a different language and is rejected with a
message that says so rather than misparsed.
Note: **GAMESS** support reads the program's printed **log output**, not a data
format. Every `COORDINATES OF ALL ATOMS ARE` banner block becomes a frame, so a
geometry optimisation scrubs on the timeline like a multi-frame XYZ and the
terminal `EQUILIBRIUM GEOMETRY LOCATED` block is simply the last one. The
banner's `(ANGS)` / `(BOHR)` argument is honoured, and the element comes from
the nuclear-charge column — rounded, since ECP runs print a fractional valence
charge, with the atom label as the fallback when the rounded charge is not an
element. Bonds are inferred by distance because GAMESS output carries no
connectivity.

Note: **`.gamess` is the only extension registered for it.** GAMESS logs are
normally named `.log` or `.out`, and claiming those in the VS Code
`customEditors` selector or the JupyterLab filetypes would hijack every log file
in the user's workspace. Rename a log to `.gamess`, or load it through the Load
Structure node — that is the deliberate trade-off, not an oversight.
Note: **CASTEP `.phonon`** currently renders the **header only** — the unit
cell, fractional coordinates, and species become a normal periodic structure, so
the file opens and the cell draws. The frequencies and complex eigenvectors that
follow are parsed by the core (`phonon::parse_with_modes` returns a
`PhononModes` alongside the structure) but are not yet surfaced to the viewer:
displacing each atom along `Re(eigenvector)·cos(ωt)` over synthetic frames is a
**feature**, not a parser concern — it needs a pipeline node plus a q-point and
branch picker. That node should be **format-agnostic** so Molden's `[FREQ]` /
`[FR-NORM-COORD]` can share it rather than growing a second implementation, and
the issue asks for it to land separately.

Note: **`.jxyz`** is Jmol's second extension for plain XYZ, not a separate
format, so it is an **alias** to the XYZ reader rather than a second parser.
megane's XYZ parser already covers everything Jmol's writes: multi-frame
blocks, `Lattice=` extended headers, and extra per-atom columns after x/y/z
(an atom name and a partial charge in Jmol's output), which are kept as the
per-atom label. It is registered on the same JupyterLab `IFileType` as `.xyz`
for the same reason.

Note: **Heterogeneous frames** — trajectories whose frames differ in atom count (adsorption/GCMC/reactions), unit cell (variable-cell / NPT), or elements — are supported by every multi-frame structure format: **ASE `.traj`**, **multi-frame / extended XYZ** (per-frame atom count and per-frame `Lattice=`), and **multi-MODEL PDB** (per-model atom count). Frame 0 defines the base topology; per-frame differences are carried alongside and the viewer swaps atoms, bonds, and cell as you scrub. Uniform trajectories (constant atoms/topology/cell, the common case) use an unchanged fast path and are unaffected. Large heterogeneous XYZ/PDB files that would otherwise stream lazily fall back to an eager parse so no frame is dropped.

### Volumetric formats

Scalar-field grids consumed by the **Load Volumetric** node and rendered by the
**Isosurface** node. A grid carries a field but **no atoms**, so it is always an
overlay on a separately-loaded structure — opening one standalone on JupyterLab
or VS Code surfaces an actionable error pointing at the Load Volumetric node,
the same guard the trajectory-only formats get.

| Format | Extensions | Standalone | Jupyter widget | JupyterLab | VS Code | React (npm) | Python |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Gaussian CUBE | `.cube`, `.cub` | ✓ | — | ✓⁶ | ✓⁶ | ✓ | — |
| OpenDX | `.dx` | ✓ | — | ✓⁶ | ✓⁶ | ✓ | — |

⁶ Registered so the file opens megane, which then explains that a grid needs a
structure to overlay. Load it through the **Load Volumetric** node in the
pipeline editor.

Both readers live in **TypeScript** (`src/pipeline/executors/parseCube.ts` and
`parseDx.ts`), not in `megane-core`, so there is no Python API for them. CUBE
coordinates are Bohr and converted to Ångström on read; OpenDX is already in
Ångström. Both use the same voxel ordering (ix outer, iz inner), so the
Isosurface node consumes them interchangeably.

**`.dx` is ambiguous.** OpenDX grids and JCAMP-DX spectra share the extension,
so dispatch sniffs the content: OpenDX opens with `object … class
gridpositions`, JCAMP-DX with `##TITLE=` / `##JCAMP-DX=`. A `.dx` that turns out
to be a spectrum gets an explicit "megane has no 2D plot surface yet" message
rather than a confusing parse failure.

### Trajectory formats

| Format | Extensions | Standalone | Jupyter widget | JupyterLab | VS Code | React (npm) | Python |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| XTC | `.xtc` | ✓ | API | ✓¹ | ✓¹ | ✓¹ | ✓ |
| DCD | `.dcd` | ✓ | API | ✓¹ | ✓¹ | ✓¹ | ✓ |
| LAMMPS dump | `.lammpstrj`, `.dump`, `.trj` | ✓ | API | ✓ | ✓ | ✓ | ✓ |
| AMBER NetCDF | `.nc` | ✓ | API | ✓¹ | ✓¹ | ✓¹ | ✓ |

¹ Trajectory-only formats need a topology already loaded. Opening a `.xtc` /
`.dcd` / `.nc` directly surfaces an actionable error; recover by
opening a structure file (PDB, GRO, …) first or by wiring a Load Structure
node in the always-mounted pipeline editor. **LAMMPS dump is _not_
trajectory-only** — it opens standalone as a multi-frame structure (see the
Structure formats table); it is also listed here because it can additionally be
_attached_ onto a separately-loaded topology (which supplies true elements)
via the Load Trajectory node.

Note: **Heterogeneous frames** apply to the trajectory formats too. XTC, DCD, and
AMBER NetCDF carry a fixed atom count but a **per-frame unit cell** (variable-cell
/ NPT), now animated during playback instead of collapsed to one box. **LAMMPS
dump** additionally supports a **variable atom count** and per-frame atom type
(GCMC / deposition / evaporation): frame 0 defines the base topology (its type ids
are mapped to elements via the loaded structure) and the viewer adds/removes atoms
per frame. Constant-cell, constant-atom trajectories keep the fixed-stride fast
path. Large variable-atom LAMMPS dumps that would otherwise stream lazily fall
back to an eager parse so no frame is dropped. The Python-hosted viewers (Jupyter
widget, JupyterLab) receive the per-frame elements/cell over the streaming
protocol as well.

### Topology formats

Topology files carry bond information but no coordinates. They are used with
the **Add Bond** pipeline node to supply explicit connectivity when the
structure file does not encode it (e.g. pairing a PDB with a PSF, or a GRO
with a GROMACS `.top`).

| Format | Extensions | Standalone (Add Bond node) | React (npm) | Python |
|---|---|:---:|:---:|:---:|
| GROMACS topology | `.top` | ✓ | ✓ | ✓ |
| CHARMM/NAMD PSF | `.psf` | ✓ | ✓ | API² |

² Python `AddBonds` only wires GROMACS `.top` topology via the `top=` parameter. PSF bonds are accessible programmatically via `megane.parsers.psf.parse_psf_bonds(path)` or `megane_parser.parse_psf_bonds(text)`, but cannot be passed directly to an `AddBonds` pipeline node.

### Spectrum formats

Spectrum files carry a 2D (x, y) trace and **no atoms or coordinates at all**,
so they never reach the 3D renderer. They are opened with the **Load Spectrum**
pipeline node and drawn by the **Spectrum Plot** node, a terminal node that
produces no geometry.

| Format | Extensions | Standalone | Jupyter widget | JupyterLab | VS Code | React (npm) | Python |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| JCAMP-DX | `.jdx`, `.jcamp`, `.dx`³ | ✓ | API | ✓⁴ | ✓⁴ | ✓ | ✓ |

³ `.dx` is claimed by **both** JCAMP-DX and OpenDX volumetric grids, so it
cannot be dispatched by extension alone. The Load Spectrum node sniffs the file
head (`##TITLE=` / `##JCAMP-DX=` versus `object … class gridpositions`) and, when
a `.dx` turns out to be an OpenDX grid, reports that instead of failing
opaquely. Because the JupyterLab `IFileType` and VS Code `customEditors`
registries can only match on extension, `.dx` is deliberately **not** registered
with either host — only `.jdx` and `.jcamp` are.

⁴ A spectrum has no coordinates, so opening one from the JupyterLab file browser
or the VS Code editor surfaces an actionable message pointing at the Load
Spectrum → Spectrum Plot pair in the always-mounted pipeline editor, rather than
a blank viewport.

Note: **JCAMP-DX** decoding covers the plain **AFFN** form and all three
compressed **ASDF** forms — **SQZ** (sign-carrying digit), **DIF** (difference
from the previous ordinate, with its Y-value checkpoint at each line start), and
**DUP** (repeat the previous value _n_ times) — for both `##XYDATA=(X++(Y..Y))`
and `##XYPOINTS=(XY..XY)` tables. `##XFACTOR=` / `##YFACTOR=` are applied, and a
missing `##DELTAX=` is derived from `FIRSTX` / `LASTX` / `NPOINTS`.
**Compound (link) files** (`##BLOCKS=n` with embedded `##TITLE=` … `##END=`
blocks — multi-spectra collections, GC-MS runs, Bruker `*_assigned` exports)
are split and each block parsed with its own headers; the first full-spectrum
(`##XYDATA=`) block is shown, falling back to the first peak table, since the
plot surface renders one spectrum. **NTUPLES** exports (`##DATA CLASS=NTUPLES`,
Bruker XWIN-NMR/TopSpin) are read via their `##DATA TABLE= (X++(R..R)), XYDATA`
real page — the imaginary page is skipped and the abscissa is rebuilt from the
X variable's `##FIRST=` / `##LAST=` because Bruker writes the X column as a raw
point counter. True nD data (`##NUM DIM=` ≥ 2, e.g. HMBC) has no 1D rendering
and is rejected with a message that says so.

Sources of truth: `crates/megane-wasm/src/lib.rs` (browser parsers), `crates/megane-python/src/lib.rs` (Python parsers), `src/components/nodes/LoadStructureNode.tsx` and `src/components/nodes/LoadTrajectoryNode.tsx` (standalone accept lists), `src/components/nodes/AddBondNode.tsx` (topology accept list), `src/parsers/fileNames.ts` (filename-based dispatch for extensionless VASP files), `src/pipeline/executors/parseVolumetric.ts` (volumetric accept list + `.dx` content sniffing), `src/parsers/spectrum.ts` (spectrum accept list and JCAMP-DX/OpenDX sniffing), `jupyterlab-megane/src/filetypes.ts` (JupyterLab `IFileType` registrations), `vscode-megane/package.json` (VS Code `customEditors`).

## UI features

| Feature | Standalone | Jupyter widget | JupyterLab | VS Code | React (npm) | Python |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Drag-and-drop into viewer | ✓ | — | — | — | ✓ | n/a |
| Built-in file picker | ✓ | — | host | host | ✓ | n/a |
| Visual pipeline editor | ✓ | — | ✓ | ✓ (`.megane.json`) | ✓ | n/a |
| Trajectory timeline / scrubbing | ✓ | ✓ | ✓ | ✓ | ✓ | n/a |
| WebSocket trajectory streaming | ✓ | — | — | — | — | n/a |
| Multi-layer rendering | ✓ | ✓ (via pipeline) | ✓ | ✓ | ✓ | n/a |
| Solvent-accessible surface (SAS) | ✓ | ✓ (via pipeline) | ✓ | ✓ | ✓ | n/a |
| Surface mesh (alpha-shape envelope) | ✓ | ✓ (via pipeline) | ✓ | ✓ | ✓ | n/a |
| Crystallographic symmetry expansion for CIF (asymmetric unit → full cell) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`Symmetry`) |
| Wrap / unwrap periodic coordinates (pipeline node) | ✓ | ✓ (via pipeline) | ✓ | ✓ | ✓ | ✓ (`Wrap`) |
| Replicate supercell (pipeline node) | ✓ | ✓ (via pipeline) | ✓ | ✓ | ✓ | ✓ (`Replicate`) |
| `frame_change` callback | ✓ (React prop) | ✓ (Python event) | ✓ (status bar) | ✓ (status bar) | ✓ (React prop) | n/a |
| `selection_change` / `measurement` events | ✓ (React props) | ✓ | ✓² | ✓² | ✓ (React props) | n/a |
| Programmatic frame seek (`frame_index = N`) | ✓ | ✓ | ✓³ | ✓⁴ | ✓ | n/a |
| Export downloads (render output, pipeline JSON, measurement CSV/JSON) | ✓ | ✓⁵ | ✓ | ✓ (save dialog) | ✓ | n/a |
| Animation export (GIF)⁶ | ✓ | ✓⁵ | ✓ | ✓ (save dialog) | ✓ | n/a |

³ JupyterLab: call `meganeReactView.seekFrame(N)` on a `MeganeReactView` instance obtained from the widget tracker. This delegates to `usePlaybackStore.seekFrame(N)` in the viewer.

⁴ VS Code: call `vscode.commands.executeCommand('megane.seekFrame', N)` from another extension, or call `meganeEditorProvider.seekFrame(N)` on an `MeganeEditorProvider` reference. The command posts a `seekFrame` message to the most recently active megane webview panel.

⁵ Jupyter widget: export downloads work when the notebook runs in a browser (JupyterLab, Jupyter Notebook). Inside a VS Code notebook the widget renders in a sandboxed webview with no path to the extension host, so downloads are unavailable — see Known gaps.

⁶ GIF is the only export that runs in a Web Worker (gif.js encodes there; MP4 uses MediaRecorder on the main thread). The encoder source is inlined into each host bundle and loaded from a `blob:` URL, so it does not depend on the host's asset base path — resolving it as a URL broke JupyterLab (#497) and VS Code (#599), in both cases hanging the encode instead of erroring. Keep it worker-source-inlined when touching `resolveGifWorkerScript`.

Notes:

- **host** means the parent app provides the file picker (the JupyterLab file browser, the VS Code explorer); megane itself does not render one.
- The Jupyter widget intentionally does not mount the visual pipeline editor — pipelines are built in Python (`megane.Pipeline`) and pushed via `MolecularViewer.set_pipeline()`. Use the standalone app, JupyterLab extension, VS Code extension, or the npm `MeganeViewer` to edit pipelines visually.
- The standalone app is the only platform with `megane serve` WebSocket streaming; other platforms load full trajectories into memory.
- The standalone React `MeganeViewer` exposes an `onFrameChange?: (frame: number) => void` prop that fires on every trajectory frame transition — useful for keeping a host Plotly figure in sync.
- The standalone React `MeganeViewer` also exposes `onSelectionChange?: (selection: SelectionState) => void` (fires on every atom selection change; data: `{ atoms: number[] }`) and `onMeasurementChange?: (measurement: Measurement | null) => void` (fires when a distance/angle/dihedral measurement is computed or cleared) — both mirror the Jupyter widget's `selection_change` and `measurement` events.
- ² On **JupyterLab**, `selection_change` / `measurement` events are surfaced via `MeganeReactView.subscribeSelectionChange` and `subscribeMeasurementChange` — consumable by other JupyterLab extensions. On **VS Code**, they are forwarded to the extension host as `selectionChange` / `measurementChange` webview messages and reflected in the status bar (atom count or measurement label).

## Load methods / APIs

How data gets into the viewer on each platform:

| Platform | Primary load path | API surface |
|---|---|---|
| **Standalone** | Drag-and-drop, file dialog, `megane serve <file>`, WebSocket | `parseStructureFile(file)` (TypeScript), pipeline node `LoadStructure` / `LoadTrajectory` |
| **Jupyter widget** | Python only — no in-cell file picker | `MolecularViewer.load(pdb_path, xtc=, traj=)` (deprecated) or `MolecularViewer.set_pipeline(Pipeline)` (recommended) |
| **JupyterLab** | Click a registered file type in the file browser | Internally reads `context.model` (`jupyterlab-megane/src/MeganeDocWidget.tsx`) |
| **VS Code** | Open a registered file from the explorer; extension host posts `loadFile` / `loadPipeline` to the webview | `postMessage({ type: "loadFile", … })` (`vscode-megane/webview/main.tsx`) |
| **React (npm)** | Host-wired upload/drag-drop into `MeganeViewer`, or a `pipeline` prop on `PipelineViewer` (`fileUrl` fetched at mount) | `parseStructureFile(file)` / `parseStructureText(text)`, `MoleculeRenderer.loadSnapshot(snapshot)` |
| **Python** | `from megane import …` or `from megane.parsers import …` | Top-level `megane`: `load_pdb`, `load_cif`, `load_jcampdx` (JCAMP-DX spectra), `load_lammps_data`, `load_lammpstrj_structure`, `load_traj`, `load_trajectory` (XTC), `load_xyz_trajectory`. Full set via `megane.parsers`: additionally `load_gro`, `load_mol`, `load_sdf`, `load_mol2`, `load_dcd`, `load_netcdf`, `load_lammpstrj`, `load_vasp`, `load_molden`, `load_xsf`, `load_cml`, `load_c3xml`, `load_odydata`, `load_magres`, `load_gamess`, `load_phonon`. `load_jcampdx` returns a `Spectrum` (title/units/x/y) rather than a structure, since a spectrum has no atoms. Raw PyO3 functions (all formats including mmCIF and AMBER prmtop) are in the native extension `megane_parser`: `from megane import megane_parser; megane_parser.parse_mmcif(text)`, `megane_parser.parse_prmtop(text)`, etc. |

## Known gaps

These are formats or features that the parser layer supports but a given platform does not yet wire into its UI. They are documented here so users do not file bugs against expected-but-absent behaviour.

- **Trajectory-only opens require a topology first.** On VS Code and JupyterLab, opening a `.xtc` / `.dcd` / `.nc` file before any structure is loaded surfaces a friendly error. The recommended flow is to open the structure first, or to use the pipeline editor (always mounted on these hosts) to wire a Load Structure node. (LAMMPS dump `.lammpstrj` / `.dump` / `.trj` is exempt — it opens standalone as a multi-frame structure.)
- **Export downloads do not work for the Jupyter widget inside a VS Code notebook.** Browsers download exports via a synthetic `<a download>` click, and the VS Code custom editor relays them to the extension host (`saveFile` webview message → native save dialog). The anywidget running inside VS Code's notebook renderer webview can do neither — the sandbox ignores anchor downloads and provides no bridge to the extension host. Use JupyterLab (or the VS Code custom editor on a structure file) to export.
- **Jupyter widget has no in-cell file picker or drag-and-drop.** This is intentional — the widget is Python-driven. Use `set_pipeline()` with a `Pipeline` to load any supported format.
- **The Replicate node does not replicate trajectory frames.** The `replicate` pipeline node builds a static supercell from the structure's particles, bonds, and cell, but trajectory frames keep the original atom count. With a trajectory connected and any replication count > 1, the static structure and playback frames differ in atom count. The default pipelines wire Replicate with `nx = ny = nz = 1` (identity), so this only surfaces once a user increases the counts on a structure that also has a trajectory. Replicate also requires a unit cell on the input — structures without a cell pass through unchanged.
- **Jupyter widget has no visual pipeline editor.** The editor's React surface relies on host chrome (drag handles, side panel layout) that the anywidget cell cannot reliably render, so it is only shipped on the standalone app, JupyterLab extension, and VS Code extension. Build pipelines in Python with `megane.Pipeline` and push them via `MolecularViewer.set_pipeline()`.
- **`selection_change` / `measurement` events on JupyterLab use a subscription API, not a Python callback.** The JupyterLab DocWidget has no Python kernel connection, so there is no Python callback surface. Use `MeganeReactView.subscribeSelectionChange` and `subscribeMeasurementChange` from another JupyterLab extension.
- **`frame_change` callback for JupyterLab is surfaced as a status-bar frame counter.** The JupyterLab DocWidget has no Python kernel connection, so there is no Python callback surface. Instead, when `IStatusBar` is available, the current frame index is shown in the JupyterLab status bar (right side). The `subscribeFrameChange` method on `MeganeReactView` can also be used by other JupyterLab extensions to react to frame changes.
- **CIF symmetry expansion is a pipeline node, on by default; mmCIF is not expanded.** Since 0.14.0 the `.cif` parser returns the asymmetric unit as the file declares it, plus the raw `_symmetry_equiv_pos_as_xyz` operations (parser-purity rule #11) — expansion happens in the `symmetry` node, which the default pipelines and the crystal templates carry in `expand` mode on every host, so a CIF still renders the packed unit cell (VESTA-style) by default. Set the node's `mode` to `"none"` to see the raw asymmetric unit. Two consequences: a pipeline saved before 0.14.0 has no `symmetry` node, so a CIF loaded through it shows the asymmetric unit until you add one; and `megane.load_cif(...)`, which is the parser rather than the pipeline, now reports the asymmetric-unit atom count with the operations exposed as `symmetry_ops`. CIFs without symmetry operations (or with only the identity) are unchanged either way. The mmCIF/PDBx parser deliberately does **not** auto-expand — macromolecular depositions are shown as the deposited model. To then tile multiple cells, add a `Replicate` node (`megane.Replicate(nx, ny, nz)`), which is pure translational replication of the already-expanded cell.
