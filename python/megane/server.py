"""FastAPI WebSocket server for megane molecular viewer."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import tempfile
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import FastAPI, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from megane.parsers.common import Structure, encode_trajectory_frame
from megane.parsers.dispatch import load_structure_file, structure_ext
from megane.parsers.pdb import load_pdb
from megane.protocol import encode_metadata, encode_snapshot

if TYPE_CHECKING:
    from megane.parsers.common import InMemoryTrajectory

__all__ = ["app", "configure", "configure_files"]

logger = logging.getLogger(__name__)

app = FastAPI(title="Megane")

# Track connected WebSocket clients for broadcasting
_clients: set[WebSocket] = set()
_clients_lock = asyncio.Lock()


@dataclass
class ServerState:
    """Typed state for the currently loaded structure."""

    structure: Optional[Structure] = None
    snapshot_bytes: bytes = b""
    structure_path: str = ""
    xtc_path: Optional[str] = None
    trajectory: Optional[InMemoryTrajectory] = None


_state = ServerState()


@dataclass
class FilesConfig:
    """Where the browser's "Open from server..." dialog may read files."""

    root: Optional[Path] = None
    any_host: bool = False


_files = FilesConfig()


def configure_files(root: str | os.PathLike[str] | None, any_host: bool = False) -> None:
    """Let the web UI browse and open files under ``root`` (``None`` turns it off).

    Only loopback clients are served unless ``any_host`` is set: ``megane serve``
    listens on every interface, and an SSH tunnel or a browser on the same
    machine both arrive from loopback.
    """
    _files.root = Path(root).resolve() if root is not None else None
    _files.any_host = any_host


def configure(
    structure_path: str = "",
    xtc_path: str | None = None,
    traj_path: str | None = None,
    *,
    pdb_path: str | None = None,
) -> None:
    """Configure the server with a molecular structure to serve.

    Args:
        structure_path: Any structure file the viewer opens (PDB, GRO, XYZ,
            CIF, MOL2, ...; see ``megane.parsers.dispatch``). An ASE ``.traj``
            is loaded with all its frames, as ``traj_path`` is.
        xtc_path: Optional XTC trajectory whose topology is ``structure_path``.
        traj_path: ASE ``.traj`` file holding both topology and frames;
            ``structure_path`` is ignored when it is given.
        pdb_path: Deprecated alias of ``structure_path``.

    Raises:
        ValueError: ``structure_path`` has an unsupported extension.
    """
    if pdb_path is not None:
        warnings.warn(
            "configure(pdb_path=...) is deprecated; pass structure_path instead",
            DeprecationWarning,
            stacklevel=2,
        )
        if structure_path:
            raise TypeError("configure() got both structure_path and pdb_path")
        structure_path = pdb_path

    if traj_path is None and structure_path and structure_ext(structure_path) == ".traj":
        traj_path = structure_path

    # Read everything before touching _state, so a file that fails to load
    # (an unsupported upload, an atom-count mismatch) leaves the current
    # structure and trajectory in place.
    if traj_path is not None:
        from megane.parsers.traj import load_traj

        structure, traj = load_traj(traj_path)
        _set_state(structure, traj_path, None, traj)
        logger.info(
            "Loaded .traj: %d frames, %d atoms, %d bonds",
            traj.n_frames,
            traj.n_atoms,
            len(structure.bonds),
        )
        return

    # Extension-less files keep the historic PDB reading.
    if structure_ext(structure_path) == "":
        structure = load_pdb(structure_path)
    else:
        structure = load_structure_file(structure_path)

    traj = None
    if xtc_path:
        from megane.parsers.xtc import load_trajectory

        traj = load_trajectory(structure_path, xtc_path)
        logger.info(
            "Loaded trajectory: %d frames, %d atoms",
            traj.n_frames,
            traj.n_atoms,
        )

    _set_state(structure, structure_path, xtc_path, traj)
    logger.info(
        "Loaded %s: %d atoms, %d bonds",
        structure_path,
        structure.n_atoms,
        len(structure.bonds),
    )


def _set_state(
    structure: Structure,
    structure_path: str,
    xtc_path: str | None,
    trajectory: InMemoryTrajectory | None,
) -> None:
    _state.structure = structure
    _state.snapshot_bytes = encode_snapshot(structure)
    _state.structure_path = structure_path
    _state.xtc_path = xtc_path
    _state.trajectory = trajectory


