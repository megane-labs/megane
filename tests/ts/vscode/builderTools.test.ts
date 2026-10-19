/**
 * The extension host's end of megane Builder's tool bridge: the
 * `megane.builder.mcpServers` setting, the permission gate, the shared pool of
 * connections, and the per-tab bridge that relays the page's requests.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BuilderToolsBridge,
  ToolServerPool,
  checkServerUrl,
  createPermissionGate,
  describeServer,
  parseServerConfigs,
  serverFingerprint,
  substitute,
  toBridgeServer,
  type BridgeDeps,
  type ServerConfig,
  type ToolClient,
} from "../../../vscode-megane/src/builderTools";
import { nodeVersionProblem } from "../../../vscode-megane/src/sdkClient";
import type { BridgeReply } from "@/builder/tools/bridgeProtocol";

const STDIO: ServerConfig = {
  id: "tools",
  kind: "stdio",
  command: "uvx",
  args: ["megane-builder-tools"],
  env: {},
  cwd: "/w",
};
const HTTP: ServerConfig = {
  id: "lab",
  kind: "http",
  url: "https://lab.example/mcp",
  headers: { Authorization: "Bearer t" },
};

describe("parseServerConfigs", () => {
  it("reads stdio and HTTP entries in the mcpServers format", () => {
    const { servers, problems } = parseServerConfigs(
      {
        tools: { command: "uvx", args: ["megane-builder-tools"] },
        mine: {
          type: "stdio",
          command: "${workspaceFolder}/.venv/bin/python",
          args: ["${workspaceFolder}/my_tools.py"],
          env: { DATA: "${userHome}/data" },
          cwd: "${userHome}",
        },
        lab: { url: "https://lab.example/mcp", headers: { Authorization: "Bearer t" } },
        local: { type: "http", url: "http://127.0.0.1:8765/mcp" },
      },
      { workspaceFolder: "/w", userHome: "/home/me" },
    );
    expect(problems).toEqual([]);
    expect(servers).toEqual([
      { ...STDIO },
      {
        id: "mine",
        kind: "stdio",
        command: "/w/.venv/bin/python",
        args: ["/w/my_tools.py"],
        env: { DATA: "/home/me/data" },
        cwd: "/home/me",
      },
      HTTP,
      { id: "local", kind: "http", url: "http://127.0.0.1:8765/mcp", headers: {} },
    ]);
  });

  it("skips entries it cannot use and says why", () => {
    const { servers, problems } = parseServerConfigs({
      ok: { command: "x" },
      notObject: "uvx",
      noTransport: { args: [] },
      badArgs: { command: "x", args: "a b" },
      badEnv: { command: "x", env: { A: 1 } },
      badCwd: { command: "x", cwd: 3 },
      wrongType: { command: "x", type: "http" },
      sse: { url: "https://h/sse", type: "sse" },
      plainHttp: { url: "http://example.org/mcp" },
      notUrl: { url: "nope" },
      ftp: { url: "ftp://h/mcp" },
      badHeaders: { url: "https://h/mcp", headers: [] },
    });
    expect(servers.map((s) => s.id)).toEqual(["ok"]);
    expect(problems).toEqual([
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
    ]);
  });

  it("reads an unset setting as no servers and rejects a non-object", () => {
    expect(parseServerConfigs(undefined)).toEqual({ servers: [], problems: [] });
    expect(parseServerConfigs(null)).toEqual({ servers: [], problems: [] });
    expect(parseServerConfigs([1]).problems).toEqual(["the setting must be an object of servers"]);
  });

  it("leaves unknown or unset variables as written", () => {
    expect(substitute("${workspaceFolder}/${env:HOME}", {})).toBe("${workspaceFolder}/${env:HOME}");
    expect(parseServerConfigs({ a: { command: "x" } }).servers[0]).toMatchObject({
      cwd: undefined,
    });
  });
});

describe("server descriptions", () => {
  it("shows the command line, quoting what a shell would split", () => {
    expect(describeServer(STDIO)).toBe("uvx megane-builder-tools");
    expect(describeServer({ ...STDIO, args: ["a b", "it's"] })).toBe(`uvx 'a b' 'it'\\''s'`);
    expect(describeServer(HTTP)).toBe("https://lab.example/mcp");
    expect(toBridgeServer(HTTP)).toEqual({
      id: "lab",
      kind: "http",
      description: "https://lab.example/mcp",
    });
  });

  it("fingerprints what decides what runs or where data goes", () => {
    expect(serverFingerprint(STDIO)).not.toBe(serverFingerprint({ ...STDIO, args: ["other"] }));
    expect(serverFingerprint(STDIO)).not.toBe(serverFingerprint({ ...STDIO, env: { A: "1" } }));
    expect(serverFingerprint({ ...STDIO, id: "renamed" })).toBe(serverFingerprint(STDIO));
    expect(serverFingerprint({ ...HTTP, headers: {} })).toBe(serverFingerprint(HTTP));
  });

  it("accepts https anywhere and http on this machine only", () => {
    expect(checkServerUrl("https://h/mcp")).toBeNull();
    expect(checkServerUrl("http://localhost:1/mcp")).toBeNull();
    expect(checkServerUrl("http://[::1]:1/mcp")).toBeNull();
    expect(checkServerUrl("http://10.0.0.1/mcp")).toContain("https://");
  });
});

describe("nodeVersionProblem", () => {
  it("accepts Node.js 20 and later, and explains an older VS Code", () => {
    expect(nodeVersionProblem("20.9.0")).toBeNull();
    expect(nodeVersionProblem("22.1.0")).toBeNull();
    expect(nodeVersionProblem()).toBeNull();
    expect(nodeVersionProblem("18.18.2")).toBe(
      "Tool servers need VS Code 1.90 or later (Node.js 20); this VS Code runs Node.js 18.18.2.",
    );
  });
});

describe("createPermissionGate", () => {
  function memento() {
    const data = new Map<string, unknown>();
    return {
      get: <T>(key: string, fallback: T) => (data.has(key) ? (data.get(key) as T) : fallback),
      update: vi.fn(async (key: string, value: unknown) => void data.set(key, value)),
    };
  }

  it("asks once per command line and remembers a yes", async () => {
    const store = memento();
    const ask = vi.fn(async () => true);
    const allow = createPermissionGate(store, ask);
    expect(await allow(STDIO)).toBe(true);
    expect(ask).toHaveBeenCalledWith(STDIO, "uvx megane-builder-tools");
    expect(await allow({ ...STDIO, id: "same-command" })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // A different command is a different server.
    expect(await allow({ ...STDIO, args: ["--other"] })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("does not remember a no", async () => {
    const store = memento();
    const ask = vi.fn(async () => false);
    const allow = createPermissionGate(store, ask);
    expect(await allow(HTTP)).toBe(false);
    expect(await allow(HTTP)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(store.update).not.toHaveBeenCalled();
  });
});

/** A fake connected server. */
function fakeClient(overrides: Partial<ToolClient> = {}) {
  const state = { open: true };
  const client: ToolClient = {
    serverName: "megane-builder-tools",
    serverVersion: "0.1.0",
    get open() {
      return state.open;
    },
    listTools: vi.fn(async () => [{ name: "liquid_box" }]),
    callTool: vi.fn(async () => ({ structuredContent: { ok: 1 } })),
    close: vi.fn(async () => {
      state.open = false;
    }),
    ...overrides,
  };
  return { client, state };
}

