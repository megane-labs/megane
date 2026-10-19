"""The ``MeganeBuilderTools.mcp_servers`` option, read as VS Code reads ``megane.builder.mcpServers``."""

from megane.builder_tools.config import (
    DEFAULT_SERVER_ID,
    DEFAULT_SERVER_SOURCE,
    HttpServer,
    StdioServer,
    check_server_url,
    default_server,
    describe_server,
    extra_search_dirs,
    find_executable,
    parse_server_configs,
    server_fingerprint,
    substitute,
    to_bridge_server,
    with_default_server,
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


def test_null_and_false_entries_are_turned_off():
    servers, problems = parse_server_configs({"a": None, "b": False, "c": {"command": "x"}})
    assert [s.id for s in servers] == ["c"] and problems == []


def test_find_executable_on_path_and_extra_dirs(tmp_path):
    tool = tmp_path / "bin" / "megane-builder-tools"
    tool.parent.mkdir()
    tool.write_text("#!/bin/sh\n")
    tool.chmod(0o755)
    assert find_executable("megane-builder-tools", path="/nonexistent") is None
    assert find_executable("megane-builder-tools", [str(tool.parent)], path="") == str(tool)
    assert find_executable("python3") is not None


def test_extra_search_dirs():
    assert extra_search_dirs("/h", "linux") == ["/h/.local/bin", "/h/.cargo/bin"]
    assert "/opt/homebrew/bin" in extra_search_dirs("/h", "darwin")
    assert extra_search_dirs("/h")


def test_default_server_prefers_an_installed_one_else_uvx_at_the_pinned_version():
    def only(found):
        return lambda name: found.get(name)

    assert default_server(only({"megane-builder-tools": "/b/mbt", "uvx": "/b/uvx"}), "/w") == StdioServer(
        id=DEFAULT_SERVER_ID, command="/b/mbt", cwd="/w"
    )
    assert default_server(only({"uvx": "/b/uvx"})) == StdioServer(
        id=DEFAULT_SERVER_ID, command="/b/uvx", args=("--from", DEFAULT_SERVER_SOURCE, "megane-builder-tools")
    )
    assert default_server(only({})) is None


def test_the_default_is_added_unless_the_option_names_it():
    parsed = parse_server_configs({"a": {"command": "x"}})

    def fallback():
        return default_server(lambda name: "/b/uvx" if name == "uvx" else None)

    assert [s.id for s in with_default_server({"a": {}}, parsed, fallback)[0]] == [DEFAULT_SERVER_ID, "a"]
    assert with_default_server({DEFAULT_SERVER_ID: None}, parsed, fallback) is parsed
    assert with_default_server(None, parsed, lambda: None) is parsed
