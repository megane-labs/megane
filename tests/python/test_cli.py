"""Tests for CLI argument parsing and main() function."""

from __future__ import annotations

import argparse
import logging
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_hosts(monkeypatch):
    monkeypatch.delenv("MEGANE_HOST", raising=False)
    yield
    from megane.server import configure_hosts

    configure_hosts(None)


# ---------------------------------------------------------------------------
# Original argparse-only tests
# ---------------------------------------------------------------------------


def test_serve_command_basic():
    """Parse basic 'serve' command with PDB file."""
    from megane.cli import main

    parser = argparse.ArgumentParser(prog="megane")
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("pdb", nargs="?", default=None)
    parser.add_argument("--xtc")
    parser.add_argument("--traj")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--dev", action="store_true")

    args = parser.parse_args(["serve", "test.pdb"])
    assert args.command == "serve"
    assert args.pdb == "test.pdb"
    assert args.port == 8765
    assert args.no_browser is False
    assert args.dev is False


def test_serve_with_port():
    """Parse 'serve' with custom port."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("pdb", nargs="?", default=None)
    parser.add_argument("--port", type=int, default=8765)

    args = parser.parse_args(["serve", "--port", "9000"])
    assert args.port == 9000


def test_serve_with_xtc():
    """Parse 'serve' with XTC trajectory."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("pdb", nargs="?", default=None)
    parser.add_argument("--xtc")

    args = parser.parse_args(["serve", "protein.pdb", "--xtc", "traj.xtc"])
    assert args.pdb == "protein.pdb"
    assert args.xtc == "traj.xtc"


def test_serve_with_traj():
    """Parse 'serve' with ASE .traj file."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("pdb", nargs="?", default=None)
    parser.add_argument("--traj")

    args = parser.parse_args(["serve", "--traj", "sim.traj"])
    assert args.pdb is None
    assert args.traj == "sim.traj"


def test_serve_no_browser_flag():
    """Parse --no-browser flag."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("pdb", nargs="?", default=None)
    parser.add_argument("--no-browser", action="store_true")

    args = parser.parse_args(["serve", "--no-browser"])
    assert args.no_browser is True


def test_serve_dev_flag():
    """Parse --dev flag."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])
    parser.add_argument("pdb", nargs="?", default=None)
    parser.add_argument("--dev", action="store_true")

    args = parser.parse_args(["serve", "--dev"])
    assert args.dev is True


def test_invalid_command():
    """Invalid command raises SystemExit."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])

    with pytest.raises(SystemExit):
        parser.parse_args(["invalid"])


def test_missing_command():
    """Missing command raises SystemExit."""
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["serve"])

    with pytest.raises(SystemExit):
        parser.parse_args([])


# ---------------------------------------------------------------------------
# Tests that exercise the actual main() function
# ---------------------------------------------------------------------------


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure")
def test_main_serve_with_pdb(mock_configure, mock_webbrowser, mock_uvicorn_run):
    """main() with 'serve <pdb>' calls configure and uvicorn.run."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "test.pdb"]):
        main()

    mock_configure.assert_called_once_with("test.pdb", None)
    mock_uvicorn_run.assert_called_once()
    call_kwargs = mock_uvicorn_run.call_args
    assert call_kwargs[1]["port"] == 8765


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure")
def test_main_serve_no_browser(mock_configure, mock_webbrowser, mock_uvicorn_run):
    """main() with --no-browser skips webbrowser.open."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "test.pdb", "--no-browser"]):
        main()

    mock_webbrowser.open.assert_not_called()
    mock_uvicorn_run.assert_called_once()


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure")
def test_main_serve_dev_flag(mock_configure, mock_webbrowser, mock_uvicorn_run, caplog):
    """main() with --dev logs dev message and skips browser open."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "test.pdb", "--dev"]):
        with caplog.at_level(logging.INFO):
            main()

    # --dev implies no browser
    mock_webbrowser.open.assert_not_called()
    assert any("Dev mode" in r.message for r in caplog.records)


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure")
def test_main_serve_traj(mock_configure, mock_webbrowser, mock_uvicorn_run):
    """main() with --traj passes traj_path to configure."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--traj", "sim.traj"]):
        main()

    mock_configure.assert_called_once_with("", traj_path="sim.traj")


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure")
def test_main_serve_no_pdb(mock_configure, mock_webbrowser, mock_uvicorn_run, caplog):
    """main() with no PDB file logs waiting-for-upload message."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--no-browser"]):
        with caplog.at_level(logging.INFO):
            main()

    mock_configure.assert_not_called()
    assert any("Waiting for file upload" in r.message for r in caplog.records)


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure")
def test_main_serve_non_pdb_structure_with_xtc(mock_configure, mock_webbrowser, mock_uvicorn_run):
    """main() passes any structure file (not only PDB) and its XTC to configure."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "conf.gro", "--xtc", "traj.xtc", "--no-browser"]):
        main()

    mock_configure.assert_called_once_with("conf.gro", "traj.xtc")


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
def test_main_serve_loads_gro_into_server_state(mock_webbrowser, mock_uvicorn_run):
    """`megane serve x.gro` reads the file with the GRO parser."""
    from pathlib import Path

    from megane.cli import main
    from megane.server import _state

    gro = str(Path(__file__).parent.parent / "fixtures" / "high_precision.gro")
    with patch("sys.argv", ["megane", "serve", gro, "--no-browser", "--no-files"]):
        main()

    assert _state.structure.n_atoms == 11
    assert _state.structure_path == gro
    mock_uvicorn_run.assert_called_once()


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
def test_main_serve_unsupported_extension_is_usage_error(mock_webbrowser, mock_uvicorn_run, tmp_path, capsys):
    """An unreadable extension exits with a usage error instead of a traceback."""
    from megane.cli import main

    bad = tmp_path / "notes.txt"
    bad.write_text("hello")
    with patch("sys.argv", ["megane", "serve", str(bad), "--no-browser"]):
        with pytest.raises(SystemExit) as exc:
            main()

    assert exc.value.code == 2
    assert "Unsupported structure format" in capsys.readouterr().err
    mock_uvicorn_run.assert_not_called()


