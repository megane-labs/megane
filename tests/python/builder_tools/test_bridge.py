"""The tool bridge's pool and per-tab bridge, with fake clients (no processes)."""

import asyncio

import pytest

from megane.builder_tools.bridge import BridgeDeps, BuilderToolsBridge, ToolServerPool
from megane.builder_tools.config import HttpServer, StdioServer, to_bridge_server

STDIO = StdioServer(id="tools", command="uvx", args=("megane-builder-tools",))
HTTP = HttpServer(id="lab", url="https://lab.example/mcp")


class FakeClient:
    def __init__(self, call=None):
        self.server_name = "megane-builder-tools"
        self.server_version = "0.1.0"
        self.open = True
        self.closed = False
        self.calls = []
        self._call = call

    async def list_tools(self):
        return [{"name": "liquid_box"}]

    async def call_tool(self, name, arguments, timeout_ms, on_progress):
        self.calls.append((name, arguments, timeout_ms))
        if self._call:
            return await self._call(on_progress)
        await on_progress(1, 2, "packing")
        await on_progress(2, None, None)
        return {"structuredContent": {"atoms": 3}}

    async def close(self):
        self.open = False
        self.closed = True


class Factory:
    def __init__(self, *results):
        self.results = list(results)
        self.count = 0

    async def __call__(self, config):
        self.count += 1
        result = self.results.pop(0) if self.results else FakeClient()
        if isinstance(result, BaseException):
            raise result
        if callable(result) and not isinstance(result, FakeClient):
            return await result()
        return result


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_pool_shares_a_connection_and_closes_after_the_last_release():
    client = FakeClient()
    factory = Factory(client)
    pool = ToolServerPool(factory)
    a = await pool.acquire(STDIO)
    b = await pool.acquire(StdioServer(id="tools", command="uvx", args=("megane-builder-tools",)))
    assert a.client is client and b.client is client
    assert factory.count == 1
    a.release()
    a.release()
    await settle()
    assert not client.closed
    b.release()
    await settle()
    assert client.closed
    assert len(pool) == 0


async def test_pool_starts_a_changed_entry_as_a_new_server():
    factory = Factory()
    pool = ToolServerPool(factory)
    await pool.acquire(STDIO)
    await pool.acquire(StdioServer(id="tools", command="uvx", args=("--x",)))
    assert factory.count == 2 and len(pool) == 2


async def test_pool_replaces_a_dead_connection_and_the_old_holder_releases_the_old_one():
    first, second = FakeClient(), FakeClient()
    pool = ToolServerPool(Factory(first, second))
    old = await pool.acquire(STDIO)
    first.open = False
    fresh = await pool.acquire(STDIO)
    assert fresh.client is second
    old.release()
    await settle()
    assert not second.closed and len(pool) == 1
    fresh.release()
    await settle()
    assert second.closed


async def test_pool_forgets_a_server_that_failed_to_start():
    factory = Factory(RuntimeError("spawn uvx ENOENT"), FakeClient())
    pool = ToolServerPool(factory)
    with pytest.raises(RuntimeError, match="ENOENT"):
        await pool.acquire(STDIO)
    assert len(pool) == 0
    await pool.acquire(STDIO)
    assert factory.count == 2


async def test_pool_holders_waiting_on_one_start_share_its_failure_and_the_next_acquire_retries():
    started = asyncio.Event()

    async def failing():
        await started.wait()
        raise RuntimeError("boom")

    factory = Factory(failing, FakeClient())
    pool = ToolServerPool(factory)
    first = asyncio.ensure_future(pool.acquire(STDIO))
    await settle()
    second = asyncio.ensure_future(pool.acquire(STDIO))
    await settle()
    started.set()
    for waiter in (first, second):
        with pytest.raises(RuntimeError, match="boom"):
            await waiter
    assert len(pool) == 0
    lease = await pool.acquire(STDIO)
    assert isinstance(lease.client, FakeClient)
    assert factory.count == 2


async def test_pool_close_closes_everything():
    client = FakeClient()
    pool = ToolServerPool(Factory(client, RuntimeError("x")))
    await pool.acquire(STDIO)
    with pytest.raises(RuntimeError):
        await pool.acquire(HTTP)

    class Stubborn(FakeClient):
        async def close(self):
            raise RuntimeError("already gone")

    other = ToolServerPool(Factory(Stubborn()))
    await other.acquire(STDIO)
    await other.close()
    await pool.close()
    assert client.closed and len(pool) == 0


