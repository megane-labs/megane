"""The Jupyter server extension: the WebSocket a JupyterLab Builder tab talks to."""

import json
import sys
from pathlib import Path

import pytest

import megane.builder_tools as builder_tools
from megane.builder_tools.handlers import SETTINGS_KEY, MeganeBuilderTools

SERVER = str(Path(__file__).with_name("fake_mcp_server.py"))


@pytest.fixture
def jp_server_config():
    return {
        "ServerApp": {"jpserver_extensions": {"megane.builder_tools": True}},
        "MeganeBuilderTools": {
            "mcp_servers": {
                "fake": {"command": sys.executable, "args": [SERVER], "env": {"FAKE": "${workspaceFolder}"}},
                "broken": {"args": []},
            }
        },
    }


async def rpc(ws, message):
    """Send a request and collect messages until its reply."""
    await ws.write_message(json.dumps(message))
    seen = []
    while True:
        received = json.loads(await ws.read_message())
        seen.append(received)
        if received["type"] == "tools:reply" and received["requestId"] == message.get("requestId"):
            return received, seen


def test_extension_points():
    assert builder_tools._jupyter_server_extension_points() == [{"module": "megane.builder_tools"}]
    assert "mcpServers format" in MeganeBuilderTools.mcp_servers.help


def without_programs(serverapp):
    """No program is installed: no default server (tests that are not about it)."""
    serverapp.web_app.settings[SETTINGS_KEY].find = lambda name: None


async def test_lists_connects_and_calls_through_the_websocket(jp_serverapp, jp_ws_fetch, jp_root_dir):
    without_programs(jp_serverapp)
    ws = await jp_ws_fetch("megane", "builder-tools", "ws")
    try:
        reply, _ = await rpc(ws, {"type": "tools:servers", "requestId": 1})
        assert reply["value"] == [
            {
                "id": "fake",
                "kind": "stdio",
                "description": f"{sys.executable} {SERVER}",
                "fingerprint": reply["value"][0]["fingerprint"],
            }
        ]
        reply, _ = await rpc(ws, {"type": "tools:connect", "requestId": 2, "server": "fake"})
        assert reply["ok"] is True
        assert reply["value"]["serverName"] == "fake-tools"
        assert [t["name"] for t in reply["value"]["tools"]] == ["echo", "second"]
        reply, seen = await rpc(
            ws,
            {
                "type": "tools:call",
                "requestId": 3,
                "server": "fake",
                "name": "echo",
                "arguments": {"seed": 1},
                "timeoutMs": 10000,
            },
        )
        assert reply["value"]["structuredContent"] == {"arguments": {"seed": 1}}
        assert {"type": "tools:progress", "requestId": 3, "progress": 1, "total": 2, "message": "half"} in seen
        # Not JSON, and not a bridge request: ignored.
        await ws.write_message("not json")
        await ws.write_message(json.dumps({"type": "saveFile"}))
        await ws.write_message(json.dumps({"type": "tools:disconnect", "server": "fake"}))
        reply, _ = await rpc(ws, {"type": "tools:call", "requestId": 4, "server": "fake", "name": "echo"})
        assert reply["error"] == 'Not connected to "fake".'
    finally:
        ws.close()


async def test_offers_the_reference_server_by_default(jp_serverapp, jp_ws_fetch, jp_root_dir):
    jp_serverapp.web_app.settings[SETTINGS_KEY].find = lambda name: "/b/uvx" if name == "uvx" else None
    ws = await jp_ws_fetch("megane", "builder-tools", "ws")
    try:
        reply, _ = await rpc(ws, {"type": "tools:servers", "requestId": 1})
        assert [s["id"] for s in reply["value"]] == ["megane-builder-tools", "fake"]
        assert reply["value"][0]["description"].startswith(
            "/b/uvx --from git+https://github.com/hodakamori/megane-builder-tools@"
        )
    finally:
        ws.close()


async def test_unload_closes_the_tool_servers(jp_serverapp, jp_ws_fetch):
    ws = await jp_ws_fetch("megane", "builder-tools", "ws")
    reply, _ = await rpc(ws, {"type": "tools:connect", "requestId": 1, "server": "fake"})
    assert reply["ok"] is True
    state = jp_serverapp.web_app.settings[SETTINGS_KEY]
    assert len(state.pool) == 1
    ws.close()
    await builder_tools._unload_jupyter_server_extension(jp_serverapp)
    assert len(state.pool) == 0