def _build_metadata_bytes() -> bytes:
    """Build metadata message bytes including file names."""
    traj = _state.trajectory
    pdb_name = Path(_state.structure_path).name if _state.structure_path else ""
    xtc_name = Path(_state.xtc_path).name if _state.xtc_path else ""
    return encode_metadata(
        n_frames=traj.n_frames if traj else 0,
        timestep_ps=traj.timestep_ps if traj else 0.0,
        n_atoms=traj.n_atoms if traj else (_state.structure.n_atoms if _state.structure else 0),
        pdb_name=pdb_name,
        xtc_name=xtc_name,
    )


async def _broadcast_snapshot() -> None:
    """Send snapshot and metadata to all connected clients."""
    meta_bytes = _build_metadata_bytes()
    async with _clients_lock:
        clients_snapshot = list(_clients)
    for ws in clients_snapshot:
        try:
            await ws.send_bytes(_state.snapshot_bytes)
            await ws.send_bytes(meta_bytes)
        except (WebSocketDisconnect, RuntimeError):
            async with _clients_lock:
                _clients.discard(ws)


@app.get("/health")
async def health() -> dict:
    """Health check endpoint for load balancers and container orchestrators."""
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_file(
    pdb: UploadFile,
    xtc: UploadFile | None = None,
) -> dict:
    """Upload a structure file (and optional XTC) to load in the viewer.

    The ``pdb`` form field takes any structure format; the uploaded file name's
    extension picks the reader. An unsupported extension is a 400.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        structure_path = Path(tmpdir) / Path(pdb.filename or "upload.pdb").name
        structure_path.write_bytes(await pdb.read())

        # Save XTC if provided
        xtc_path = None
        if xtc is not None:
            xtc_path_obj = Path(tmpdir) / Path(xtc.filename or "upload.xtc").name
            xtc_path_obj.write_bytes(await xtc.read())
            xtc_path = str(xtc_path_obj)

        try:
            configure(str(structure_path), xtc_path)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from None

    # Broadcast to all connected clients
    await _broadcast_snapshot()

    return {
        "nAtoms": _state.structure.n_atoms,
        "nBonds": len(_state.structure.bonds),
    }


def _is_loopback(host: str | None) -> bool:
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _files_refusal(request: Request) -> HTTPException | None:
    """Why file browsing is unavailable to this request, or ``None`` when it is served."""
    if _files.root is None:
        return HTTPException(status_code=404, detail="File browsing is disabled on this server")
    client = request.client.host if request.client else None
    if not _files.any_host and not _is_loopback(client):
        return HTTPException(
            status_code=403,
            detail="File browsing is only served to this machine "
            "(restart megane serve with --files-any-host to allow other hosts)",
        )
    return None


def _files_root(request: Request) -> Path:
    """The browse root, or the HTTP error explaining why browsing is unavailable."""
    refusal = _files_refusal(request)
    if refusal is not None:
        raise refusal
    assert _files.root is not None
    return _files.root


def _resolve_under(root: Path, rel: str) -> Path:
    """``rel`` resolved under ``root``; symlinks and ``..`` may not leave it."""
    try:
        target = (root / rel.lstrip("/")).resolve()
    except (OSError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path") from None
    if target != root and not target.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Path is outside the served folder")
    return target


def _rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix() if path != root else ""


# Plain `def` (not async): FastAPI runs these in its threadpool, so a slow
# filesystem (a network mount on a cluster) does not stall the WebSocket.
@app.get("/api/files")
def list_files(request: Request, path: str = "") -> dict:
    """List a folder under the files root for the web UI's file dialog.

    Hidden entries (dot files) and entries whose real location is outside the
    root are left out. Folders come first, then files, each sorted by name.
    """
    root = _files_root(request)
    target = _resolve_under(root, path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail=f"Not a folder: {path}")
    entries = []
    for child in target.iterdir():
        if child.name.startswith("."):
            continue
        try:
            real = child.resolve()
            if real != root and not real.is_relative_to(root):
                continue
            is_dir = real.is_dir()
            size = None if is_dir else real.stat().st_size
        except OSError:
            continue
        entries.append(
            {
                "name": child.name,
                "path": _rel(root, target / child.name),
                "isDir": is_dir,
                "size": size,
            }
        )
    entries.sort(key=lambda e: (not e["isDir"], e["name"].lower()))
    rel = _rel(root, target)
    parent = None if target == root else _rel(root, target.parent)
    return {"path": rel, "parent": parent, "entries": entries}


@app.get("/api/files/content")
def read_file(request: Request, path: str) -> FileResponse:
    """Send one file under the files root."""
    root = _files_root(request)
    target = _resolve_under(root, path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail=f"Not a file: {path}")
    return FileResponse(target, filename=target.name)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """WebSocket endpoint for streaming molecular data."""
    await websocket.accept()
    async with _clients_lock:
        _clients.add(websocket)
    try:
        # Send snapshot and metadata immediately on connection
        if _state.structure is not None:
            await websocket.send_bytes(_state.snapshot_bytes)
            await websocket.send_bytes(_build_metadata_bytes())

        # Handle client commands
        stream_task: asyncio.Task | None = None

        async def _run_stream(traj, start: int, end: int, stride: int, fps: int) -> None:
            """Stream frames at the given FPS. Runs as a cancellable task."""
            delay = 1.0 / max(fps, 1)
            for i in range(start, end, max(stride, 1)):
                await websocket.send_bytes(encode_trajectory_frame(traj, i))
                await asyncio.sleep(delay)

        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                logger.warning("Ignoring malformed JSON from client")
                continue
            cmd = msg.get("type")
            traj = _state.trajectory

            if cmd == "request_frame" and traj is not None:
                frame_idx = msg.get("frame")
                if isinstance(frame_idx, int) and 0 <= frame_idx < traj.n_frames:
                    await websocket.send_bytes(encode_trajectory_frame(traj, frame_idx))

            elif cmd == "stream" and traj is not None:
                # Cancel any existing stream
                if stream_task and not stream_task.done():
                    stream_task.cancel()
                try:
                    start = max(int(msg.get("start", 0)), 0)
                    end = min(int(msg.get("end", traj.n_frames)), traj.n_frames)
                    stride = max(int(msg.get("stride", 1)), 1)
                    fps = max(int(msg.get("fps", 30)), 1)
                except (TypeError, ValueError):
                    logger.warning("Ignoring stream command with invalid parameters")
                    continue
                stream_task = asyncio.create_task(_run_stream(traj, start, end, stride, fps))

            elif cmd == "stop":
                if stream_task and not stream_task.done():
                    stream_task.cancel()

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    finally:
        async with _clients_lock:
            _clients.discard(websocket)


# Resolve static files directory: override via MEGANE_STATIC_DIR env var.
# Empty or whitespace values are treated as unset to avoid accidentally
# exposing the current working directory via StaticFiles.
_default_static_dir = Path(__file__).parent / "static" / "app"
_env_static_dir = os.environ.get("MEGANE_STATIC_DIR", "").strip()
_static_dir = Path(_env_static_dir).resolve() if _env_static_dir else _default_static_dir

# Marks the viewer page when this browser may browse the server's files, so the
# web app requests `/api/files` only then (src/remote/serverFiles.ts). Static
# hosts, `--no-files` and refused clients get the page unmarked and never send
# a request the browser would log as a 404 or 403.
SERVER_FILES_META = '<meta name="megane-server-files" content="" />'


def _no_ui_page() -> HTMLResponse:
    return HTMLResponse(
        "<h1>Megane</h1>"
        "<p>The web UI is not available.</p>"
        "<p>Build the frontend first:</p>"
        "<pre>npm run build</pre>"
        "<p>Then restart <code>megane serve</code>.</p>",
        status_code=200,
    )


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def _index(request: Request) -> HTMLResponse:
    index = _static_dir / "index.html"
    if not index.is_file():
        return _no_ui_page()
    html = index.read_text(encoding="utf-8")
    if _files_refusal(request) is None:
        html = html.replace("</head>", f"{SERVER_FILES_META}\n</head>", 1)
    # The mark depends on the server's options and on the client, so a copy
    # cached from another run or another client must not be reused.
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


if _static_dir.exists():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="app")
else:
    logger.warning(
        "Static app directory not found at %s. "
        "The web UI will not be available. "
        "Build the frontend with 'npm run build' first.",
        _static_dir,
    )

    @app.get("/{path:path}")
    async def _fallback(path: str):
        return _no_ui_page()
