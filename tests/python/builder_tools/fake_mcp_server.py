"""A minimal stdio MCP server for the tool-bridge tests (stdlib only).

Newline-delimited JSON-RPC: two pages of tools, a call that reports progress
before answering, a tool that never answers (``slow``) and one that fails, and
a line on stderr at start. ``FAKE_TOOLS_EXIT_AFTER_INIT=1`` makes it exit right
after initializing, as a server that dies.
"""

import json
import os
import sys
import threading
import time


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def answer(message):
    method = message["method"]
    if method == "initialize":
        return {
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-tools", "version": "9.9"},
        }
    if method == "tools/list":
        if (message.get("params") or {}).get("cursor"):
            return {"tools": [{"name": "second", "inputSchema": {"type": "object"}}]}
        return {
            "tools": [
                {
                    "name": "echo",
                    "inputSchema": {"type": "object"},
                    "_meta": {"io.github.megane-labs/builder": {"contract": 1}},
                }
            ],
            "nextCursor": "2",
        }
    if method == "tools/call":
        params = message["params"]
        token = (params.get("_meta") or {}).get("progressToken")
        if params["name"] == "slow":
            return None
        if token is not None:
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/progress",
                    "params": {"progressToken": token, "progress": 1, "total": 2, "message": "half"},
                }
            )
            time.sleep(0.05)
        if params["name"] == "fail":
            return {"content": [{"type": "text", "text": "it broke"}], "isError": True}
        return {
            "content": [{"type": "text", "text": "echoed"}],
            "structuredContent": {"arguments": params.get("arguments", {})},
        }
    return {}


def main():
    sys.stderr.write(f"fake-tools started in {os.getcwd()} with FAKE={os.environ.get('FAKE')}\n")
    sys.stderr.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        message = json.loads(line)
        if "id" not in message:
            continue
        result = answer(message)
        if result is None:
            continue
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})
        if message["method"] == "initialize" and os.environ.get("FAKE_TOOLS_EXIT_AFTER_INIT"):
            threading.Timer(0.3, lambda: os._exit(0)).start()


if __name__ == "__main__":
    main()
