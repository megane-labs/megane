"""The tool servers a Jupyter server offers megane Builder: the ``mcp_servers`` option.

Entries use the ``mcpServers`` format LLM clients use, as the VS Code
extension's ``megane.builder.mcpServers`` setting does
(``vscode-megane/src/builderTools.ts``); the two read the same entries the
same way::

    {
      "megane-builder-tools": {"command": "megane-builder-tools"},
      "lab": {"url": "https://tools.example.org/mcp", "headers": {"Authorization": "Bearer ..."}}
    }

A stdio entry is a ``command`` with optional ``args``, ``env`` and ``cwd``; an
HTTP entry is a Streamable HTTP ``url`` with optional ``headers``.
``${workspaceFolder}`` (the Jupyter server's root directory) and
``${userHome}`` are replaced. Entries that cannot be used are skipped and
described, so one typo does not hide the rest.

Without any entry, the reference server (``megane-builder-tools``: liquid box,
polymer chain, solvate) is offered too, started from PATH or else with uv at a
pinned version (``default_server``); an entry of the same name replaces it,
and ``"megane-builder-tools": null`` hides it.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit


@dataclass(frozen=True)
class StdioServer:
    id: str
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    cwd: str | None = None
    kind: str = "stdio"


@dataclass(frozen=True)
class HttpServer:
    id: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    kind: str = "http"


ServerConfig = StdioServer | HttpServer

_VARIABLE = re.compile(r"\$\{(workspaceFolder|userHome)\}")
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def substitute(text: str, variables: dict[str, str | None]) -> str:
    """Replace ``${workspaceFolder}`` and ``${userHome}``; an unset variable is left as written."""
    return _VARIABLE.sub(lambda m: variables.get(m.group(1)) or m.group(0), text)


def check_server_url(raw: str) -> str | None:
    """Why ``raw`` cannot be used as a server URL, or None: HTTPS, or HTTP on this machine (§9)."""
    try:
        url = urlsplit(raw)
        host = url.hostname
    except ValueError:
        return "is not a URL"
    if not url.scheme or not host:
        return "is not a URL"
    if url.scheme == "https":
        return None
    if url.scheme == "http":
        return None if host in _LOOPBACK_HOSTS else "must use https:// unless the server is on this machine"
    return "must be an http(s) URL"


def _string_dict(value: Any) -> dict[str, str] | None:
    if value is None:
        return {}
    if not isinstance(value, dict) or not all(isinstance(v, str) for v in value.values()):
        return None
    return {str(k): v for k, v in value.items()}


def parse_server_configs(
    raw: Any, variables: dict[str, str | None] | None = None
) -> tuple[list[ServerConfig], list[str]]:
    """Read the ``mcp_servers`` option into usable servers and the problems with the rest."""
    variables = variables or {}
    servers: list[ServerConfig] = []
    problems: list[str] = []
    if raw is None:
        return servers, problems
    if not isinstance(raw, dict):
        return servers, ["the setting must be an object of servers"]
    for server_id, entry in raw.items():
        if entry is None or entry is False:
            continue  # turned off (hides the default server)

        def fail(why: str, server_id: str = server_id) -> None:
            problems.append(f'"{server_id}" {why}')

        if not isinstance(entry, dict):
            fail("must be an object with a command or a url")
            continue
        kind = entry.get("type")
        command = entry.get("command")
        if isinstance(command, str) and command.strip():
            if kind is not None and kind != "stdio":
                fail(f'has a command but type "{kind}"')
                continue
            args = entry.get("args", [])
            env = _string_dict(entry.get("env"))
            cwd = entry.get("cwd")
            if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
                fail("args must be a list of strings")
                continue
            if env is None:
                fail("env must map names to strings")
                continue
            if cwd is not None and not isinstance(cwd, str):
                fail("cwd must be a string")
                continue
            servers.append(
                StdioServer(
                    id=server_id,
                    command=substitute(command, variables),
                    args=tuple(substitute(a, variables) for a in args),
                    env={k: substitute(v, variables) for k, v in env.items()},
                    cwd=substitute(cwd, variables) if isinstance(cwd, str) else variables.get("workspaceFolder"),
                )
            )
        elif isinstance(entry.get("url"), str):
            if kind is not None and kind not in ("http", "streamable-http"):
                fail(f'has a url but type "{kind}" (only Streamable HTTP is supported)')
                continue
            url = substitute(entry["url"], variables)
            url_problem = check_server_url(url)
            headers = _string_dict(entry.get("headers"))
            if url_problem:
                fail(f"url {url_problem}")
                continue
            if headers is None:
                fail("headers must map names to strings")
                continue
            servers.append(HttpServer(id=server_id, url=url, headers=headers))
        else:
            fail("needs a command (stdio) or a url (Streamable HTTP)")
    return servers, problems


def describe_server(config: ServerConfig) -> str:
    """The command line or URL, as the user is asked about it and the page shows it."""
    if isinstance(config, StdioServer):
        return shlex.join([config.command, *config.args])
    return config.url


def server_fingerprint(config: ServerConfig) -> str:
    """What a permission covers: everything that decides what runs or where data goes."""
    if isinstance(config, StdioServer):
        return json.dumps(["stdio", config.command, list(config.args), config.env, config.cwd], sort_keys=True)
    return json.dumps(["http", config.url])


def to_bridge_server(config: ServerConfig) -> dict[str, str]:
    """The page's view of a server (``BridgeServer`` in ``src/builder/tools/bridgeProtocol.ts``)."""
    return {
        "id": config.id,
        "kind": config.kind,
        "description": describe_server(config),
        "fingerprint": server_fingerprint(config),
    }


