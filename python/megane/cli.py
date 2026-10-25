"""CLI entry point for megane molecular viewer."""

from __future__ import annotations

import argparse
import ipaddress
import logging
import os
import webbrowser
from threading import Timer

#: Address ``megane serve`` listens on when neither ``--host`` nor ``$MEGANE_HOST`` is given.
DEFAULT_HOST = "127.0.0.1"


def _browser_url(host: str, port: int) -> str:
    """The address to open the viewer at for a server listening on ``host``."""
    try:
        addr = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return f"http://{host}:{port}"
    if addr.is_unspecified or addr.is_loopback:
        return f"http://localhost:{port}"
    return f"http://[{addr}]:{port}" if addr.version == 6 else f"http://{addr}:{port}"


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="megane",
        description="Megane - A fast, beautiful molecular viewer",
    )
    parser.add_argument("command", choices=["serve"], help="Command to run")
    parser.add_argument(
        "structure",
        nargs="?",
        default=None,
        metavar="STRUCTURE_FILE",
        help="Structure file to serve: PDB, GRO, XYZ, CIF, mmCIF, MOL/SDF, MOL2, LAMMPS data, "
        "AMBER prmtop, VASP, ASE .traj, ... (optional; can upload from browser)",
    )
    parser.add_argument("--xtc", help="Path to XTC trajectory file (topology: STRUCTURE_FILE)")
    parser.add_argument("--traj", help="Path to ASE .traj trajectory file")
    parser.add_argument("--port", type=int, default=8765, help="Server port")
    parser.add_argument(
        "--host",
        default=None,
        help=f"Address to listen on (default: $MEGANE_HOST, else {DEFAULT_HOST}: this machine only). "
        "0.0.0.0 listens on every interface, for other machines or inside a container",
    )
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=[],
        metavar="NAME",
        help="Another name browsers reach the server by, e.g. a reverse proxy's or this machine's "
        "network name (localhost, IP addresses and --host are always accepted; repeatable)",
    )
    parser.add_argument("--no-browser", action="store_true", help="Don't open browser")
    parser.add_argument(
        "--files-root",
        default=None,
        help="Folder the web UI's 'Open from server...' dialog browses (default: the current directory)",
    )
    parser.add_argument(
        "--no-files",
        action="store_true",
        help="Don't let the web UI browse or open files on this machine",
    )
    parser.add_argument(
        "--files-any-host",
        action="store_true",
        help="Serve file browsing to every client, not only this machine (an SSH tunnel counts as this "
        "machine); other machines reach the server only with --host 0.0.0.0",
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Development mode (use Vite dev server)",
    )

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "serve":
        from megane.server import app, configure, configure_files, configure_hosts

        host = args.host or os.environ.get("MEGANE_HOST", "").strip() or DEFAULT_HOST
        configure_hosts(host, args.allowed_host)

        try:
            if args.traj:
                configure("", traj_path=args.traj)
            elif args.structure:
                configure(args.structure, args.xtc)
            else:
                logging.info("No structure file specified. Waiting for file upload from browser...")
        except ValueError as e:
            parser.error(str(e))

        if args.no_files:
            configure_files(None)
        else:
            root = args.files_root or os.getcwd()
            configure_files(root, any_host=args.files_any_host)
            logging.info("Load nodes can open files under %s ('Open from server...')", root)

        if not args.no_browser and not args.dev:
            url = _browser_url(host, args.port)
            Timer(1.5, lambda: webbrowser.open(url)).start()

        if args.dev:
            logging.info(
                "Dev mode: connect Vite dev server to ws://localhost:%d/ws",
                args.port,
            )

        import uvicorn

        uvicorn.run(app, host=host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
