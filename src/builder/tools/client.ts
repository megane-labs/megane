/**
 * The MCP connection behind the Builder's tool buttons.
 *
 * Builder talks to a tool server over Streamable HTTP with a bearer token
 * (§8, the static-webapp row: the page connects to an HTTP server directly).
 * The MCP SDK is loaded on the first connection, so a Builder that never uses
 * tools never downloads it. The rest of the Builder only sees the small
 * `ToolConnection` interface, which tests replace with a fake.
 */

import {
  parseResult,
  parseTools,
  type BuilderResult,
  type McpTool,
  type ToolListing,
} from "./contract";

export interface CallOptions {
  onProgress?: (fraction: number | null, message: string | null) => void;
  signal?: AbortSignal;
  timeoutMs: number;
}

export type CallOutcome =
  | { ok: true; result: BuilderResult; summary: string | null }
  | { ok: false; error: string };

export interface ToolConnection {
  /** `serverInfo.name`, or the URL's host when the server does not say. */
  serverName: string;
  serverVersion: string | null;
  listing: ToolListing;
  call: (name: string, args: Record<string, unknown>, options: CallOptions) => Promise<CallOutcome>;
  close: () => Promise<void>;
}

/** What `callTool` resolves to (the subset read here). */
export interface RawCallResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

/** The text of a result's first text block, if any. */
export function firstText(result: RawCallResult): string | null {
  const block = result.content?.find((c) => c.type === "text" && typeof c.text === "string");
  return block?.text?.trim() || null;
}

/** Turn a raw `tools/call` result into what the Builder applies or reports (§6). */
export function interpretCall(result: RawCallResult): CallOutcome {
  if (result.isError) {
    return { ok: false, error: firstText(result) ?? "The tool reported an error." };
  }
  try {
    return { ok: true, result: parseResult(result.structuredContent), summary: firstText(result) };
  } catch (err) {
    return { ok: false, error: `The tool returned an invalid result: ${errorMessage(err)}` };
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Open a connection to the tool server at `url` (a Streamable HTTP endpoint). */
export async function connectToolServer(url: string, token: string): Promise<ToolConnection> {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const endpoint = new URL(url);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } });
  const client = new Client({ name: "megane-builder", version: "1" });
  await client.connect(transport);

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools as unknown as McpTool[]));
    cursor = page.nextCursor;
  } while (cursor);

  const info = client.getServerVersion();
  return {
    serverName: info?.name || endpoint.host,
    serverVersion: info?.version || null,
    listing: parseTools(tools),
    call: async (name, args, { onProgress, signal, timeoutMs }) => {
      try {
        const result = await client.callTool(
          { name, arguments: args },
          {
            signal,
            timeout: timeoutMs,
            onprogress: (p: { progress: number; total?: number; message?: string }) => {
              const fraction = p.total ? p.progress / p.total : null;
              onProgress?.(fraction, p.message ?? null);
            },
          },
        );
        return interpretCall(result as RawCallResult);
      } catch (err) {
        if (signal?.aborted) return { ok: false, error: "Cancelled." };
        return { ok: false, error: `The server failed: ${errorMessage(err)}` };
      }
    },
    close: () => client.close(),
  };
}
