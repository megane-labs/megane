# Configuration

## Development Setup

### Prerequisites

- Python 3.10+
- Node.js 22+
- Rust (for building the parser)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/) (`cargo install wasm-pack`)
- [uv](https://docs.astral.sh/uv/) (Python package manager)

### Clone and Install

```bash
git clone https://github.com/megane-labs/megane.git
cd megane

# Install Node.js dependencies first (required by make dev)
npm install

# Install Python dependencies (test tools, notebook support, etc.)
uv sync --extra dev

# Build the WASM parsers (required before `npm run dev`)
npm run build:wasm

# Build Rust extension (editable install)
maturin develop --release
```

### Development Mode

Run the frontend dev server and Python backend simultaneously:

```bash
# Terminal 1: Start the `megane serve` backend (FastAPI + WebSocket)
megane serve protein.pdb --dev --port 8765

# Terminal 2: Start the Vite dev server
npm run dev
```

## Build Commands

| Command | Description |
|---------|-------------|
| `make build` | Full build (frontend + Python wheel) |
| `make dev` | Development install |
| `make test-all` | Run all tests (Python + TypeScript + Rust + E2E + notebooks + integration) |
| `npm run build` | Full frontend build (WASM + web app + widget + npm library + JupyterLab labextension) |
| `npm run build:app` | Build WASM + the standalone web app only |
| `npm run dev` | Vite dev server (requires the WASM module to be built) |
| `npm run test` | Run TypeScript tests |
| `npm run build:wasm` | Build WASM module only |

## Project Structure

```
megane/
├── crates/                    # Rust workspace
│   ├── megane-core/           # Core parsers for 26 formats (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, CML, LAMMPS data/dump, AMBER topology/NetCDF, GROMACS topology, PSF, XTC, DCD, ASE .traj, VASP, Molden, XSF, JCAMP-DX, Chem3D XML, Odyssey, magres, GAMESS, CASTEP phonon) + structure writer
│   ├── megane-python/         # PyO3 bindings
│   └── megane-wasm/           # WASM bindings
├── python/megane/             # Python package
│   ├── widget.py              # Jupyter widget (anywidget)
│   ├── builder.py             # megane Builder Jupyter widget
│   ├── writers.py             # Structure writers (XYZ / PDB / MOL)
│   ├── pipeline.py            # Pipeline builder (NetworkX-style DAG)
│   ├── server.py              # FastAPI WebSocket server
│   ├── cli.py                 # CLI entry point
│   ├── protocol.py            # Binary protocol encoder
│   └── parsers/               # Parser wrappers
├── src/                       # TypeScript frontend
│   ├── components/            # React components
│   ├── pipeline/              # Pipeline graph, node executors, serialization
│   ├── builder/               # megane Builder (structure editor)
│   ├── renderer/              # Three.js rendering
│   ├── protocol/              # Binary protocol decoder
│   └── parsers/               # File parsers (WASM)
└── tests/                     # Test suites
```

## Rendering

megane uses **billboard impostor rendering** for atoms and bonds at every atom
count — atoms are screen-aligned quads with ray-sphere intersection in the
fragment shader (`src/renderer/ImpostorAtomMesh.ts`), and bonds use the same
technique with cylinder intersection (`src/renderer/ImpostorBondMesh.ts`). See
[Visual Pipeline Architecture](./dev/architecture#impostor-technique) for the
shader details and per-atom buffer layout.

## Binary Protocol

The `megane serve` WebSocket server and the Jupyter widget use an efficient binary protocol (`python/megane/protocol.py`, decoded by `src/protocol/protocol.ts`):

```
Header (8 bytes):
  magic:    4 bytes "MEGN"
  msg_type: u8 (0=snapshot, 1=frame, 2=metadata, 3=trajectory)
  flags:    u8 (bit 0: HAS_BOND_ORDERS, bit 1: HAS_BOX, bit 2: HAS_FRAME_ELEMENTS,
                bit 3: HAS_BOX_ORIGIN, bit 4: HAS_SYMMETRY_OPS)
  reserved: 2 bytes
```

Message types:

- **Snapshot** — Full structure: positions, elements, bonds, bond orders, unit cell (and its origin), CIF symmetry operations
- **Frame** — Updated positions for trajectory playback, plus per-frame elements and unit cell for heterogeneous trajectories
- **Metadata** — Frame count, timestep, atom count, file names
- **Trajectory** — Every frame of a trajectory in one message (an offset table followed by complete frame messages), so the Jupyter widget can play back without a kernel (`embed_trajectory=True`)