def setup(servers=(STDIO, HTTP), problems=(), client=None, factory=None):
    client = client or FakeClient()
    factory = factory or Factory(client)
    pool = ToolServerPool(factory)
    posted, logged = [], []
    deps = BridgeDeps(
        servers=lambda: (list(servers), list(problems)),
        pool=pool,
        post=posted.append,
        log=logged.append,
    )
    bridge = BuilderToolsBridge(deps)

    async def send(message):
        handled = bridge.handle(message)
        await bridge.drain()
        return handled

    def reply(request_id):
        return next((m for m in posted if m["type"] == "tools:reply" and m["requestId"] == request_id), None)

    return bridge, deps, pool, posted, logged, send, reply, factory


async def test_ignores_messages_that_are_not_bridge_requests():
    _, _, _, posted, _, send, _, _ = setup()
    assert await send({"type": "saveFile"}) is False
    assert await send("tools:call") is False
    assert posted == []


async def test_lists_servers_and_logs_problems():
    _, _, _, _, logged, send, reply, _ = setup(problems=['"x" needs a command'])
    assert await send({"type": "tools:servers", "requestId": 1})
    assert reply(1) == {
        "type": "tools:reply",
        "requestId": 1,
        "ok": True,
        "value": [to_bridge_server(STDIO), to_bridge_server(HTTP)],
    }
    assert logged == ['MeganeBuilderTools.mcp_servers: "x" needs a command']


async def test_connects_lists_tools_and_reuses_the_connection():
    _, _, _, _, _, send, reply, factory = setup()
    await send({"type": "tools:connect", "requestId": 1, "server": "tools"})
    assert reply(1)["value"] == {
        "serverName": "megane-builder-tools",
        "serverVersion": "0.1.0",
        "tools": [{"name": "liquid_box"}],
    }
    await send({"type": "tools:connect", "requestId": 2, "server": "tools"})
    assert reply(2)["ok"] is True
    assert factory.count == 1


async def test_refuses_unknown_servers_and_failed_starts():
    _, _, _, _, _, send, reply, factory = setup(factory=Factory(RuntimeError("spawn uvx ENOENT"), KeyError()))
    await send({"type": "tools:connect", "requestId": 1, "server": "nope"})
    assert reply(1)["error"] == 'There is no tool server "nope" in MeganeBuilderTools.mcp_servers.'
    await send({"type": "tools:connect", "requestId": 2, "server": "tools"})
    assert reply(2)["error"] == "spawn uvx ENOENT"
    await send({"type": "tools:connect", "requestId": 3, "server": "tools"})
    assert reply(3)["error"] == "KeyError"


async def test_relays_a_call_with_progress():
    client = FakeClient()
    _, _, _, posted, _, send, reply, _ = setup(client=client)
    await send({"type": "tools:connect", "requestId": 1, "server": "tools"})
    await send(
        {
            "type": "tools:call",
            "requestId": 2,
            "server": "tools",
            "name": "liquid_box",
            "arguments": {"seed": 1},
            "timeoutMs": 5000,
        }
    )
    assert client.calls == [("liquid_box", {"seed": 1}, 5000.0)]
    assert {"type": "tools:progress", "requestId": 2, "progress": 1, "total": 2, "message": "packing"} in posted
    assert {"type": "tools:progress", "requestId": 2, "progress": 2} in posted
    assert reply(2) == {"type": "tools:reply", "requestId": 2, "ok": True, "value": {"structuredContent": {"atoms": 3}}}


async def test_refuses_a_call_without_a_connection_and_reports_a_failed_call():
    async def broken(on_progress):
        raise TimeoutError("Request timed out")

    _, _, _, _, _, send, reply, _ = setup(client=FakeClient(call=broken))
    await send({"type": "tools:call", "requestId": 1, "server": "tools", "name": "x"})
    assert reply(1)["error"] == 'Not connected to "tools".'
    await send({"type": "tools:connect", "requestId": 2, "server": "tools"})
    await send({"type": "tools:call", "requestId": 3, "server": "tools", "name": "x"})
    assert reply(3)["error"] == "Request timed out"


async def test_cancel_and_disconnect_cancel_the_tabs_calls():
    started = asyncio.Event()

    async def forever(on_progress):
        started.set()
        await asyncio.Event().wait()

    client = FakeClient(call=forever)
    bridge, _, pool, _, _, send, reply, _ = setup(client=client)
    await send({"type": "tools:connect", "requestId": 1, "server": "tools"})
    bridge.handle({"type": "tools:call", "requestId": 2, "server": "tools", "name": "x"})
    await started.wait()
    await send({"type": "tools:cancel", "requestId": 2})
    await bridge.drain()
    assert reply(2)["error"] == "Cancelled."
    await send({"type": "tools:cancel", "requestId": 99})

    started.clear()
    bridge.handle({"type": "tools:call", "requestId": 3, "server": "tools", "name": "x"})
    await started.wait()
    await send({"type": "tools:disconnect", "server": "tools"})
    await bridge.drain()
    assert reply(3)["error"] == "Cancelled."
    await settle()
    assert client.closed and len(pool) == 0
    await send({"type": "tools:disconnect", "server": "tools"})
    await send({"type": "tools:openSettings"})


