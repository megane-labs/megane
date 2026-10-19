"""megane Builder's tool servers, reached through the Jupyter server.

A Jupyter server extension: JupyterLab's Builder tab talks to it over a
WebSocket, and it starts or reaches the MCP tool servers named in
``MeganeBuilderTools.mcp_servers`` (Builder Tool Contract §8). It is enabled
by ``etc/jupyter/jupyter_server_config.d/megane.json`` in the wheel; the MCP
SDK it needs is the ``tools`` extra (``pip install "megane[tools]"``).
"""

from __future__ import annotations

from typing import Any

MODULE = "megane.builder_tools"


def _jupyter_server_extension_points() -> list[dict[str, str]]:
    return [{"module": MODULE}]


def _load_jupyter_server_extension(serverapp: Any) -> None:
    from megane.builder_tools.handlers import setup_handlers

    setup_handlers(serverapp)
    serverapp.log.info("megane Builder tools: %s enabled", MODULE)


async def _unload_jupyter_server_extension(serverapp: Any) -> None:
    from megane.builder_tools.handlers import SETTINGS_KEY

    state = serverapp.web_app.settings.get(SETTINGS_KEY)
    if state is not None:
        await state.pool.close()
