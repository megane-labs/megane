"""The ``MeganeBuilderTools.mcp_servers`` option, read as VS Code reads ``megane.builder.mcpServers``."""

from megane.builder_tools.config import (
    HttpServer,
    StdioServer,
    check_server_url,
    describe_server,
    parse_server_configs,
    server_fingerprint,
    substitute,
    to_bridge_server,
)

STDIO = StdioServer(id="tools", command="uvx", args=("megane-builder-tools",), cwd="/w")
HTTP = HttpServer(id="lab", url="https://lab.example/mcp", headers={"Authorization": "Bearer t"})


def test_reads_stdio_and_http_entries():
    servers, problems = parse_server_configs(
        {
            "tools": {"command": "uvx", "args": ["megane-builder-tools"]},
            "mine": {
                "type": "stdio",
                "command": "${workspaceFolder}/.venv/bin/python",
                "args": ["${workspaceFolder}/my_tools.py"],
                "env": {"DATA": "${userHome}/data"},
                "cwd": "${userHome}",
            },
            "lab": {"url": "https://lab.example/mcp", "headers": {"Authorization": "Bearer t"}},
            "local": {"type": "http", "url": "http://127.0.0.1:8765/mcp"},
        },
        {"workspaceFolder": "/w", "userHome": "/home/me"},
    )
    assert problems == []
    assert servers == [
        STDIO,
        StdioServer(
            id="mine",
            command="/w/.venv/bin/python",
            args=("/w/my_tools.py",),
            env={"DATA": "/home/me/data"},
            cwd="/home/me",
        ),
        HTTP,
        HttpServer(id="local", url="http://127.0.0.1:8765/mcp"),
    ]


def test_skips_entries_it_cannot_use_and_says_why():
    servers, problems = parse_server_configs(
        {
            "ok": {"command": "x"},
            "notObject": "uvx",
            "noTransport": {"args": []},
            "badArgs": {"command": "x", "args": "a b"},
            "badEnv": {"command": "x", "env": {"A": 1}},
            "badCwd": {"command": "x", "cwd": 3},
            "wrongType": {"command": "x", "type": "http"},
            "sse": {"url": "https://h/sse", "type": "sse"},
            "plainHttp": {"url": "http://example.org/mcp"},
            "notUrl": {"url": "nope"},
            "ftp": {"url": "ftp://h/mcp"},
            "badHeaders": {"url": "https://h/mcp", "headers": []},
        }
    )
    assert [s.id for s in servers] == ["ok"]
    assert problems == [
        '"notObject" must be an object with a command or a url',
        '"noTransport" needs a command (stdio) or a url (Streamable HTTP)',
        '"badArgs" args must be a list of strings',
        '"badEnv" env must map names to strings',
        '"badCwd" cwd must be a string',
        '"wrongType" has a command but type "http"',
        '"sse" has a url but type "sse" (only Streamable HTTP is supported)',
        '"plainHttp" url must use https:// unless the server is on this machine',
        '"notUrl" url is not a URL',
        '"ftp" url must be an http(s) URL',
        '"badHeaders" headers must map names to strings',
    ]


def test_unset_and_malformed_settings():
    assert parse_server_configs(None) == ([], [])
    assert parse_server_configs([1]) == ([], ["the setting must be an object of servers"])
    assert parse_server_configs({"a": {"command": "x"}})[0][0].cwd is None


def test_substitute_leaves_unknown_and_unset_variables():
    assert substitute("${workspaceFolder}/${env:HOME}", {}) == "${workspaceFolder}/${env:HOME}"
    assert substitute("${userHome}/x", {"userHome": "/h"}) == "/h/x"


def test_urls():
    assert check_server_url("https://h/mcp") is None
    assert check_server_url("http://localhost:1/mcp") is None
    assert check_server_url("http://[::1]:1/mcp") is None
    assert "https://" in check_server_url("http://10.0.0.1/mcp")
    assert check_server_url("http://[::1/mcp") == "is not a URL"


def test_descriptions_and_fingerprints():
    assert describe_server(STDIO) == "uvx megane-builder-tools"
    assert describe_server(StdioServer(id="q", command="uvx", args=("a b",))) == "uvx 'a b'"
    assert describe_server(HTTP) == "https://lab.example/mcp"
    assert server_fingerprint(STDIO) != server_fingerprint(StdioServer(id="tools", command="uvx", args=("x",)))
    assert server_fingerprint(STDIO) != server_fingerprint(
        StdioServer(id="tools", command="uvx", args=("megane-builder-tools",), env={"A": "1"}, cwd="/w")
    )
    renamed = StdioServer(id="renamed", command="uvx", args=("megane-builder-tools",), cwd="/w")
    assert server_fingerprint(renamed) == server_fingerprint(STDIO)
    assert server_fingerprint(HttpServer(id="lab", url=HTTP.url)) == server_fingerprint(HTTP)
    assert to_bridge_server(HTTP) == {
        "id": "lab",
        "kind": "http",
        "description": "https://lab.example/mcp",
        "fingerprint": server_fingerprint(HTTP),
    }
