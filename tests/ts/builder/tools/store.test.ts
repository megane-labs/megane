import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_TOOL_SERVER_URL,
  TOOLS_STORAGE_KEY,
  applyResult,
  createToolsStore,
  readLaunchParams,
  readStoredUrl,
  recordedArguments,
} from "@/builder/tools/store";
import { createBuilderStore } from "@/builder/store";
import { parseResult, parseTools, type BuilderToolInfo } from "@/builder/tools/contract";
import type { CallOptions, CallOutcome, ToolConnection } from "@/builder/tools/client";
import { CALLS, TOOLS } from "./fixtures";

const tools = Object.fromEntries(parseTools(TOOLS).tools.map((t) => [t.name, t])) as Record<
  string,
  BuilderToolInfo
>;

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
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

function fakeConnection(
  call: (name: string, args: Record<string, unknown>, o: CallOptions) => Promise<CallOutcome>,
): ToolConnection {
  return {
    serverName: "fake",
    serverVersion: "1.0",
    listing: parseTools(TOOLS),
    call,
    close: vi.fn(async () => undefined),
  };
}

const recorded = (name: string): CallOutcome => ({
  ok: true,
  result: parseResult(CALLS[name].result.structuredContent),
  summary: `${name} done.`,
});

function setup(call = async (name: string) => recorded(name), storage = memoryStorage()) {
  const builder = createBuilderStore();
  const connection = fakeConnection(call);
  const connector = vi.fn(async () => connection);
  const store = createToolsStore({ connector, builder, storage });
  return { builder, store, connection, connector, storage };
}

describe("storage and launch parameters", () => {
  it("remembers the URL only", () => {
    expect(readStoredUrl(null)).toBe(DEFAULT_TOOL_SERVER_URL);
    expect(readStoredUrl(memoryStorage({ [TOOLS_STORAGE_KEY]: "{bad" }))).toBe(
      DEFAULT_TOOL_SERVER_URL,
    );
    expect(readStoredUrl(memoryStorage({ [TOOLS_STORAGE_KEY]: '{"url": 3}' }))).toBe(
      DEFAULT_TOOL_SERVER_URL,
    );
    expect(readStoredUrl(memoryStorage({ [TOOLS_STORAGE_KEY]: '{"url":"http://h/mcp"}' }))).toBe(
      "http://h/mcp",
    );
  });

  it("reads #tools=…&token=…", () => {
    expect(readLaunchParams("")).toBeNull();
    expect(readLaunchParams("#tools=http%3A%2F%2Fh%2Fmcp&token=t")).toEqual({
      url: "http://h/mcp",
      token: "t",
    });
    expect(readLaunchParams("#tools=http://h/mcp")).toEqual({ url: "http://h/mcp", token: "" });
  });

  it("records the document by size", () => {
    expect(recordedArguments(tools.solvate, { document: { elements: [1, 2] }, seed: 1 })).toEqual({
      document: { atoms: 2 },
      seed: 1,
    });
    expect(recordedArguments(tools.solvate, { document: null })).toEqual({
      document: { atoms: 0 },
    });
    expect(recordedArguments(tools.liquid_box, { seed: 1 })).toEqual({ seed: 1 });
  });
});

describe("connect / disconnect", () => {
  it("connects, stores the URL and closes the previous connection", async () => {
    const { store, connector, storage, connection } = setup();
    store.getState().setUrl(" http://h/mcp ");
    store.getState().setToken(" tok ");
    await store.getState().connect();
    expect(connector).toHaveBeenCalledWith("http://h/mcp", "tok");
    expect(store.getState().status).toBe("connected");
    expect(readStoredUrl(storage)).toBe("http://h/mcp");
    await store.getState().connect();
    expect(connection.close).toHaveBeenCalledTimes(1);
    await store.getState().disconnect();
    expect(store.getState()).toMatchObject({ status: "idle", connection: null });
  });

  it("reports connection failures", async () => {
    const builder = createBuilderStore();
    const store = createToolsStore({
      connector: async () => {
        throw new Error("refused");
      },
      builder,
      storage: null,
    });
    await store.getState().connect();
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toContain("refused");
  });
});