#: The reference tool server, offered without any entry.
DEFAULT_SERVER_ID = "megane-builder-tools"
#: The version uv starts when ``megane-builder-tools`` is not installed: a pinned commit, kept
#: equal to ``DEFAULT_SERVER_SOURCE`` in ``vscode-megane/src/builderTools.ts``.
DEFAULT_SERVER_SOURCE = (
    "git+https://github.com/hodakamori/megane-builder-tools@b2aa9436c6030889ae18f04607fabe47c3a1f19f"
)


def extra_search_dirs(home: str, platform: str = sys.platform) -> list[str]:
    """Where programs are looked for besides PATH: where uv and the tools it installs live."""
    dirs = [os.path.join(home, ".local", "bin"), os.path.join(home, ".cargo", "bin")]
    if platform == "darwin":
        dirs += ["/opt/homebrew/bin", "/usr/local/bin"]
    return dirs


def find_executable(name: str, extra_dirs: list[str] | None = None, path: str | None = None) -> str | None:
    """The full path of program ``name`` on PATH or in ``extra_dirs``, or None."""
    search = [path if path is not None else os.environ.get("PATH", ""), *(extra_dirs or [])]
    return shutil.which(name, path=os.pathsep.join(p for p in search if p))


def default_server(find: Callable[[str], str | None], cwd: str | None = None) -> StdioServer | None:
    """The reference server: installed ``megane-builder-tools``, else uvx at the pinned version, else None."""
    own = find("megane-builder-tools")
    if own:
        return StdioServer(id=DEFAULT_SERVER_ID, command=own, cwd=cwd)
    uvx = find("uvx")
    if not uvx:
        return None
    return StdioServer(
        id=DEFAULT_SERVER_ID,
        command=uvx,
        args=("--from", DEFAULT_SERVER_SOURCE, "megane-builder-tools"),
        cwd=cwd,
    )


def with_default_server(
    raw: Any,
    parsed: tuple[list[ServerConfig], list[str]],
    fallback: Callable[[], ServerConfig | None],
) -> tuple[list[ServerConfig], list[str]]:
    """The configured servers plus the default one, unless the option names ``megane-builder-tools``."""
    if isinstance(raw, dict) and DEFAULT_SERVER_ID in raw:
        return parsed
    server = fallback()
    servers, problems = parsed
    return ([server, *servers], problems) if server else parsed
