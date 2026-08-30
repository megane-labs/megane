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
| `npm run build` | Build frontend (WASM + Vite) |
| `npm run test` | Run TypeScript tests |
| `npm run build:wasm` | Build WASM module only |

## Project Structure

```
megane/
├── crates/                    # Rust workspace
│   ├── megane-core/           # Core parsers (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, LAMMPS data, AMBER topology (.prmtop), GROMACS topology (.top), PSF topology (.psf), XTC, DCD, AMBER NetCDF (.nc), ASE .traj, .lammpstrj/.dump)
│   ├── megane-python/         # PyO3 bindings
│   └── megane-wasm/           # WASM bindings
├── python/megane/             # Python package
│   ├── widget.py              # Jupyter widget (anywidget)
│   ├── pipeline.py            # Pipeline builder (NetworkX-style DAG)
│   ├── server.py              # FastAPI WebSocket server
│   ├── cli.py                 # CLI entry point
│   ├── protocol.py            # Binary protocol encoder
│   └── parsers/               # Parser wrappers
├── src/                       # TypeScript frontend
│   ├── components/            # React components
│   ├── renderer/              # Three.js rendering
│   ├── protocol/              # Binary protocol decoder
│   └── parsers/               # File parsers (WASM)
└── tests/                     # Test suites
```

## Rendering

megane uses **billboard impostor rendering** for atoms and bonds at every atom
count — atoms are screen-aligned quads with ray-sphere intersection in the
fragment shader (`src/renderer/ImpostorAtomMesh.ts`), and bonds use the same
technique with cylinder intersection. A legacy `InstancedMesh`-based renderer
also exists in `src/renderer/AtomMesh.ts` as a reference implementation behind
the `AtomRenderer` interface, but `MoleculeRenderer` always instantiates the
impostor renderer for consistent behavior. See
[Visual Pipeline Architecture](./dev/architecture#impostor-technique) for the
shader details and per-atom buffer layout.

## Binary Protocol

The WebSocket server uses an efficient binary protocol:

```
Header (8 bytes):
  magic:    4 bytes "MEGN"
  msg_type: u8 (0=snapshot, 1=frame, 2=metadata)
  flags:    u8 (bit 0: HAS_BOND_ORDERS, bit 1: HAS_BOX)
  reserved: 2 bytes
```

Message types:

- **Snapshot** — Full structure: positions, elements, bonds, bond orders, unit cell
- **Frame** — Updated positions for trajectory playback
- **Metadata** — Frame count, timestep, file names
