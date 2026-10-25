"""One Builder tab's end of the tool bridge, and the connections tabs share.

The page sends the messages of ``src/builder/tools/bridgeProtocol.ts``: list
the servers, connect, call a tool (with progress), cancel a call, disconnect.
``BuilderToolsBridge`` answers them and forwards nothing else, so a page
cannot reach resources, prompts or sampling (Builder Tool Contract §8). It is
the Python twin of ``vscode-megane/src/builderTools.ts``; the Jupyter server
extension (``handlers.py``) gives every Builder tab's WebSocket one.

Connections live in a ``ToolServerPool``: one per server entry, started on
the first ``acquire`` and closed when the last tab releases it, so a stdio
server runs once however many tabs use it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from megane.builder_tools.config import ServerConfig, server_fingerprint, to_bridge_server


class ToolClient(Protocol):
    """A connected MCP client, reduced to what the bridge relays."""

    server_name: str
    server_version: str | None

    @property
    def open(self) -> bool:
        """False once the server went away (the process exited, the session ended)."""

    async def list_tools(self) -> list[dict[str, Any]]:
        """``tools/list``, every page, as JSON."""

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        timeout_ms: float,
        on_progress: Callable[[float, float | None, str | None], Awaitable[None]],
    ) -> dict[str, Any]:
        """``tools/call``; the result as JSON. Cancelling the awaiting task cancels the call."""

    async def close(self) -> None: ...


ToolClientFactory = Callable[[ServerConfig], Awaitable[ToolClient]]


class Lease:
    """One holder's use of a pooled connection."""

    def __init__(self, client: ToolClient, release: Callable[[], None]) -> None:
        self.client = client
        self._release = release
        self._released = False

    def release(self) -> None:
        """Let go of the connection; the last holder's release closes it. Idempotent."""
        if self._released:
            return
        self._released = True
        self._release()


@dataclass
class _Entry:
    client: asyncio.Future[ToolClient]
    holders: int = 0


#: How long ``ToolServerPool.close`` waits for the servers still starting to stop.
CLOSE_TIMEOUT_S = 10.0


def _close_soon(client: ToolClient) -> None:
    task = asyncio.ensure_future(client.close())
    task.add_done_callback(lambda t: t.cancelled() or t.exception())


def _started(start: asyncio.Future[ToolClient]) -> bool:
    """Whether a finished start connected (rather than failed or was cancelled)."""
    return not start.cancelled() and start.exception() is None


class ToolServerPool:
    """Connections shared by every Builder tab of a Jupyter server.

    A changed entry is a different server (its fingerprint changed); a
    connection whose server went away is replaced on the next ``acquire``,
    and holders of the old one release the old one.
    """

    def __init__(self, factory: ToolClientFactory) -> None:
        self._factory = factory
        self._entries: dict[str, _Entry] = {}

    @staticmethod
    def _key(config: ServerConfig) -> str:
        return f"{config.id}\0{server_fingerprint(config)}"

    async def acquire(self, config: ServerConfig) -> Lease:
        """A lease on ``config``'s connection, started unless one is already up or starting.

        Everyone waiting for a starting connection counts as its holder, so
        when the last of them is cancelled (its tab closed) the start is
        cancelled too, which stops a stdio server's process.
        """
        key = self._key(config)
        entry = self._entries.get(key)
        if entry is not None and entry.client.done() and not (_started(entry.client) and entry.client.result().open):
            # It failed to start, or its server went away: start it again.
            del self._entries[key]
            entry = None
        if entry is None:
            entry = _Entry(client=asyncio.ensure_future(self._factory(config)))
            self._entries[key] = entry
        held = entry
        held.holders += 1
        try:
            client = await asyncio.shield(held.client)
        except BaseException:
            # The start was cancelled by close(), not this waiter (whose own
            # cancellation leaves the shielded start running).
            closed = held.client.cancelled()
            held.holders -= 1
            self._give_up(key, held)
            if closed:
                raise RuntimeError("The tool server connection was closed while it was starting.") from None
            raise

        def release() -> None:
            held.holders -= 1
            if held.holders > 0:
                return
            if self._entries.get(key) is held:
                del self._entries[key]
            _close_soon(client)

        return Lease(client, release)

    def _give_up(self, key: str, held: _Entry) -> None:
        """A waiter stopped waiting for ``held``: its start failed, or the waiter was cancelled."""
        start = held.client
        failed = start.done() and not _started(start)
        if not failed and held.holders > 0:
            return  # others still wait for this connection or hold it
        if self._entries.get(key) is held:
            del self._entries[key]
        if not start.done():
            start.cancel()  # nobody waits for it any more: stop the starting server
        elif not failed:
            _close_soon(start.result())  # it connected just as its last waiter left

    async def close(self) -> None:
        """Close every connection (the Jupyter server is stopping).

        Connections still starting are cancelled, which stops their servers,
        and waited for at most :data:`CLOSE_TIMEOUT_S`, so a server that never
        answers cannot hold up the shutdown.
        """
        starts = [entry.client for entry in self._entries.values()]
        self._entries.clear()
        for start in starts:
            start.cancel()  # no-op on a finished start
        if starts:
            await asyncio.wait(starts, timeout=CLOSE_TIMEOUT_S)
        for start in starts:
            if not start.done() or not _started(start):
                continue
            try:
                await start.result().close()
            except Exception:
                pass

    def __len__(self) -> int:
        return len(self._entries)


