import { describe, it, expect, vi } from "vitest";
import { createMessageBridge, type BridgePort } from "@/builder/tools/bridge";
import { isBridgeRequest, type BridgeRequest } from "@/builder/tools/bridgeProtocol";
import { CALLS, TOOLS } from "./fixtures";

/** A host that records the page's requests and answers when told to. */
function fakeHost() {
  const sent: BridgeRequest[] = [];
  let handler: ((message: unknown) => void) | null = null;
  const stop = vi.fn();
  const port: BridgePort = {
    post: (message) => void sent.push(message),
    listen: (h) => {
      handler = h;
      return stop;
    },
  };
  const last = () => sent[sent.length - 1] as BridgeRequest & { requestId: number };
  const send = (message: unknown) => handler!(message);
  const reply = (value: unknown, requestId = last().requestId) =>
    send({ type: "tools:reply", requestId, ok: true, value });
  const fail = (error: string, requestId = last().requestId) =>
    send({ type: "tools:reply", requestId, ok: false, error });
  return { port, sent, last, send, reply, fail };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function connected(host = fakeHost()) {
  const bridge = createMessageBridge(host.port, { configHint: "the setting" });
  const pending = bridge.connect("tools");
  await flush();
  host.reply({ serverName: "megane-builder-tools", serverVersion: "0.1.0", tools: TOOLS });
  return { host, bridge, connection: await pending };
}

describe("createMessageBridge", () => {
  it("lists the host's servers", async () => {
    const host = fakeHost();
    const bridge = createMessageBridge(host.port, { configHint: "the setting" });
    expect(bridge.configHint).toBe("the setting");
    expect(bridge.openSettings).toBeUndefined();
    const listing = bridge.listServers();
    expect(host.last()).toEqual({ type: "tools:servers", requestId: 1 });
    host.reply([{ id: "a", kind: "stdio", description: "uvx a" }]);
    expect(await listing).toEqual([{ id: "a", kind: "stdio", description: "uvx a" }]);
  });

  it("connects through the host and parses the tools as a direct connection does", async () => {
    const { host, connection } = await connected();
    expect(host.sent[0]).toEqual({ type: "tools:connect", requestId: 1, server: "tools" });
    expect(connection.serverName).toBe("megane-builder-tools");
    expect(connection.serverVersion).toBe("0.1.0");
    expect(connection.listing.tools.map((t) => t.name)).toEqual([
      "liquid_box",
      "polymer_chain",
      "solvate",
    ]);
    await connection.close();
    expect(host.last()).toEqual({ type: "tools:disconnect", server: "tools" });
  });

  it("falls back to the server id when the server does not name itself", async () => {
    const host = fakeHost();
    const bridge = createMessageBridge(host.port, { configHint: "x" });
    const pending = bridge.connect("lab");
    host.reply({ serverName: "", tools: [] });
    const connection = await pending;
    expect(connection.serverName).toBe("lab");
    expect(connection.serverVersion).toBeNull();
  });

  it("rejects a connect the host refuses", async () => {
    const host = fakeHost();
    const bridge = createMessageBridge(host.port, { configHint: "x" });
    const pending = bridge.connect("lab");
    host.fail("spawn uvx ENOENT");
    await expect(pending).rejects.toThrow("spawn uvx ENOENT");
    const again = bridge.connect("lab");
    host.send({ type: "tools:reply", requestId: host.last().requestId, ok: false });
    await expect(again).rejects.toThrow("The host reported an error.");
  });

  it("calls a tool, relays progress, and interprets the result", async () => {
    const { host, connection } = await connected();
    const onProgress = vi.fn();
    const call = connection.call("liquid_box", { seed: 1 }, { onProgress, timeoutMs: 5000 });
    expect(host.last()).toEqual({
      type: "tools:call",
      requestId: 2,
      server: "tools",
      name: "liquid_box",
      arguments: { seed: 1 },
      timeoutMs: 5000,
    });
    host.send({ type: "tools:progress", requestId: 2, progress: 1, total: 4, message: "packing" });
    host.send({ type: "tools:progress", requestId: 2, progress: 3 });
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.25, "packing");
    expect(onProgress).toHaveBeenNthCalledWith(2, null, null);
    host.reply(CALLS.liquid_box.result);
    const outcome = await call;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.structure.elements.length).toBe(300);
  });

  it("reports a tool error and a failed call", async () => {
    const { host, connection } = await connected();
    const refused = connection.call("solvate", {}, { timeoutMs: 1 });
    host.reply({ isError: true, content: [{ type: "text", text: "Solvate needs a cell." }] });
    expect(await refused).toEqual({ ok: false, error: "Solvate needs a cell." });
    const failed = connection.call("solvate", {}, { timeoutMs: 1 });
    host.fail("Request timed out");
    expect(await failed).toEqual({ ok: false, error: "The server failed: Request timed out" });
  });

  it("cancels through the host and ignores the late reply", async () => {
    const { host, connection } = await connected();
    const controller = new AbortController();
    const call = connection.call("liquid_box", {}, { signal: controller.signal, timeoutMs: 1 });
    const { requestId } = host.last();
    controller.abort();
    expect(await call).toEqual({ ok: false, error: "Cancelled." });
    expect(host.last()).toEqual({ type: "tools:cancel", requestId });
    host.reply(CALLS.liquid_box.result, requestId); // dropped
    host.send({ type: "tools:progress", requestId, progress: 1 }); // dropped
  });

  it("does not send a call whose signal is already aborted", async () => {
    const { host, connection } = await connected();
    const before = host.sent.length;
    const controller = new AbortController();
    controller.abort();
    expect(await connection.call("x", {}, { signal: controller.signal, timeoutMs: 1 })).toEqual({
      ok: false,
      error: "Cancelled.",
    });
    expect(host.sent.length).toBe(before);
  });

  it("ignores messages that are not its replies", async () => {
    const { host } = await connected();
    host.send(null);
    host.send("text");
    host.send({ type: "openFile" });
    host.send({ type: "tools:reply", requestId: 999, ok: true, value: 1 });
    host.send({ type: "something", requestId: 1 });
  });

  it("asks the host to show its settings", () => {
    const host = fakeHost();
    const bridge = createMessageBridge(host.port, { configHint: "x", openSettings: true });
    bridge.openSettings!();
    expect(host.sent).toEqual([{ type: "tools:openSettings" }]);
  });
});

describe("isBridgeRequest", () => {
  it("accepts the page's requests only", () => {
    expect(isBridgeRequest({ type: "tools:call" })).toBe(true);
    expect(isBridgeRequest({ type: "tools:openSettings" })).toBe(true);
    expect(isBridgeRequest({ type: "tools:reply" })).toBe(false);
    expect(isBridgeRequest({ type: "saveFile" })).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
    expect(isBridgeRequest("tools:call")).toBe(false);
  });
});
