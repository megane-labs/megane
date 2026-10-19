"""``connect_with_sdk`` against real (minimal) MCP servers: a stdio process and a Streamable HTTP endpoint."""

import asyncio
import builtins
import json
import sys
from pathlib import Path

import pytest
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets
from tornado.web import Application, RequestHandler

from megane.builder_tools.config import HttpServer, StdioServer
from megane.builder_tools.sdk_client import INSTALL_HINT, connect_with_sdk

SERVER = str(Path(__file__).with_name("fake_mcp_server.py"))


def stdio(**kwargs):
    defaults = {"id": "fake", "command": sys.executable, "args": (SERVER,)}
    return StdioServer(**{**defaults, **kwargs})


async def test_stdio_lists_every_page_calls_with_progress_and_logs_stderr(tmp_path):
    lines = []
    client = await connect_with_sdk(stdio(env={"FAKE": "yes"}, cwd=str(tmp_path)), lines.append)
    try:
        assert (client.server_name, client.server_version, client.open) == ("fake-tools", "9.9", True)
        tools = await client.list_tools()
        assert [t["name"] for t in tools] == ["echo", "second"]
        assert tools[0]["_meta"] == {"io.github.megane-labs/builder": {"contract": 1}}
        progress = []

        async def on_progress(*p):
            progress.append(p)

        result = await client.call_tool("echo", {"seed": 3}, 10_000, on_progress)
        assert result["structuredContent"] == {"arguments": {"seed": 3}}
        assert progress == [(1, 2, "half")]
        failed = await client.call_tool("fail", {}, 0, on_progress)
        assert failed["isError"] is True
    finally:
        await client.close()
    assert client.open is False
    for _ in range(50):
        if any("with FAKE=yes" in line for line in lines):
            break
        await asyncio.sleep(0.05)
    assert lines[0] == f"[fake] connecting: {sys.executable} {SERVER}"
    assert any(f"started in {tmp_path} with FAKE=yes" in line for line in lines)
    assert lines[-1] == "[fake] disconnected"


async def test_cancelling_a_call_cancels_it():
    client = await connect_with_sdk(stdio(), lambda line: None)
    try:

        async def ignore(*p):
            pass

        call = asyncio.ensure_future(client.call_tool("slow", {}, 0, ignore))
        await asyncio.sleep(0.2)
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        # The connection survives a cancelled call.
        result = await client.call_tool("echo", {}, 10_000, ignore)
        assert result["structuredContent"] == {"arguments": {}}
    finally:
        await client.close()


async def test_notices_a_server_going_away():
    lines = []
    client = await connect_with_sdk(stdio(env={"FAKE_TOOLS_EXIT_AFTER_INIT": "1"}), lines.append)
    for _ in range(100):
        if not client.open:
            break
        await asyncio.sleep(0.05)
    assert client.open is False
    for _ in range(50):
        if "[fake] disconnected" in lines:
            break
        await asyncio.sleep(0.05)
    assert "[fake] disconnected" in lines
    await client.close()


async def test_a_server_that_fails_to_start_raises():
    with pytest.raises(Exception):  # noqa: B017 - the SDK's error type is its own
        await connect_with_sdk(stdio(command="/nonexistent/megane-tools"), lambda line: None)


async def test_says_what_to_install_without_the_sdk(monkeypatch):
    real_import = builtins.__import__

    def no_mcp(name, *args, **kwargs):
        if name == "mcp":
            raise ImportError("No module named 'mcp'")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_mcp)
    with pytest.raises(RuntimeError, match="megane\\[tools\\]") as info:
        await connect_with_sdk(stdio(), lambda line: None)
    assert str(info.value) == INSTALL_HINT


class McpEndpoint(RequestHandler):
    """Streamable HTTP with JSON responses only."""

    seen: list = []

    def post(self):
        self.seen.append(self.request.headers.get("Authorization"))
        message = json.loads(self.request.body)
        if "id" not in message:
            self.set_status(202)
            return
        method = message["method"]
        if method == "initialize":
            result = {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "", "version": ""},
            }
        elif method == "tools/list":
            result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}
        else:
            result = {"content": [], "structuredContent": {"arguments": message["params"]["arguments"]}}
        self.set_header("Content-Type", "application/json")
        self.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}))

    def get(self):
        self.set_status(405)

    def delete(self):
        self.set_status(200)


async def test_http_sends_the_configured_headers_and_names_a_quiet_server_by_its_id():
    sockets = bind_sockets(0, "127.0.0.1")
    port = sockets[0].getsockname()[1]
    server = HTTPServer(Application([(r"/mcp", McpEndpoint)]))
    server.add_sockets(sockets)
    McpEndpoint.seen = []
    try:
        client = await connect_with_sdk(
            HttpServer(id="web", url=f"http://127.0.0.1:{port}/mcp", headers={"Authorization": "Bearer tok"}),
            lambda line: None,
        )
        try:
            assert (client.server_name, client.server_version) == ("web", None)
            assert [t["name"] for t in await client.list_tools()] == ["echo"]

            async def ignore(*p):
                pass

            result = await client.call_tool("echo", {"a": 1}, 10_000, ignore)
            assert result["structuredContent"] == {"arguments": {"a": 1}}
        finally:
            await client.close()
    finally:
        server.stop()
    assert McpEndpoint.seen and all(h == "Bearer tok" for h in McpEndpoint.seen)
