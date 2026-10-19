"""The Jupyter server side of megane Builder's tool bridge.

The JupyterLab Builder tab cannot start a stdio MCP server, and a tool server
on another port would have to allow the page's origin. So the page talks to
the Jupyter server over a WebSocket (``/megane/builder-tools/ws``), and the
server starts or reaches the tool servers named in its configuration::

    // ~/.jupyter/jupyter_server_config.json
    {
      "MeganeBuilderTools": {
        "mcp_servers": {
          "megane-builder-tools": {"command": "megane-builder-tools"}
        }
      }
    }

The configuration is the server owner's, like everything else that runs
commands on the server; a user who can open the WebSocket must also be
allowed to execute kernels. The page asks before first using a server (§9).
"""

from __future__ import annotations

import json
import os
from typing import Any

from jupyter_core.utils import ensure_async
from jupyter_server.auth.decorator import ws_authenticated
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.utils import url_path_join
from tornado import web, websocket
from traitlets import Dict
from traitlets.config import Configurable

from megane.builder_tools.bridge import BridgeDeps, BuilderToolsBridge, ToolServerPool
from megane.builder_tools.config import (
    default_server,
    extra_search_dirs,
    find_executable,
    parse_server_configs,
    with_default_server,
)
from megane.builder_tools.sdk_client import connect_with_sdk

WS_PATH = "megane/builder-tools/ws"
SETTINGS_KEY = "megane_builder_tools"


class MeganeBuilderTools(Configurable):
    """megane Builder's tool servers on this Jupyter server."""

    mcp_servers = Dict(
        default_value={},
        config=True,
        help=(
            "MCP tool servers for megane Builder's Tools menu, in the mcpServers format LLM "
            "clients use: {name: {command, args, env, cwd}} for a stdio server, or "
            "{name: {url, headers}} for a Streamable HTTP server (https, or http on this "
            "machine). ${workspaceFolder} (the server's root directory) and ${userHome} are "
            "replaced. Without an entry named megane-builder-tools, the reference server is "
            "offered (installed, else run by uvx at a pinned version); null hides it."
        ),
    )


class ToolsState:
    """What every Builder tab's WebSocket shares: the configuration and the connections."""

    def __init__(self, tools: MeganeBuilderTools, root_dir: str, log: Any) -> None:
        self.tools = tools
        self.root_dir = root_dir
        self.log = log
        home = os.path.expanduser("~")
        #: How programs are found (replaced in tests).
        self.find = lambda name: find_executable(name, extra_search_dirs(home))
        self.pool = ToolServerPool(lambda config: connect_with_sdk(config, self.info))

    def info(self, line: str) -> None:
        self.log.info("megane Builder tools: %s", line)

    def servers(self):
        raw = self.tools.mcp_servers
        parsed = parse_server_configs(raw, {"workspaceFolder": self.root_dir, "userHome": os.path.expanduser("~")})
        # The reference server is offered without any entry.
        return with_default_server(raw, parsed, lambda: default_server(self.find, self.root_dir))


class BuilderToolsWebSocket(JupyterHandler, websocket.WebSocketHandler):
    """One Builder tab's bridge: the messages of ``src/builder/tools/bridgeProtocol.ts``."""

    auth_resource = "kernels"

    async def pre_get(self) -> None:
        # Running a tool server is running code on this machine.
        allowed = await ensure_async(self.authorizer.is_authorized(self, self.current_user, "execute", "kernels"))
        if not allowed:
            raise web.HTTPError(403)

    @ws_authenticated
    async def get(self, *args: Any, **kwargs: Any) -> None:
        await self.pre_get()
        res = super().get(*args, **kwargs)
        if res is not None:
            await res

    def open(self, *args: Any, **kwargs: Any) -> None:
        state: ToolsState = self.settings[SETTINGS_KEY]
        self.bridge = BuilderToolsBridge(
            BridgeDeps(servers=state.servers, pool=state.pool, post=self._send, log=state.info)
        )

    def _send(self, message: dict[str, Any]) -> None:
        try:
            self.write_message(json.dumps(message))
        except websocket.WebSocketClosedError:
            pass

    def on_message(self, message: str | bytes) -> None:
        try:
            data = json.loads(message)
        except ValueError:
            return
        self.bridge.handle(data)

    def on_close(self) -> None:
        bridge = getattr(self, "bridge", None)
        if bridge is not None:
            bridge.dispose()


def setup_handlers(serverapp: Any) -> ToolsState:
    """Register the WebSocket on ``serverapp`` and return the shared state."""
    state = ToolsState(MeganeBuilderTools(parent=serverapp), serverapp.root_dir, serverapp.log)
    web_app = serverapp.web_app
    web_app.settings[SETTINGS_KEY] = state
    route = url_path_join(web_app.settings["base_url"], WS_PATH)
    web_app.add_handlers(".*$", [(route, BuilderToolsWebSocket)])
    return state
