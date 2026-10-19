// @vitest-environment node
/**
 * The VS Code binding of the Builder's tool bridge: servers from the
 * `megane.builder.mcpServers` setting, the permission modal, the output
 * channel, and *Configure tool servers…*. Connects to a real (minimal) MCP
 * server over stdio end to end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  setting: undefined as unknown,
  folder: "/ws",
  answer: "Allow" as string | undefined,
  lines: [] as string[],
  channels: 0,
  warnings: [] as unknown[][],
  commands: [] as unknown[][],
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string) =>
        section === "megane.builder" && key === "mcpServers" ? state.setting : undefined,
    }),
    get workspaceFolders() {
      return [{ uri: { fsPath: state.folder } }];
    },
  },
  window: {
    createOutputChannel: vi.fn(() => {
      state.channels += 1;
      return { appendLine: (line: string) => state.lines.push(line), dispose: vi.fn() };
    }),
    showWarningMessage: vi.fn(async (...args: unknown[]) => {
      state.warnings.push(args);
      return args.length > 2 ? state.answer : undefined;
    }),
  },
  commands: {
    executeCommand: vi.fn(async (...args: unknown[]) => void state.commands.push(args)),
  },
}));

import {
  createBuilderToolsHost,
  permissionDetail,
} from "../../../vscode-megane/src/builderToolsHost";
import type { BridgeReply } from "@/builder/tools/bridgeProtocol";

const SERVER = join(__dirname, "fixtures", "fakeMcpServer.mjs");
/** No program is installed: no default server (tests that are not about it). */
const none = () => null;

function memento() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T) => (data.has(key) ? (data.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void data.set(key, value),
  };
}

function tab() {
  const posted: BridgeReply[] = [];
  const webview = { postMessage: vi.fn(async (m: BridgeReply) => posted.push(m)) };
  const reply = (requestId: number) =>
    posted.find((m) => m.type === "tools:reply" && m.requestId === requestId) as
      | (BridgeReply & { ok: boolean; value?: unknown; error?: string })
      | undefined;
  return { webview, posted, reply };
}

beforeEach(() => {
  state.setting = undefined;
  state.folder = "/ws";
  state.answer = "Allow";
  state.lines = [];
  state.channels = 0;
  state.warnings = [];
  state.commands = [];
});