def test_main_help_names_structure_formats(capsys):
    """--help describes the positional as a structure file, not a PDB."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--help"]):
        with pytest.raises(SystemExit) as exc:
            main()

    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "STRUCTURE_FILE" in out
    assert "GRO" in out


def test_main_no_args():
    """main() with no arguments raises SystemExit."""
    from megane.cli import main

    with patch("sys.argv", ["megane"]):
        with pytest.raises(SystemExit):
            main()


# ---------------------------------------------------------------------------
# Server file browsing ("Open from server..." in the Load nodes)
# ---------------------------------------------------------------------------


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure_files")
def test_main_serve_files_default_to_cwd(mock_files, mock_webbrowser, mock_uvicorn_run):
    """By default the web UI browses the current directory, loopback only."""
    import os

    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--no-browser"]):
        main()

    mock_files.assert_called_once_with(os.getcwd(), any_host=False)


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure_files")
def test_main_serve_files_root_and_any_host(mock_files, mock_webbrowser, mock_uvicorn_run):
    """--files-root picks the folder; --files-any-host lifts the loopback limit."""
    from megane.cli import main

    argv = ["megane", "serve", "--no-browser", "--files-root", "/data", "--files-any-host"]
    with patch("sys.argv", argv):
        main()

    mock_files.assert_called_once_with("/data", any_host=True)


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
@patch("megane.server.configure_files")
def test_main_serve_no_files(mock_files, mock_webbrowser, mock_uvicorn_run):
    """--no-files turns file browsing off."""
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--no-browser", "--no-files"]):
        main()

    mock_files.assert_called_once_with(None)


# ---------------------------------------------------------------------------
# Listening address (--host, $MEGANE_HOST) and accepted Host names
# ---------------------------------------------------------------------------


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
def test_main_serve_listens_on_loopback_by_default(mock_webbrowser, mock_uvicorn_run):
    """Other machines (and other sites through them) cannot reach a default server."""
    from megane import server
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--no-browser", "--no-files"]):
        main()

    assert mock_uvicorn_run.call_args[1]["host"] == "127.0.0.1"
    assert server._hosts.bind_host == "127.0.0.1"
    assert server._hosts.allowed == frozenset()


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
def test_main_serve_host_and_allowed_hosts(mock_webbrowser, mock_uvicorn_run):
    from megane import server
    from megane.cli import main

    argv = ["megane", "serve", "--no-browser", "--no-files", "--host", "0.0.0.0"]
    argv += ["--allowed-host", "node42", "--allowed-host", "viewer.example.org"]
    with patch("sys.argv", argv):
        main()

    assert mock_uvicorn_run.call_args[1]["host"] == "0.0.0.0"
    assert server._hosts.allowed == frozenset({"node42", "viewer.example.org"})


@patch("uvicorn.run")
@patch("megane.cli.webbrowser")
def test_main_serve_host_from_environment(mock_webbrowser, mock_uvicorn_run, monkeypatch):
    """The Docker image sets MEGANE_HOST=0.0.0.0; --host still wins."""
    from megane.cli import main

    monkeypatch.setenv("MEGANE_HOST", " 0.0.0.0 ")
    with patch("sys.argv", ["megane", "serve", "--no-browser", "--no-files"]):
        main()
    assert mock_uvicorn_run.call_args[1]["host"] == "0.0.0.0"

    with patch("sys.argv", ["megane", "serve", "--no-browser", "--no-files", "--host", "127.0.0.1"]):
        main()
    assert mock_uvicorn_run.call_args[1]["host"] == "127.0.0.1"


@patch("uvicorn.run")
@patch("megane.cli.Timer")
def test_main_serve_opens_the_bound_address(mock_timer, mock_uvicorn_run):
    from megane.cli import main

    with patch("sys.argv", ["megane", "serve", "--no-files", "--host", "192.168.1.5"]):
        with patch("megane.cli.webbrowser") as mock_webbrowser:
            main()
            mock_timer.call_args[0][1]()
    mock_webbrowser.open.assert_called_once_with("http://192.168.1.5:8765")


@pytest.mark.parametrize(
    ("host", "url"),
    [
        ("127.0.0.1", "http://localhost:8765"),
        ("0.0.0.0", "http://localhost:8765"),
        ("::", "http://localhost:8765"),
        ("[::1]", "http://localhost:8765"),
        ("localhost", "http://localhost:8765"),
        ("192.168.1.5", "http://192.168.1.5:8765"),
        ("fe80::1", "http://[fe80::1]:8765"),
        ("node42", "http://node42:8765"),
    ],
)
def test_browser_url(host, url):
    from megane.cli import _browser_url

    assert _browser_url(host, 8765) == url
