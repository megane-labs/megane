# Standalone web app (`megane serve`)

The **standalone web app** is Megane's full-featured viewer. You launch it with the `megane serve` command, which starts a local server and opens the viewer in your browser. `megane serve` is the CLI launcher; the FastAPI + WebSocket process it starts is referred to as the `megane serve` backend. The same server also hosts [Megane Builder](builder.md), the structure editor, at `/builder.html`.

:::note
The viewer page currently starts in its in-browser data mode: it opens with the bundled demo (caffeine in water) and parses every file you drop or pick in the browser with WASM. It does not connect to the backend's `/ws` endpoint, so a file passed on the command line is loaded by the backend but is not what the page shows — open it from the browser instead.
:::

## Quick Start with Docker

```bash
docker build -t megane .
docker run --rm -p 8080:8080 megane
```

Open http://localhost:8080 in your browser. The image's default command serves the bundled `caffeine_water.pdb` + `caffeine_water_vibration.xtc` demo.

To view your own files, mount them into the container and let the Load nodes browse them:

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v ./mydata:/data megane \
  megane serve --files-root /data --files-any-host --port 8080 --no-browser
```

Then open a file from the Load Structure node's *Open from server…*. The page does not load a file named on the `megane serve` command line, so browse to it instead. Docker's port mapping makes your browser a non-local client of the container, which is why `--files-any-host` is needed; publishing the port on `127.0.0.1` keeps it reachable from your machine only. The image sets `MEGANE_HOST=0.0.0.0`, so the server listens on the container's own interfaces without a `--host` option.

## Running from Source

### Prerequisites

- Python 3.10+
- Node.js 22+
- Rust
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [uv](https://docs.astral.sh/uv/)
- [maturin](https://www.maturin.rs/) (`uv tool install maturin` or `pip install maturin`; `uv sync` does not install it)

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
uv run megane serve protein.pdb
```

## Usage

```bash
megane serve [STRUCTURE_FILE] [OPTIONS]
```

`serve` is currently the only subcommand.

## Arguments

| Argument | Description |
|----------|-------------|
| `STRUCTURE_FILE` | Path to a structure file (optional). Every structure format the viewer opens is accepted — PDB, GRO, XYZ, MOL/SDF, MOL2, CIF, mmCIF, LAMMPS data, AMBER prmtop, VASP (including bare `POSCAR` / `CONTCAR`), …; the extension picks the parser, exactly as for the Python `LoadStructure` node and the Jupyter widget (see [Platform Support](/platform-support)). An ASE `.traj` here loads all of its frames, the same as `--traj`. A file with no extension is read as PDB. An unsupported extension exits with a usage error. |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--xtc PATH` | — | Path to an XTC trajectory file (paired with `STRUCTURE_FILE`, in any structure format, for topology; the atom counts must match) |
| `--traj PATH` | — | Path to an ASE `.traj` file. Loads both topology and frames from the trajectory; do not pass `STRUCTURE_FILE` when using this. |
| `--port PORT` | `8765` | Server port |
| `--host ADDRESS` | `$MEGANE_HOST`, else `127.0.0.1` | Address the server listens on. The default answers this machine only (a browser here, or an SSH tunnel); `0.0.0.0` listens on every interface, for other machines on the network or inside a container. |
| `--allowed-host NAME` | — | Another name browsers reach the server by — a reverse proxy's public name, or this machine's network name under `--host 0.0.0.0`. `localhost`, IP addresses and the `--host` value are always accepted. Repeatable. See [Security](#security). |
| `--no-browser` | `false` | Don't automatically open the browser |
| `--files-root DIR` | current directory | Folder the Load nodes' *Open from server…* dialog browses |
| `--no-files` | `false` | Turn *Open from server…* off |
| `--files-any-host` | `false` | Serve *Open from server…* to every client, not only ones on this machine (an SSH tunnel counts as this machine). Other machines can connect only when `--host` lets them. |
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
started in) are reachable; hidden files and folders (names starting with `.`,
such as `~/.ssh`) and symlinks that point outside the root or into a hidden
folder are neither listed nor sent. `megane serve` listens on `127.0.0.1`, so
only this machine reaches it — a browser there, or an SSH tunnel like the one
above. To let other machines on the network open the viewer and browse too,
listen on every interface and lift the file-browsing limit:

```bash
megane serve --host 0.0.0.0 --files-any-host
```

Pass `--no-files` to turn file browsing off. Everyone who can log in to the
machine can also reach a server on `127.0.0.1`, so on a shared login node set
`--files-root` to the folder you want to show (not your home directory) or pass
`--no-files`.

## Security

`megane serve` has no login, so it decides who to answer from where a request
comes from:

- **Listening address.** By default it listens on `127.0.0.1` only. `--host`
  (or the `MEGANE_HOST` environment variable, which the Docker image sets to
  `0.0.0.0`) changes that.
- **Host names.** The file, upload and WebSocket endpoints answer only requests
  whose `Host` header names this server: `localhost` (and `*.localhost`), an IP
  address, the `--host` value, or a name passed to `--allowed-host`. A web page
  whose DNS name was pointed at your machine (DNS rebinding) sends its own name
  and is refused with a `403`. If you open the viewer by a network name under
  `--host 0.0.0.0` — `http://node42:8765` — pass `--allowed-host node42`.
