/**
 * A `ToolClient` (`builderTools.ts`) on the MCP TypeScript SDK.
 *
 * Bundled on its own (`out/sdkClient.js`, see `esbuild.extension.mjs`) and
 * loaded on the first tool-server connection, so activating the extension
 * never parses the SDK.
 */

import * as os from "os";
import { describeServer, type ServerConfig, type ToolClient } from "./builderTools";

/** Large enough for a `document` argument or a result of the maximum size (§5.1). */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/**
 * How long a stdio server may take to answer `initialize`: the first start of
 * one run by uvx downloads its environment (the reference server's is over
 * 100 MB), which the SDK's 60 s default does not allow for.
 */
export const STDIO_START_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The editor's environment, for a server the user allowed. The SDK would pass
 * only a few variables (HOME, PATH, …), but a server started by uvx downloads
 * its environment on first use and needs the proxy (`HTTPS_PROXY`,
 * `SSL_CERT_FILE`) and uv settings (`UV_CACHE_DIR`, …), as a command run in a
 * terminal would have them.
 */
export function inheritedEnvironment(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * A `ToolClient` on the MCP TypeScript SDK: stdio servers are started as a
 * child process (stderr goes to `log`), HTTP servers are reached directly.
 */
export async function connectWithSdk(
  config: ServerConfig,
  log: (line: string) => void,
): Promise<ToolClient> {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  let transport;
  if (config.kind === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
    const stdio = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...inheritedEnvironment(), ...config.env },
      cwd: config.cwd ?? os.homedir(),
      stderr: "pipe",
      maxBufferSize: MAX_MESSAGE_BYTES,
    });
    stdio.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line) log(`[${config.id}] ${line}`);
    });
    transport = stdio;
  } else {
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  const client = new Client({ name: "megane-builder-vscode", version: "1" });
  let open = true;
  client.onclose = () => {
    open = false;
    log(`[${config.id}] disconnected`);
  };
  log(`[${config.id}] connecting: ${describeServer(config)}`);
  await client.connect(
    transport,
    config.kind === "stdio" ? { timeout: STDIO_START_TIMEOUT_MS } : undefined,
  );
  const info = client.getServerVersion();
  return {
    serverName: info?.name || config.id,
    serverVersion: info?.version || null,
    get open() {
      return open;
    },
    listTools: async () => {
      const tools: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    callTool: (name, args, { signal, timeoutMs, onProgress }) =>
      client.callTool(
        { name, arguments: args },
        {
          signal,
          timeout: timeoutMs,
          onprogress: (p: { progress: number; total?: number; message?: string }) =>
            onProgress(p.progress, p.total, p.message),
        },
      ),
    close: async () => {
      open = false;
      await client.close();
    },
  };
}
