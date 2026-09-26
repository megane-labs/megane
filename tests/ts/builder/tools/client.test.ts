import { describe, it, expect, vi, beforeEach } from "vitest";
import { connectToolServer, errorMessage, firstText, interpretCall } from "@/builder/tools/client";
import { CALLS, TOOLS } from "./fixtures";

const sdk = vi.hoisted(() => ({
  instances: [] as FakeClient[],
  transports: [] as { url: URL; options: { requestInit: { headers: Record<string, string> } } }[],
  callImpl: null as
    | null
    | ((params: unknown, options: Record<string, unknown>) => Promise<unknown>),
  serverVersion: { name: "fake-tools", version: "9.9" } as
    | { name?: string; version?: string }
    | undefined,
}));

class FakeClient {
  closed = false;
  constructor(public info: unknown) {
    sdk.instances.push(this);
  }
  async connect() {}
  async listTools(params?: { cursor?: string }) {
    return params?.cursor
      ? { tools: TOOLS.slice(1) }
      : { tools: TOOLS.slice(0, 1), nextCursor: "page-2" };
  }
  getServerVersion() {
    return sdk.serverVersion;
  }
  callTool(params: unknown, options: Record<string, unknown>) {
    return sdk.callImpl!(params, options);
  }
  async close() {
    this.closed = true;
  }
}

vi.mock("@modelcontextprotocol/client", () => ({
  Client: FakeClient,
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: never) {
      sdk.transports.push({ url, options });
    }
  },
}));

beforeEach(() => {
  sdk.instances.length = 0;
  sdk.transports.length = 0;
  sdk.serverVersion = { name: "fake-tools", version: "9.9" };
});

describe("interpretCall", () => {
  it("parses a recorded result", () => {
    const outcome = interpretCall(CALLS.liquid_box.result);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.structure.elements.length).toBe(300);
      expect(outcome.summary).toContain("Liquid box");
    }
  });

  it("reports tool errors and invalid results", () => {
    expect(interpretCall({ isError: true, content: [{ type: "text", text: " nope " }] })).toEqual({
      ok: false,
      error: "nope",
    });
    expect(interpretCall({ isError: true })).toEqual({
      ok: false,
      error: "The tool reported an error.",
    });
    const bad = interpretCall({ structuredContent: { contract: 1 } });
    expect(bad).toEqual({
      ok: false,
      error: "The tool returned an invalid result: structure is missing",
    });
  });

  it("helpers", () => {
    expect(firstText({ content: [{ type: "image" }, { type: "text", text: "hi" }] })).toBe("hi");
    expect(firstText({})).toBeNull();
    expect(errorMessage(new Error("x"))).toBe("x");
    expect(errorMessage("y")).toBe("y");
  });
});

describe("connectToolServer", () => {
  it("connects with the token, pages through tools/list and calls tools", async () => {
    const progress: [number | null, string | null][] = [];
    sdk.callImpl = async (params, options) => {
      const onprogress = options.onprogress as (p: {
        progress: number;
        total?: number;
        message?: string;
      }) => void;
      onprogress({ progress: 1, total: 4, message: "packing" });
      onprogress({ progress: 3 });
      expect(params).toEqual({ name: "liquid_box", arguments: { seed: 1 } });
      expect(options.timeout).toBe(1234);
      return CALLS.liquid_box.result;
    };
    const conn = await connectToolServer("http://127.0.0.1:8765/mcp", "secret");
    expect(sdk.transports[0].url.href).toBe("http://127.0.0.1:8765/mcp");
    expect(sdk.transports[0].options.requestInit.headers).toEqual({
      Authorization: "Bearer secret",
    });
    expect(conn.serverName).toBe("fake-tools");
    expect(conn.serverVersion).toBe("9.9");
    expect(conn.listing.tools.map((t) => t.name)).toEqual([
      "liquid_box",
      "polymer_chain",
      "solvate",
    ]);

    const outcome = await conn.call(
      "liquid_box",
      { seed: 1 },
      { timeoutMs: 1234, onProgress: (f, m) => progress.push([f, m]) },
    );
    expect(outcome.ok).toBe(true);
    expect(progress).toEqual([
      [0.25, "packing"],
      [null, null],
    ]);
    await conn.close();
    expect(sdk.instances[0].closed).toBe(true);
  });

  it("turns failures into outcomes and names the host when the server is anonymous", async () => {
    sdk.serverVersion = undefined;
    const conn = await connectToolServer("http://localhost:9/mcp", "");
    expect(conn.serverName).toBe("localhost:9");
    expect(conn.serverVersion).toBeNull();
    expect(sdk.transports[0].options.requestInit.headers).toEqual({});

    sdk.callImpl = async () => {
      throw new Error("socket closed");
    };
    expect(await conn.call("x", {}, { timeoutMs: 1 })).toEqual({
      ok: false,
      error: "The server failed: socket closed",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await conn.call("x", {}, { timeoutMs: 1, signal: controller.signal })).toEqual({
      ok: false,
      error: "Cancelled.",
    });
  });
});
