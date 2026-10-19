// @vitest-environment node
/**
 * `connectWithSdk` against a real (minimal) MCP server: started as a child
 * process over stdio, and reached over Streamable HTTP.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { ToolClient } from "../../../vscode-megane/src/builderTools";
import { connectWithSdk } from "../../../vscode-megane/src/sdkClient";
import { handle } from "./fixtures/fakeMcpServer.mjs";

const SERVER = join(__dirname, "fixtures", "fakeMcpServer.mjs");
let client: ToolClient | null = null;
let http: Server | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  http = null;
});

describe("connectWithSdk", () => {
  it("starts a stdio server, lists every page of tools, calls with progress, and logs stderr", async () => {
    const lines: string[] = [];
    client = await connectWithSdk(
      {
        id: "fake",
        kind: "stdio",
        command: process.execPath,
        args: [SERVER],
        env: { FAKE: "yes" },
        cwd: __dirname,
      },
      (line) => lines.push(line),
    );
    expect(client.serverName).toBe("fake-tools");
    expect(client.serverVersion).toBe("9.9");
    expect(client.open).toBe(true);
    expect(((await client.listTools()) as { name: string }[]).map((t) => t.name)).toEqual([
      "echo",
      "second",
    ]);
    const progress: unknown[] = [];
    const result = await client.callTool(
      "echo",
      { seed: 3 },
      {
        signal: new AbortController().signal,
        timeoutMs: 10_000,
        onProgress: (...p) => progress.push(p),
      },
    );
    expect(result).toMatchObject({ structuredContent: { arguments: { seed: 3 } } });
    expect(progress).toEqual([[1, 2, "half"]]);
    await expect.poll(() => lines.join("\n")).toContain(`with FAKE=yes`);
    expect(lines[0]).toBe(`[fake] connecting: ${process.execPath} ${SERVER}`);
    expect(lines.join("\n")).toContain(`started in ${__dirname}`);
    await client.close();
    expect(client.open).toBe(false);
    client = null;
  });

  it("reaches a Streamable HTTP server with the configured headers", async () => {
    const seen: (string | undefined)[] = [];
    http = createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const message = JSON.parse(body);
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result = handle(message, () => undefined);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as { port: number };
    client = await connectWithSdk(
      {
        id: "web",
        kind: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: "Bearer tok" },
      },
      () => undefined,
    );
    expect(client.serverName).toBe("fake-tools");
    const result = await client.callTool(
      "echo",
      { a: 1 },
      { signal: new AbortController().signal, timeoutMs: 10_000, onProgress: () => undefined },
    );
    expect(result).toMatchObject({ structuredContent: { arguments: { a: 1 } } });
    expect(seen.filter(Boolean).every((h) => h === "Bearer tok")).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("names the server by its id when it does not say, and notices it going away", async () => {
    const lines: string[] = [];
    client = await connectWithSdk(
      {
        id: "quiet",
        kind: "stdio",
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.on("data", (c) => { for (const l of String(c).split("\\n")) { if (!l.trim()) continue; const m = JSON.parse(l); if (m.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "", version: "" } } }) + "\\n"); setTimeout(() => process.exit(0), 200); } } });`,
        ],
        env: {},
      },
      (line) => lines.push(line),
    );
    expect(client.serverName).toBe("quiet");
    expect(client.serverVersion).toBeNull();
    await expect.poll(() => client!.open, { timeout: 5_000 }).toBe(false);
    expect(lines).toContain("[quiet] disconnected");
  });
});