describe("createBuilderToolsHost", () => {
  it("lists the setting's servers and warns once about a broken entry", async () => {
    state.setting = {
      fake: { command: "node", args: ["${workspaceFolder}/tools.mjs"] },
      broken: { args: [] },
    };
    const host = createBuilderToolsHost({ globalState: memento() } as never, none);
    const { webview, reply } = tab();
    const bridge = host.bridgeFor(webview as never);
    bridge.handle({ type: "tools:servers", requestId: 1 });
    bridge.handle({ type: "tools:servers", requestId: 2 });
    await vi.waitFor(() => expect(reply(2)).toBeTruthy());
    expect(reply(1)!.value).toEqual([
      { id: "fake", kind: "stdio", description: "node /ws/tools.mjs" },
    ]);
    expect(state.warnings).toEqual([
      ['megane.builder.mcpServers: "broken" needs a command (stdio) or a url (Streamable HTTP)'],
    ]);
    expect(state.lines).toContain(
      'megane.builder.mcpServers: "broken" needs a command (stdio) or a url (Streamable HTTP)',
    );
    host.dispose();
  });

  it("asks before running a server, then connects and calls it through the SDK", async () => {
    state.setting = { fake: { command: process.execPath, args: [SERVER] } };
    state.folder = __dirname;
    const globalState = memento();
    const host = createBuilderToolsHost({ globalState } as never, none);
    const { webview, reply, posted } = tab();
    const bridge = host.bridgeFor(webview as never);
    bridge.handle({ type: "tools:connect", requestId: 1, server: "fake" });
    await vi.waitFor(() => expect(reply(1)).toBeTruthy(), { timeout: 10_000 });
    expect(reply(1)).toMatchObject({
      ok: true,
      value: { serverName: "fake-tools", serverVersion: "9.9" },
    });
    const [question, options, button] = state.warnings[0] as [
      string,
      { modal: boolean; detail: string },
      string,
    ];
    expect(question).toBe('Allow the tool server "fake"?');
    expect(options.modal).toBe(true);
    expect(options.detail).toContain(`${process.execPath} ${SERVER}`);
    expect(button).toBe("Allow");

    bridge.handle({
      type: "tools:call",
      requestId: 2,
      server: "fake",
      name: "echo",
      arguments: { seed: 1 },
      timeoutMs: 10_000,
    });
    await vi.waitFor(() => expect(reply(2)).toBeTruthy(), { timeout: 10_000 });
    expect(reply(2)).toMatchObject({
      ok: true,
      value: { structuredContent: { arguments: { seed: 1 } } },
    });
    expect(posted).toContainEqual({
      type: "tools:progress",
      requestId: 2,
      progress: 1,
      total: 2,
      message: "half",
    });
    // The server's stderr is in the output channel, created on first use.
    await vi.waitFor(() =>
      expect(state.lines.join("\n")).toContain(`fake-tools started in ${__dirname}`),
    );
    expect(state.channels).toBe(1);

    // A second tab reuses the permission and the running server.
    const second = tab();
    const other = host.bridgeFor(second.webview as never);
    other.handle({ type: "tools:connect", requestId: 1, server: "fake" });
    await vi.waitFor(() => expect(second.reply(1)).toBeTruthy(), { timeout: 10_000 });
    expect(second.reply(1)).toMatchObject({ ok: true });
    expect(state.warnings.length).toBe(1);
    bridge.dispose();
    other.dispose();
    host.dispose();
  });

  it("does not run a server the user did not allow", async () => {
    state.setting = { fake: { command: process.execPath, args: [SERVER] } };
    state.answer = undefined;
    const host = createBuilderToolsHost({ globalState: memento() } as never, none);
    const { webview, reply } = tab();
    host
      .bridgeFor(webview as never)
      .handle({ type: "tools:connect", requestId: 1, server: "fake" });
    await vi.waitFor(() => expect(reply(1)).toBeTruthy());
    expect(reply(1)).toMatchObject({ ok: false, error: expect.stringContaining("Not allowed") });
    expect(state.channels).toBe(0);
    host.dispose();
  });

  it("offers the reference server without a setting, unless one replaces or hides it", async () => {
    const find = (name: string) => (name === "uvx" ? "/home/me/.local/bin/uvx" : null);
    const host = createBuilderToolsHost({ globalState: memento() } as never, find);
    const list = async (setting: unknown) => {
      state.setting = setting;
      const { webview, reply } = tab();
      host.bridgeFor(webview as never).handle({ type: "tools:servers", requestId: 1 });
      await vi.waitFor(() => expect(reply(1)).toBeTruthy());
      return reply(1)!.value as { id: string; description: string }[];
    };
    const [reference] = await list(undefined);
    expect(reference.id).toBe("megane-builder-tools");
    expect(reference.description).toMatch(
      /^\/home\/me\/\.local\/bin\/uvx --from git\+https:\/\/github\.com\/hodakamori\/megane-builder-tools@[0-9a-f]{40} megane-builder-tools$/,
    );
    expect((await list({ mine: { command: "x" } })).map((s) => s.id)).toEqual([
      "megane-builder-tools",
      "mine",
    ]);
    expect(await list({ "megane-builder-tools": { command: "/opt/tools" } })).toEqual([
      expect.objectContaining({ id: "megane-builder-tools", description: "/opt/tools" }),
    ]);
    expect(await list({ "megane-builder-tools": null })).toEqual([]);
    expect(state.warnings).toEqual([]);
    host.dispose();
  });

  it("opens the setting", async () => {
    const host = createBuilderToolsHost({ globalState: memento() } as never, none);
    host.bridgeFor(tab().webview as never).handle({ type: "tools:openSettings" });
    await vi.waitFor(() => expect(state.commands.length).toBe(1));
    expect(state.commands[0]).toEqual([
      "workbench.action.openSettings",
      "megane.builder.mcpServers",
    ]);
    host.dispose();
  });

  it("explains what allowing a server means", () => {
    expect(
      permissionDetail({ id: "a", kind: "stdio", command: "x", args: [], env: {} }, "x"),
    ).toContain("run this command on your computer");
    expect(
      permissionDetail({ id: "b", kind: "http", url: "https://h", headers: {} }, "https://h"),
    ).toContain("send the structures");
  });
});