describe("ToolServerPool", () => {
  it("shares one connection per server and closes it after the last release", async () => {
    const { client } = fakeClient();
    const factory = vi.fn(async () => client);
    const pool = new ToolServerPool(factory);
    const a = await pool.acquire(STDIO);
    const b = await pool.acquire({ ...STDIO });
    expect(a.client).toBe(client);
    expect(b.client).toBe(client);
    expect(factory).toHaveBeenCalledTimes(1);
    a.release();
    a.release(); // idempotent
    expect(client.close).not.toHaveBeenCalled();
    b.release();
    await Promise.resolve();
    expect(client.close).toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });

  it("starts a changed entry as a new server", async () => {
    const factory = vi.fn(async () => fakeClient().client);
    const pool = new ToolServerPool(factory);
    await pool.acquire(STDIO);
    await pool.acquire({ ...STDIO, args: ["--x"] });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(2);
  });

  it("replaces a connection whose server went away; the old holder releases the old one", async () => {
    const first = fakeClient();
    const second = fakeClient();
    const factory = vi
      .fn()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(second.client);
    const pool = new ToolServerPool(factory);
    const old = await pool.acquire(STDIO);
    first.state.open = false; // the process exited
    const fresh = await pool.acquire(STDIO);
    expect(fresh.client).toBe(second.client);
    old.release();
    await Promise.resolve();
    expect(second.client.close).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
    fresh.release();
    await Promise.resolve();
    expect(second.client.close).toHaveBeenCalled();
  });

  it("forgets a server that failed to start, so the next acquire retries", async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn uvx ENOENT"))
      .mockResolvedValueOnce(fakeClient().client);
    const pool = new ToolServerPool(factory);
    await expect(pool.acquire(STDIO)).rejects.toThrow("ENOENT");
    expect(pool.size).toBe(0);
    await pool.acquire(STDIO);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("closes everything on dispose", async () => {
    const { client } = fakeClient();
    const pool = new ToolServerPool(async () => client);
    await pool.acquire(STDIO);
    pool.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.close).toHaveBeenCalled();
    expect(pool.size).toBe(0);
  });
});

