/**
 * The JupyterLab Builder's tool bridge: the WebSocket to megane's Jupyter
 * server extension, and asking once before a server is first used.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ALLOWED_SERVERS_KEY,
  CONFIG_HINT,
  LOST_CONNECTION,
  createJupyterToolBridge,
  createSocketPort,
  permissionBody,
  toolsSocketUrl,
} from "../../../jupyterlab-megane/src/builder/tools";
import type { BridgePort } from "@/builder/tools/bridge";
import type { BridgeRequest } from "@/builder/tools/bridgeProtocol";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const settings = (overrides = {}) => ({
  wsUrl: "ws://127.0.0.1:8888/lab-base/",
  token: "t k",
  WebSocket: FakeSocket as unknown as typeof WebSocket,
  ...overrides,
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

describe("toolsSocketUrl", () => {
  it("joins the server's WebSocket URL and adds the token as JupyterLab does", () => {
    expect(toolsSocketUrl(settings())).toBe(
      "ws://127.0.0.1:8888/lab-base/megane/builder-tools/ws?token=t%20k",
    );
    expect(toolsSocketUrl(settings({ wsUrl: "ws://h", token: "" }))).toBe(
      "ws://h/megane/builder-tools/ws",
    );
    expect(toolsSocketUrl(settings({ appendToken: false }))).not.toContain("token");
  });
});

describe("createSocketPort", () => {
  it("opens on first use, queues until open, and delivers the server's messages", () => {
    FakeSocket.instances = [];
    const port = createSocketPort(settings());
    const received: unknown[] = [];
    const stop = port.listen((m) => received.push(m));
    port.post({ type: "tools:servers", requestId: 1 });
    port.post({ type: "tools:openSettings" });
    const socket = FakeSocket.instances[0];
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent.map((t) => JSON.parse(t).type)).toEqual([
      "tools:servers",
      "tools:openSettings",
    ]);
    port.post({ type: "tools:disconnect", server: "x" });
    expect(socket.sent).toHaveLength(3);
    socket.receive({ type: "tools:reply", requestId: 1, ok: true, value: [] });
    socket.receive("not json");
    expect(received).toEqual([{ type: "tools:reply", requestId: 1, ok: true, value: [] }]);
    stop();
    socket.receive({ type: "tools:progress", requestId: 1, progress: 1 });
    expect(received).toHaveLength(1);
  });

  it("answers what was still waiting when the socket closes, then opens a new one", () => {
    FakeSocket.instances = [];
    const port = createSocketPort(settings());
    const received: { requestId?: number; error?: string }[] = [];
    port.listen((m) => received.push(m as never));
    port.post({ type: "tools:servers", requestId: 1 });
    port.post({ type: "tools:connect", requestId: 2, server: "x" });
    port.post({ type: "tools:cancel", requestId: 2 });
    const first = FakeSocket.instances[0];
    first.open();
    first.receive({ type: "tools:reply", requestId: 1, ok: true, value: [] });
    first.close();
    expect(received.slice(1)).toEqual([
      { type: "tools:reply", requestId: 2, ok: false, error: LOST_CONNECTION },
    ]);
    port.post({ type: "tools:servers", requestId: 3 });
    expect(FakeSocket.instances).toHaveLength(2);
    // A socket that is replaced closing late does not drop the new one.
    first.close();
    port.post({ type: "tools:servers", requestId: 4 });
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

/** A host that answers listings with `servers` and connects to anything. */
function fakeHost(servers: unknown[]) {
  const sent: BridgeRequest[] = [];
  let handler: (m: unknown) => void = () => {};
  const port: BridgePort = {
    post: (message) => {
      sent.push(message);
      const requestId = (message as { requestId?: number }).requestId;
      if (message.type === "tools:servers") {
        queueMicrotask(() => handler({ type: "tools:reply", requestId, ok: true, value: servers }));
      } else if (message.type === "tools:connect") {
        queueMicrotask(() =>
          handler({
            type: "tools:reply",
            requestId,
            ok: true,
            value: { serverName: "s", serverVersion: null, tools: [] },
          }),
        );
      }
    },
    listen: (h) => {
      handler = h;
      return () => {};
    },
  };
  return { port, sent };
}

describe("createJupyterToolBridge", () => {
  const TOOLS = {
    id: "tools",
    kind: "stdio" as const,
    description: "megane-builder-tools",
    fingerprint: "fp-1",
  };

  it("asks once per fingerprint before connecting, and remembers a yes", async () => {
    const { port, sent } = fakeHost([TOOLS]);
    const storage = memoryStorage();
    const confirm = vi.fn(async () => true);
    const bridge = createJupyterToolBridge(settings(), { confirm, storage, port });
    expect(bridge.configHint).toBe(CONFIG_HINT);
    await bridge.connect("tools");
    await bridge.connect("tools");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(TOOLS);
    expect(JSON.parse(storage.getItem(ALLOWED_SERVERS_KEY)!)).toEqual(["fp-1"]);
    expect(sent.filter((m) => m.type === "tools:connect")).toHaveLength(2);
  });

  it("does not connect when the user says no, and asks again next time", async () => {
    const { port, sent } = fakeHost([{ ...TOOLS, fingerprint: undefined }]);
    const confirm = vi.fn(async () => false);
    const bridge = createJupyterToolBridge(settings(), { confirm, storage: null, port });
    await expect(bridge.connect("tools")).rejects.toThrow(
      'Not allowed to use "tools" (megane-builder-tools).',
    );
    await expect(bridge.connect("tools")).rejects.toThrow("Not allowed");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(sent.some((m) => m.type === "tools:connect")).toBe(false);
  });

  it("leaves an unknown server to the Jupyter server, and survives broken storage", async () => {
    const { port, sent } = fakeHost([]);
    const broken = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("quota");
      },
    } as unknown as Storage;
    const confirm = vi.fn(async () => true);
    const bridge = createJupyterToolBridge(settings(), { confirm, storage: broken, port });
    await bridge.connect("nope");
    expect(confirm).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === "tools:connect")).toBe(true);

    const other = createJupyterToolBridge(settings(), {
      confirm,
      storage: broken,
      port: fakeHost([TOOLS]).port,
    });
    await other.connect("tools");
    expect(confirm).toHaveBeenCalledTimes(1);
    const notList = {
      getItem: () => '{"a":1}',
      setItem: () => {},
    } as unknown as Storage;
    await createJupyterToolBridge(settings(), {
      confirm,
      storage: notList,
      port: fakeHost([TOOLS]).port,
    }).connect("tools");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("opens its own socket when not given a port", () => {
    FakeSocket.instances = [];
    const bridge = createJupyterToolBridge(settings(), { confirm: vi.fn(), storage: null });
    void bridge.listServers();
    expect(FakeSocket.instances[0].url).toContain("megane/builder-tools/ws");
  });
});

describe("permissionBody", () => {
  it("says what runs or where structures go", () => {
    expect(permissionBody({ id: "a", kind: "stdio", description: "uvx t" })).toContain(
      "run this command on the Jupyter server's machine",
    );
    expect(permissionBody({ id: "b", kind: "http", description: "https://h/mcp" })).toContain(
      "send the structures you build with its tools to https://h/mcp",
    );
  });
});