async def test_reconnects_when_the_configuration_changed_the_server():
    first, second = FakeClient(), FakeClient()
    servers = [STDIO]
    _, deps, _, _, _, send, _, factory = setup(factory=Factory(first, second))
    deps.servers = lambda: (servers, [])
    await send({"type": "tools:connect", "requestId": 1, "server": "tools"})
    servers[0] = StdioServer(id="tools", command="uvx", args=("--new",))
    await send({"type": "tools:connect", "requestId": 2, "server": "tools"})
    await settle()
    assert factory.count == 2 and first.closed


async def test_dispose_cancels_releases_and_stops_answering():
    started = asyncio.Event()

    async def forever(on_progress):
        started.set()
        await asyncio.Event().wait()

    client = FakeClient(call=forever)
    bridge, _, pool, posted, _, send, _, _ = setup(client=client)
    await send({"type": "tools:connect", "requestId": 1, "server": "tools"})
    bridge.handle({"type": "tools:call", "requestId": 2, "server": "tools", "name": "x"})
    await started.wait()
    before = len(posted)
    bridge.dispose()
    await bridge.drain()
    await settle()
    assert client.closed and len(pool) == 0 and len(posted) == before


async def test_closing_the_tab_stops_a_connection_still_starting():
    """A server that never finishes starting is stopped, not left running, when its only tab closes."""
    gate = asyncio.Event()
    stopped = []

    async def slow():
        try:
            await gate.wait()
        except asyncio.CancelledError:
            stopped.append(True)
            raise
        return FakeClient()

    bridge, _, pool, _, _, _, reply, _ = setup(factory=Factory(slow))
    bridge.handle({"type": "tools:connect", "requestId": 1, "server": "tools"})
    await settle()
    bridge.dispose()
    await bridge.drain()
    await settle()
    assert reply(1) is None
    assert stopped == [True] and len(pool) == 0


async def test_closing_one_tab_keeps_a_start_another_tab_waits_for():
    gate = asyncio.Event()
    client = FakeClient()

    async def slow():
        await gate.wait()
        return client

    pool = ToolServerPool(Factory(slow))
    tabs = []
    for _ in range(2):
        posted = []
        deps = BridgeDeps(servers=lambda: ([STDIO], []), pool=pool, post=posted.append, log=lambda line: None)
        tabs.append((BuilderToolsBridge(deps), posted))
    for bridge, _ in tabs:
        bridge.handle({"type": "tools:connect", "requestId": 1, "server": "tools"})
    await settle()
    tabs[0][0].dispose()
    await settle()
    gate.set()
    await tabs[1][0].drain()
    assert tabs[1][1][0]["ok"] is True
    assert tabs[0][1] == []
    assert not client.closed and len(pool) == 1


async def test_pool_closes_a_connection_that_started_as_its_last_waiter_left():
    started = asyncio.get_running_loop().create_future()
    client = FakeClient()

    async def slow():
        return await started

    pool = ToolServerPool(Factory(slow))
    waiter = asyncio.ensure_future(pool.acquire(STDIO))
    await settle()
    (entry,) = pool._entries.values()
    started.set_result(client)
    while not entry.client.done():
        await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    await settle()
    assert client.closed and len(pool) == 0


async def test_pool_close_stops_connections_still_starting():
    """The Jupyter server's shutdown does not wait for a server that never answers."""
    stopped = []

    async def never():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            stopped.append(True)
            raise

    pool = ToolServerPool(Factory(never))
    waiter = asyncio.ensure_future(pool.acquire(STDIO))
    await settle()
    await asyncio.wait_for(pool.close(), 5)
    assert stopped == [True] and len(pool) == 0
    with pytest.raises(RuntimeError, match="closed while it was starting"):
        await waiter


async def test_pool_close_gives_up_on_a_start_that_ignores_cancellation(monkeypatch):
    import megane.builder_tools.bridge as bridge_module

    monkeypatch.setattr(bridge_module, "CLOSE_TIMEOUT_S", 0.05)
    release = asyncio.Event()

    async def stubborn():
        while True:
            try:
                await release.wait()
                return FakeClient()
            except asyncio.CancelledError:
                continue

    pool = ToolServerPool(Factory(stubborn))
    waiter = asyncio.ensure_future(pool.acquire(STDIO))
    await settle()
    await asyncio.wait_for(pool.close(), 5)
    assert len(pool) == 0
    release.set()
    lease = await waiter
    lease.release()
    await settle()
    assert lease.client.closed
