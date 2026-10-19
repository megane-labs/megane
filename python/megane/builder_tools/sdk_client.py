"""A ``ToolClient`` (``bridge.py``) on the MCP Python SDK.

stdio servers are started as a child process, whose stderr goes to ``log``;
HTTP servers are reached directly. The SDK is an optional dependency
(``pip install "megane[tools]"``); without it, connecting says so.

The SDK's transports and session are async context managers that must be
entered and left in one task, so each connection runs in a task of its own
that holds them open until ``close``; calls are made from the WebSocket
handlers' tasks.
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Any

from megane.builder_tools.config import HttpServer, ServerConfig, StdioServer, describe_server

INSTALL_HINT = 'Tool servers need the MCP SDK on the Jupyter server: pip install "megane[tools]", then restart Jupyter.'


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(by_alias=True, exclude_none=True, mode="json")


def _stderr_pipe(config: ServerConfig, log: Callable[[str], None]) -> tuple[Any, threading.Thread]:
    """A file for the server's stderr whose lines go to ``log`` (the SDK needs a real file)."""
    read_fd, write_fd = os.pipe()
    writer = os.fdopen(write_fd, "w")

    def pump() -> None:
        with os.fdopen(read_fd, "r", errors="replace") as reader:
            for line in reader:
                if line.strip():
                    log(f"[{config.id}] {line.rstrip()}")

    thread = threading.Thread(target=pump, name=f"megane-tools-stderr-{config.id}", daemon=True)
    thread.start()
    return writer, thread


class _WatchedStream:
    """A transport's read stream that tells when it ends (the server went away)."""

    def __init__(self, stream: Any, ended: asyncio.Event) -> None:
        self._stream = stream
        self._ended = ended

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)

    async def receive(self) -> Any:
        try:
            return await self._stream.receive()
        except BaseException:
            self._ended.set()
            raise

    def __aiter__(self) -> _WatchedStream:
        return self

    async def __anext__(self) -> Any:
        try:
            return await self._stream.__anext__()
        except BaseException:
            self._ended.set()
            raise

    async def aclose(self) -> None:
        await self._stream.aclose()

    async def __aenter__(self) -> _WatchedStream:
        await self._stream.__aenter__()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        self._ended.set()
        return await self._stream.__aexit__(*exc)


class SdkToolClient:
    """One connection to a tool server, held open by its own task."""

    def __init__(self, config: ServerConfig, log: Callable[[str], None]) -> None:
        self.config = config
        self.server_name = config.id
        self.server_version: str | None = None
        self._log = log
        self._session: Any = None
        self._open = False
        self._ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._stop = asyncio.Event()
        self._ended = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    @property
    def open(self) -> bool:
        return self._open

    async def start(self) -> None:
        self._task = asyncio.ensure_future(self._run())
        await self._ready

    async def _run(self) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

        errlog = None
        self._log(f"[{self.config.id}] connecting: {describe_server(self.config)}")
        try:
            async with AsyncExitStack() as stack:
                if isinstance(self.config, StdioServer):
                    errlog, _ = _stderr_pipe(self.config, self._log)
                    params = StdioServerParameters(
                        command=self.config.command,
                        args=list(self.config.args),
                        # The server's whole environment, not the SDK's few variables: a server
                        # started by uvx downloads on first use and needs the proxy and uv settings.
                        env={**os.environ, **self.config.env},
                        cwd=self.config.cwd,
                    )
                    read, write = await stack.enter_async_context(stdio_client(params, errlog=errlog))
                else:
                    assert isinstance(self.config, HttpServer)
                    http = await stack.enter_async_context(create_mcp_http_client(headers=self.config.headers))
                    read, write = await stack.enter_async_context(
                        streamable_http_client(self.config.url, http_client=http)
                    )
                session = await stack.enter_async_context(ClientSession(_WatchedStream(read, self._ended), write))
                init = await session.initialize()
                info = getattr(init, "server_info", None)
                self.server_name = (info.name if info else "") or self.config.id
                self.server_version = (info.version if info else "") or None
                self._session = session
                self._open = True
                self._ready.set_result(None)
                # Until close(), or until the server goes away.
                waits = [asyncio.ensure_future(self._stop.wait()), asyncio.ensure_future(self._ended.wait())]
                try:
                    await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for wait in waits:
                        wait.cancel()
                self._open = False
        except BaseException as err:
            if not self._ready.done():
                self._ready.set_exception(err if isinstance(err, Exception) else RuntimeError(str(err)))
            elif not self._stop.is_set():
                self._log(f"[{self.config.id}] failed: {err}")
            if not isinstance(err, Exception):
                raise
        finally:
            self._open = False
            if errlog is not None:
                errlog.close()
            self._log(f"[{self.config.id}] disconnected")

    async def list_tools(self) -> list[dict[str, Any]]:
        from mcp.types import PaginatedRequestParams

        tools: list[dict[str, Any]] = []
        cursor: str | None = None
        while True:
            page = await self._session.list_tools(params=PaginatedRequestParams(cursor=cursor) if cursor else None)
            tools.extend(_dump(tool) for tool in page.tools)
            cursor = page.next_cursor
            if not cursor:
                return tools

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        timeout_ms: float,
        on_progress: Callable[[float, float | None, str | None], Awaitable[None]],
    ) -> dict[str, Any]:
        result = await self._session.call_tool(
            name,
            arguments,
            read_timeout_seconds=timeout_ms / 1000 if timeout_ms > 0 else None,
            progress_callback=on_progress,
        )
        return _dump(result)

    async def close(self) -> None:
        self._open = False
        self._stop.set()
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)


async def connect_with_sdk(config: ServerConfig, log: Callable[[str], None]) -> SdkToolClient:
    """Connect to ``config``'s server; raises with an install hint when the SDK is missing."""
    try:
        import mcp  # noqa: F401
    except ImportError as err:
        raise RuntimeError(INSTALL_HINT) from err
    client = SdkToolClient(config, log)
    await client.start()
    return client
