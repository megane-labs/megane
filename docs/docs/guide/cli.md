# Standalone web app (`megane serve`)

The **standalone web app** is megane's full-featured viewer. You launch it with the `megane serve` command, which starts a local server and opens the viewer in your browser. `megane serve` is the CLI launcher; the FastAPI + WebSocket process it starts is referred to as the `megane serve` backend. The same server also hosts [megane Builder](builder.md), the structure editor, at `/builder.html`.

:::note
The viewer page currently starts in its in-browser data mode: it opens with the bundled demo (caffeine in water) and parses every file you drop or pick in the browser with WASM. It does not connect to the backend's `/ws` endpoint, so a file passed on the command line is loaded by the backend but is not what the page shows — open it from the browser instead.
:::

## Quick Start with Docker

```bash
docker build -t megane .
docker run --rm -p 8080:8080 megane
```

Open http://localhost:8080 in your browser. The image's default command serves the bundled `caffeine_water.pdb` + `caffeine_water_vibration.xtc` demo.

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
| `PDB_FILE` | Path to a PDB file (optional). The backend only reads `.pdb` from this positional argument — to start with an ASE trajectory, use `--traj` instead. In the browser, drag-and-drop and the file dialogs accept every supported structure format (PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, LAMMPS data, AMBER prmtop, ASE `.traj`, VASP, …); see [Platform Support](/platform-support). |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--xtc PATH` | — | Path to an XTC trajectory file (paired with `PDB_FILE` for topology) |
| `--traj PATH` | — | Path to an ASE `.traj` file. Loads both topology and frames from the trajectory; do not pass `PDB_FILE` when using this. |
| `--port PORT` | `8765` | Server port. The server listens on all interfaces (`0.0.0.0`). |
| `--no-browser` | `false` | Don't automatically open the browser |
| `--files-root DIR` | current directory | Folder the Load nodes' *Open from server…* dialog browses |
| `--no-files` | `false` | Turn *Open from server…* off |
| `--files-any-host` | `false` | Serve *Open from server…* to every client, not only ones on this machine (an SSH tunnel counts as this machine) |
| `--dev` | `false` | Development mode (use the Vite dev server for the frontend). Implies not opening the browser. |

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

Starts the backend with `protein.pdb` loaded and opens `http://localhost:8765` in your browser (see the note at the top of this page about what the page shows).

### View with trajectory

```bash
# PDB topology + XTC frames
megane serve protein.pdb --xtc trajectory.xtc

# ASE .traj (topology + frames in one file)
megane serve --traj simulation.traj
```

To play a trajectory in the viewer, open the structure and then the trajectory in the browser (for example through the **Load Structure** and **Load Trajectory** nodes); the viewer shows trajectory controls (timeline, play/pause, FPS) for frame-by-frame playback.

### Upload from browser

```bash
megane serve
```

Start the server without a file. You can then drag-and-drop or open any supported structure file from the browser UI; it is parsed in the browser.

### Custom port

```bash
megane serve protein.pdb --port 3000
```

### Development mode

```bash
megane serve protein.pdb --dev
```

In development mode, `megane serve` does not open a browser; start the Vite dev server yourself with `npm run dev` (port 5173, hot module replacement) and open `http://localhost:5173`. The Vite dev server proxies `/ws` and `/api` to `localhost:8765`, so keep the default `--port` when pairing it with the backend.

## Architecture

`megane serve` starts the backend — a [FastAPI](https://fastapi.tiangolo.com/) server with:

- **Static file serving** — The built frontend from `megane/static/app/` (the viewer at `/`, megane Builder at `/builder.html`). Set the `MEGANE_STATIC_DIR` environment variable to serve a different build directory.
- **WebSocket endpoint** (`/ws`) — Binary protocol streaming for molecular data. On connect it sends the loaded snapshot and metadata; clients can then send `request_frame`, `stream` (`start`, `end`, `stride`, `fps`), and `stop` JSON commands.
- **Upload endpoint** (`POST /api/upload`) — Accepts a `pdb` file (plus an optional `xtc`) as multipart form data, loads it, and broadcasts it to every connected WebSocket client.
- **Health check** (`GET /health`) — Returns `{"status": "ok"}`, for load balancers and container orchestrators.

Data is encoded using megane's binary protocol for efficient transfer:

| Message Type | Content |
|-------------|---------|
| Snapshot | Atom positions, elements, bonds, bond orders, unit cell |
| Frame | Updated positions for a trajectory frame |
| Metadata | Frame count, timestep, atom count, file names |
