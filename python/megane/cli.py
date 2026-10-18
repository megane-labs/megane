"""CLI entry point for megane molecular viewer."""

from __future__ import annotations

import argparse
import logging
import os
import webbrowser
from threading import Timer


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="megane",
        description="megane - A fast, beautiful molecular viewer",
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
        help="Serve file browsing to every client, not only this machine (an SSH tunnel counts as this machine)",
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Development mode (use Vite dev server)",
    )

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "serve":
        from megane.server import app, configure, configure_files

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
            url = f"http://localhost:{args.port}"
            Timer(1.5, lambda: webbrowser.open(url)).start()

        if args.dev:
            logging.info(
                "Dev mode: connect Vite dev server to ws://localhost:%d/ws",
                args.port,
            )

        import uvicorn

        uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