describe("run", () => {
  it("opens a new document for new_document tools and records provenance", async () => {
    const { store, builder } = setup();
    await store.getState().connect();
    store.getState().openForm(tools.liquid_box);
    const outcome = await store.getState().run(tools.liquid_box, CALLS.liquid_box.arguments);
    expect(outcome.ok).toBe(true);
    const b = builder.getState();
    expect(b.result!.snapshot.nAtoms).toBe(300);
    expect(b.fileName).toMatch(/^water/);
    expect(b.sourceLabels![0]).toMatch(/^WATE/);
    expect(b.notice?.text).toBe("liquid_box done.");
    const s = store.getState();
    expect(s.openTool).toBeNull();
    expect(s.running).toBeNull();
    expect(s.applied[0]).toMatchObject({
      tool: "liquid_box",
      contract: 1,
      atoms: 300,
      server: { name: "fake" },
    });
  });

  it("inserts into the open document as one undo step", async () => {
    const { store, builder } = setup();
    builder.getState().newCell(20);
    await store.getState().connect();
    const outcome = await store.getState().run(tools.solvate, { document: { elements: [] } });
    expect(outcome.ok).toBe(true);
    const b = builder.getState();
    const added = parseResult(CALLS.solvate.result.structuredContent).structure.elements.length;
    expect(b.result!.snapshot.nAtoms).toBe(added);
    expect(b.selected.length).toBe(added);
    expect(b.edits.map((e) => e.op)).toEqual(["add_fragment"]);
    b.undo();
    expect(builder.getState().result!.snapshot.nAtoms).toBe(0);
    expect(store.getState().applied[0].arguments).toEqual({ document: { atoms: 0 } });
  });

  it("keeps errors in the form", async () => {
    const { store, builder } = setup(async () => ({ ok: false, error: "no room" }));
    expect(await store.getState().run(tools.liquid_box, {})).toEqual({
      ok: false,
      error: "Not connected to a tool server.",
    });
    await store.getState().connect();
    store.getState().openForm(tools.solvate);
    expect(await store.getState().run(tools.liquid_box, {})).toEqual({
      ok: false,
      error: "no room",
    });
    expect(await store.getState().run(tools.solvate, {})).toEqual({ ok: false, error: "no room" });
    expect(store.getState().openTool).toBe(tools.solvate);

    const insertNoDoc = setup();
    await insertNoDoc.store.getState().connect();
    const r = await insertNoDoc.store.getState().run(tools.solvate, {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Open a structure");
    expect(builder.getState().notice).toBeNull();
  });

  it("tracks progress, cancels, and discards a late result", async () => {
    let release!: () => void;
    const seen: (number | null)[] = [];
    const { store, builder } = setup(async (name, _args, options) => {
      options.onProgress?.(0.5, "half");
      seen.push(store.getState().running?.fraction ?? null);
      await new Promise<void>((r) => (release = r));
      return recorded(name);
    });
    await store.getState().connect();
    const pending = store.getState().run(tools.liquid_box, {});
    await Promise.resolve();
    expect(seen).toEqual([0.5]);
    expect(store.getState().running?.message).toBe("half");
    store.getState().openForm(tools.liquid_box);
    store.getState().closeForm();
    expect(store.getState().openTool).toBe(tools.liquid_box);
    store.getState().cancel();
    release();
    expect(await pending).toEqual({ ok: false, error: "Cancelled." });
    expect(store.getState().running).toBeNull();
    expect(builder.getState().source).toBeNull();
    store.getState().closeForm();
    expect(store.getState().openTool).toBeNull();
  });

  it("warnings join the notice", async () => {
    const { store, builder } = setup(async (name) => {
      const out = recorded(name) as Extract<CallOutcome, { ok: true }>;
      return { ...out, summary: null, result: { ...out.result, warnings: ["careful"] } };
    });
    await store.getState().connect();
    await store.getState().run(tools.polymer_chain, {});
    expect(builder.getState().notice?.text).toMatch(/^Polymer chain: added \d+ atoms\. careful$/);
  });

  it("applyResult refuses to insert while the original is previewed", () => {
    const builder = createBuilderStore();
    builder.getState().newCell(10);
    builder.getState().setShowOriginal(true);
    expect(() =>
      applyResult(builder, tools.solvate, parseResult(CALLS.solvate.result.structuredContent)),
    ).toThrow("Open a structure");
  });
});