describe("BuilderToolsBridge", () => {
  function setup(
    options: {
      client?: ToolClient;
      allow?: boolean;
      servers?: ServerConfig[];
      problems?: string[];
    } = {},
  ) {
    const client = options.client ?? fakeClient().client;
    const factory = vi.fn(async () => client);
    const pool = new ToolServerPool(factory);
    const posted: BridgeReply[] = [];
    const deps: BridgeDeps = {
      servers: () => ({
        servers: options.servers ?? [STDIO, HTTP],
        problems: options.problems ?? [],
      }),
      pool,
      allow: vi.fn(async () => options.allow ?? true),
      post: (m) => void posted.push(m),
      openSettings: vi.fn(),
      log: vi.fn(),
    };
    const bridge = new BuilderToolsBridge(deps);
    /** Send a page message and let the bridge answer. */
    const send = async (message: unknown) => {
      const handled = bridge.handle(message);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return handled;
    };
    const replyTo = (requestId: number) =>
      posted.find((m) => m.type === "tools:reply" && m.requestId === requestId);
    return { bridge, deps, posted, send, replyTo, client, factory, pool };
  }

  it("ignores messages that are not bridge requests", async () => {
    const { send, posted } = setup();
    expect(await send({ type: "saveFile" })).toBe(false);
    expect(await send(null)).toBe(false);
    expect(posted).toEqual([]);
  });

  it("lists the configured servers and logs what is wrong with the setting", async () => {
    const { send, replyTo, deps } = setup({ problems: ['"x" needs a command'] });
    expect(await send({ type: "tools:servers", requestId: 1 })).toBe(true);
    expect(replyTo(1)).toEqual({
      type: "tools:reply",
      requestId: 1,
      ok: true,
      value: [toBridgeServer(STDIO), toBridgeServer(HTTP)],
    });
    expect(deps.log).toHaveBeenCalledWith('megane.builder.mcpServers: "x" needs a command');
  });

  it("connects after the user allows it, and lists the tools", async () => {
    const { send, replyTo, deps, factory } = setup();
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    expect(deps.allow).toHaveBeenCalledWith(STDIO);
    expect(replyTo(1)).toEqual({
      type: "tools:reply",
      requestId: 1,
      ok: true,
      value: {
        serverName: "megane-builder-tools",
        serverVersion: "0.1.0",
        tools: [{ name: "liquid_box" }],
      },
    });
    // Connecting again reuses the tab's connection.
    await send({ type: "tools:connect", requestId: 2, server: "tools" });
    expect(replyTo(2)).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown server, a server the user did not allow, and a failed start", async () => {
    const { send, replyTo } = setup({ allow: false });
    await send({ type: "tools:connect", requestId: 1, server: "nope" });
    expect(replyTo(1)).toMatchObject({
      ok: false,
      error: 'There is no tool server "nope" in megane.builder.mcpServers.',
    });
    await send({ type: "tools:connect", requestId: 2, server: "tools" });
    expect(replyTo(2)).toMatchObject({
      ok: false,
      error: 'Not allowed to use "tools" (uvx megane-builder-tools).',
    });

    const failing = setup();
    failing.factory.mockRejectedValueOnce(new Error("spawn uvx ENOENT"));
    await failing.send({ type: "tools:connect", requestId: 3, server: "tools" });
    expect(failing.replyTo(3)).toMatchObject({ ok: false, error: "spawn uvx ENOENT" });
    failing.factory.mockRejectedValueOnce("odd");
    await failing.send({ type: "tools:connect", requestId: 4, server: "tools" });
    expect(failing.replyTo(4)).toMatchObject({ ok: false, error: "odd" });
  });

  it("relays a call with its progress and result", async () => {
    const { client } = fakeClient({
      callTool: vi.fn(async (_n, _a, o) => {
        o.onProgress(1, 2, "packing");
        return { structuredContent: { atoms: 3 } };
      }),
    });
    const { send, posted, replyTo } = setup({ client });
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    await send({
      type: "tools:call",
      requestId: 2,
      server: "tools",
      name: "liquid_box",
      arguments: { seed: 1 },
      timeoutMs: 1000,
    });
    expect(client.callTool).toHaveBeenCalledWith(
      "liquid_box",
      { seed: 1 },
      expect.objectContaining({ timeoutMs: 1000 }),
    );
    expect(posted).toContainEqual({
      type: "tools:progress",
      requestId: 2,
      progress: 1,
      total: 2,
      message: "packing",
    });
    expect(replyTo(2)).toEqual({
      type: "tools:reply",
      requestId: 2,
      ok: true,
      value: { structuredContent: { atoms: 3 } },
    });
  });

  it("refuses a call to a server the tab is not connected to, and reports a failed call", async () => {
    const { client } = fakeClient({
      callTool: vi.fn(async () => {
        throw new Error("Request timed out");
      }),
    });
    const { send, replyTo } = setup({ client });
    await send({
      type: "tools:call",
      requestId: 1,
      server: "tools",
      name: "x",
      arguments: {},
      timeoutMs: 1,
    });
    expect(replyTo(1)).toMatchObject({ ok: false, error: 'Not connected to "tools".' });
    await send({ type: "tools:connect", requestId: 2, server: "tools" });
    await send({
      type: "tools:call",
      requestId: 3,
      server: "tools",
      name: "x",
      arguments: {},
      timeoutMs: 1,
    });
    expect(replyTo(3)).toMatchObject({ ok: false, error: "Request timed out" });
  });

  it("cancels a call and stops relaying its progress", async () => {
    let signal!: AbortSignal;
    let progress!: (p: number) => void;
    const { client } = fakeClient({
      callTool: vi.fn(
        (_n, _a, o) =>
          new Promise((_resolve, reject) => {
            signal = o.signal;
            progress = (p) => o.onProgress(p);
            o.signal.addEventListener("abort", () => reject(new Error("AbortError")));
          }),
      ),
    });
    const { send, posted, replyTo } = setup({ client });
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    await send({
      type: "tools:call",
      requestId: 2,
      server: "tools",
      name: "x",
      arguments: {},
      timeoutMs: 1,
    });
    await send({ type: "tools:cancel", requestId: 2 });
    expect(signal.aborted).toBe(true);
    progress(5);
    expect(posted.some((m) => m.type === "tools:progress")).toBe(false);
    expect(replyTo(2)).toMatchObject({ ok: false, error: "Cancelled." });
    await send({ type: "tools:cancel", requestId: 99 }); // unknown: nothing to do
  });

  it("disconnect releases the tab's connection and cancels its calls", async () => {
    let signal!: AbortSignal;
    const { client } = fakeClient({
      callTool: vi.fn(
        (_n, _a, o) =>
          new Promise(() => {
            signal = o.signal;
          }),
      ),
    });
    const { send, pool } = setup({ client });
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    await send({
      type: "tools:call",
      requestId: 2,
      server: "tools",
      name: "x",
      arguments: {},
      timeoutMs: 1,
    });
    await send({ type: "tools:disconnect", server: "tools" });
    expect(signal.aborted).toBe(true);
    expect(pool.size).toBe(0);
    expect(client.close).toHaveBeenCalled();
    await send({ type: "tools:disconnect", server: "tools" }); // already gone
  });

  it("reconnects when the setting changed the server", async () => {
    const servers = [STDIO];
    const first = fakeClient().client;
    const second = fakeClient().client;
    const { send, deps, factory } = setup({ servers });
    factory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    servers[0] = { ...STDIO, args: ["--new"] };
    deps.servers = () => ({ servers, problems: [] });
    await send({ type: "tools:connect", requestId: 2, server: "tools" });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
  });

  it("opens the settings", async () => {
    const { send, deps } = setup();
    await send({ type: "tools:openSettings" });
    expect(deps.openSettings).toHaveBeenCalled();
  });

  it("dispose cancels, releases, and stops answering", async () => {
    let signal!: AbortSignal;
    const { client } = fakeClient({
      callTool: vi.fn(
        (_n, _a, o) =>
          new Promise((_r, reject) => {
            signal = o.signal;
            o.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    const { bridge, send, posted, pool } = setup({ client });
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    await send({
      type: "tools:call",
      requestId: 2,
      server: "tools",
      name: "x",
      arguments: {},
      timeoutMs: 1,
    });
    const before = posted.length;
    bridge.dispose();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(pool.size).toBe(0);
    expect(posted.length).toBe(before);
  });

  it("releases a connection that finishes starting after the tab closed", async () => {
    let finish!: (c: ToolClient) => void;
    const late = fakeClient().client;
    const { bridge, send, replyTo, factory, pool } = setup();
    factory.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    await send({ type: "tools:connect", requestId: 1, server: "tools" });
    bridge.dispose();
    finish(late);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(replyTo(1)).toBeUndefined();
    expect(pool.size).toBe(0);
    expect(late.close).toHaveBeenCalled();
  });
});