- **Other sites' pages.** Any website can post a form to, or open a WebSocket
  on, `localhost`. The upload endpoint and `/ws` refuse a request whose
  `Origin` is not the page's own server (or a name passed to `--allowed-host`).
- **This machine.** *Open from server…* is served without `--files-any-host`
  only to a loopback client that reached a loopback name. A reverse proxy on
  the same machine arrives from loopback too, but under its public name, so its
  clients are treated as other machines.

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

# GROMACS .gro topology + XTC frames
megane serve conf.gro --xtc trajectory.xtc

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

- **Static file serving** — The built frontend from `megane/static/app/` (the viewer at `/`, Megane Builder at `/builder.html`). Set the `MEGANE_STATIC_DIR` environment variable to serve a different build directory.
- **WebSocket endpoint** (`/ws`) — Binary protocol streaming for molecular data. On connect it sends the loaded snapshot and metadata; clients can then send `request_frame`, `stream` (`start`, `end`, `stride`, `fps`), and `stop` JSON commands. A connection from another site's page or under an unknown `Host` is refused (see [Security](#security)).
- **Upload endpoint** (`POST /api/upload`) — Accepts a structure file in the `pdb` form field (any structure format; the uploaded file name's extension picks the parser, and an unsupported one is a `400`) plus an optional `xtc`, as multipart form data, loads it, and broadcasts it to every connected WebSocket client. The uploaded files are kept (the trajectory reads its frames from the XTC) until the next upload replaces them. A post from another site's page or under an unknown `Host` is a `403`.
- **File browsing** (`GET /api/files?path=…`, `GET /api/files/content?path=…`) — Lists the folders and files under `--files-root` and sends one file, for the Load nodes' *Open from server…* dialog. Hidden names are refused (`403`), as are paths that leave the root (`400`). Both answer `404` under `--no-files` and `403` to clients other than the server's own machine unless `--files-any-host` is given, and to an unknown `Host`. The viewer page (`/`) carries `<meta name="megane-server-files">` only when these endpoints would answer the browser loading it, and the web app requests them only then.
- **Health check** (`GET /health`) — Returns `{"status": "ok"}`, for load balancers and container orchestrators.

Data is encoded using Megane's binary protocol for efficient transfer:

| Message Type | Content |
|-------------|---------|
| Snapshot | Atom positions, elements, bonds, bond orders, unit cell |
| Frame | Updated positions for a trajectory frame |
| Metadata | Frame count, timestep, atom count, file names |