@dataclass
class BridgeDeps:
    """What a bridge needs from its host."""

    #: The configured servers and the problems with the configuration, read on each request.
    servers: Callable[[], tuple[list[ServerConfig], list[str]]]
    pool: ToolServerPool
    #: Send a message to the page.
    post: Callable[[dict[str, Any]], None]
    log: Callable[[str], None]


def _error_text(err: BaseException) -> str:
    return str(err) or type(err).__name__


class BuilderToolsBridge:
    """One Builder tab's end of the bridge."""

    def __init__(self, deps: BridgeDeps) -> None:
        self._deps = deps
        self._held: dict[str, tuple[ServerConfig, Lease]] = {}
        self._calls: dict[int, tuple[str, asyncio.Task[Any]]] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._disposed = False

    def handle(self, message: Any) -> bool:
        """Start handling a message from the page; False when it is not a bridge request."""
        if not isinstance(message, dict) or message.get("type") not in _REQUESTS:
            return False
        task = asyncio.ensure_future(self._dispatch(message))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return True

    async def drain(self) -> None:
        """Wait for the requests being handled (tests)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    def _post(self, message: dict[str, Any]) -> None:
        if not self._disposed:
            self._deps.post(message)

    def _reply(self, request_id: int, *, value: Any = None, error: str | None = None) -> None:
        if error is None:
            self._post({"type": "tools:reply", "requestId": request_id, "ok": True, "value": value})
        else:
            self._post({"type": "tools:reply", "requestId": request_id, "ok": False, "error": error})

    async def _dispatch(self, message: dict[str, Any]) -> None:
        kind = message["type"]
        if kind == "tools:servers":
            servers, problems = self._deps.servers()
            for problem in problems:
                self._deps.log(f"MeganeBuilderTools.mcp_servers: {problem}")
            self._reply(message["requestId"], value=[to_bridge_server(s) for s in servers])
        elif kind == "tools:connect":
            try:
                value = await self._connect(str(message.get("server")))
            except Exception as err:
                self._reply(message["requestId"], error=_error_text(err))
            else:
                self._reply(message["requestId"], value=value)
        elif kind == "tools:call":
            await self._call(message)
        elif kind == "tools:cancel":
            call = self._calls.get(message.get("requestId"))
            if call is not None:
                call[1].cancel()
        elif kind == "tools:disconnect":
            self._drop(str(message.get("server")))
        # tools:openSettings: the servers are configured in jupyter_server_config, not in the page.

    async def _connect(self, server_id: str) -> dict[str, Any]:
        servers, _ = self._deps.servers()
        config = next((s for s in servers if s.id == server_id), None)
        if config is None:
            raise LookupError(f'There is no tool server "{server_id}" in MeganeBuilderTools.mcp_servers.')
        held = self._held.get(server_id)
        if held and held[1].client.open and server_fingerprint(held[0]) == server_fingerprint(config):
            client = held[1].client
        else:
            self._drop(server_id)
            lease = await self._deps.pool.acquire(config)
            if self._disposed:
                lease.release()
                raise RuntimeError("The Builder tab was closed.")
            self._held[server_id] = (config, lease)
            client = lease.client
        return {
            "serverName": client.server_name,
            "serverVersion": client.server_version,
            "tools": await client.list_tools(),
        }

    async def _call(self, message: dict[str, Any]) -> None:
        request_id = message["requestId"]
        server_id = str(message.get("server"))
        held = self._held.get(server_id)
        if held is None:
            self._reply(request_id, error=f'Not connected to "{server_id}".')
            return

        async def on_progress(progress: float, total: float | None, text: str | None) -> None:
            note: dict[str, Any] = {"type": "tools:progress", "requestId": request_id, "progress": progress}
            if total is not None:
                note["total"] = total
            if text is not None:
                note["message"] = text
            self._post(note)

        call = asyncio.ensure_future(
            held[1].client.call_tool(
                str(message.get("name")),
                message.get("arguments") or {},
                float(message.get("timeoutMs") or 0),
                on_progress,
            )
        )
        self._calls[request_id] = (server_id, call)
        try:
            value = await call
        except asyncio.CancelledError:
            self._reply(request_id, error="Cancelled.")
        except Exception as err:
            self._reply(request_id, error=_error_text(err))
        else:
            self._reply(request_id, value=value)
        finally:
            self._calls.pop(request_id, None)

    def _drop(self, server_id: str) -> None:
        """Let go of a server: this tab's calls to it are cancelled."""
        for owner, call in list(self._calls.values()):
            if owner == server_id:
                call.cancel()
        held = self._held.pop(server_id, None)
        if held is not None:
            held[1].release()

    def dispose(self) -> None:
        """The tab closed: cancel its calls and connects, release its servers, stop answering.

        A connect still waiting for its server to start is cancelled too: the
        pool then stops the start when no other tab waits for it.
        """
        for server_id in list(self._held):
            self._drop(server_id)
        for _, call in list(self._calls.values()):
            call.cancel()
        for task in list(self._tasks):
            task.cancel()
        self._disposed = True


_REQUESTS = {
    "tools:servers",
    "tools:connect",
    "tools:call",
    "tools:cancel",
    "tools:disconnect",
    "tools:openSettings",
}
