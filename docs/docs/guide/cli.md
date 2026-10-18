# Standalone web app (`megane serve`)

The **standalone web app** is megane's full-featured viewer. You launch it with the `megane serve` command, which starts a local server and opens the viewer in your browser. `megane serve` is the CLI launcher; the FastAPI + WebSocket process it starts is referred to as the `megane serve` backend.

## Quick Start with Docker

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

## Running from Source

### Prerequisites

- Python 3.10+
- Node.js 22+
- Rust
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [uv](https://docs.astral.sh/uv/)

### Build and Run

```bash
# Install wasm-pack (if not already installed)
cargo install wasm-pack

# Install dependencies and build frontend
uv sync --extra dev
npm install
npm run build

# Install the package
maturin develop --release

# Start the server
megane serve protein.pdb
```

## Usage

```bash
megane serve [PDB_FILE] [OPTIONS]
```

`serve` is currently the only subcommand.

## Arguments

| Argument | Description |
|----------|-------------|
| `PDB_FILE` | Path to a PDB file (optional; can upload from the browser). `megane serve` only loads `.pdb` from this positional argument — to start with an ASE trajectory, use `--traj` instead. Once the browser is open, drag-and-drop in the standalone web app accepts every supported structure format (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, LAMMPS data, AMBER prmtop, ASE `.traj`, …). |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--xtc PATH` | — | Path to an XTC trajectory file (paired with `PDB_FILE` for topology) |
| `--traj PATH` | — | Path to an ASE `.traj` file. Loads both topology and frames from the trajectory; do not pass `PDB_FILE` when using this. |
| `--port PORT` | `8765` | Server port |
| `--no-browser` | `false` | Don't automatically open the browser |
| `--files-root DIR` | current directory | Folder the Load nodes' *Open from server…* dialog browses |
| `--no-files` | `false` | Turn *Open from server…* off |
| `--files-any-host` | `false` | Serve *Open from server…* to every client, not only ones on this machine (an SSH tunnel counts as this machine) |
| `--dev` | `false` | Development mode (use Vite dev server for frontend) |

## Opening files on a remote machine

When `megane serve` runs on another machine — a workstation or a cluster node
you reach over SSH — the browser's file dialog only shows *your* computer. The
**Load Structure** and **Load Trajectory** nodes then also show **Open from
server…**, which browses the folder the server was started in and loads the
file straight from the server:

```bash
# On the remote machine
cd ~/simulations
megane serve --no-browser --port 8765

# On your computer
ssh -L 8765:localhost:8765 user@remote
# then open http://localhost:8765
```

Only folders under `--files-root` (default: the directory `megane serve` was
started in) are reachable; hidden files and symlinks that point outside it are
left out. Because `megane serve` listens on every network interface, file
browsing is served only to clients on the server's own machine — a browser
there, or an SSH tunnel like the one above. Pass `--files-any-host` to let other
machines on the network browse too, or `--no-files` to turn it off.

## Examples

### View a PDB file

```bash
megane serve protein.pdb
```

Opens `http://localhost:8765` in your browser with the structure loaded.

### View with trajectory

```bash
# PDB topology + XTC frames
megane serve protein.pdb --xtc trajectory.xtc

# ASE .traj (topology + frames in one file)
megane serve --traj simulation.traj
```

The viewer will show trajectory controls (timeline, play/pause, FPS) for frame-by-frame playback.

### Upload from browser

```bash
megane serve
```

Start the server without a file. You can then drag-and-drop or upload a PDB file from the browser UI.

### Custom port

```bash
megane serve protein.pdb --port 3000
```

### Development mode

```bash
megane serve protein.pdb --dev
```

In development mode, the frontend is served by the Vite dev server (typically on port 5173) with hot module replacement. The Python backend provides the WebSocket API at the specified port.

## Architecture

`megane serve` starts the backend — a [FastAPI](https://fastapi.tiangolo.com/) server with:

- **Static file serving** — The built frontend from `megane/static/app/`
- **WebSocket endpoint** (`/ws`) — Binary protocol streaming for molecular data

Data is encoded using megane's binary protocol for efficient transfer:

| Message Type | Content |
|-------------|---------|
| Snapshot | Atom positions, elements, bonds, bond orders, unit cell |
| Frame | Updated positions for a trajectory frame |
| Metadata | Frame count, timestep, file names |
