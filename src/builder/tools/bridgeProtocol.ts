/**
 * The messages between a Builder page and the host code that owns its tool
 * server connections (the *bridge*, Builder Tool Contract §8).
 *
 * A page that cannot reach a tool server itself (a VS Code webview: no
 * process spawning, a CSP and an origin no server can allow) asks its host
 * instead. The host lists the servers the user configured, connects to them
 * (stdio or Streamable HTTP), and relays exactly three things: the tool list,
 * a call with its progress, and a cancel. It never forwards arbitrary
 * JSON-RPC, so a page cannot reach resources, prompts or sampling.
 *
 * Shared by the page (`bridge.ts`), the VS Code extension host
 * (`vscode-megane/src/builderTools.ts`) and the Jupyter server extension
 * (`python/megane/builder_tools/bridge.py`, over a WebSocket). The host does
 * not interpret tools or results: the page parses them as it does for a
 * direct connection.
 */

/** One server the user configured, as the page lists it. */
export interface BridgeServer {
  /** The key of the server in the host's configuration. */
  id: string;
  /** A process the host starts, or an HTTP endpoint it connects to. */
  kind: "stdio" | "http";
  /** What connecting runs or reaches: the command line, or the URL (§9). */
  description: string;
  /**
   * Everything that decides what runs or where data goes (command, args, env,
   * cwd; or the URL), for a page that remembers what the user allowed.
   */
  fingerprint?: string;
}

/** What a connect resolves to: the server's identity and its raw `tools/list`. */
export interface BridgeConnected {
  serverName: string;
  serverVersion: string | null;
  tools: unknown[];
}

/** Page → host. */
export type BridgeRequest =
  | { type: "tools:servers"; requestId: number }
  | { type: "tools:connect"; requestId: number; server: string }
  | {
      type: "tools:call";
      requestId: number;
      server: string;
      name: string;
      arguments: Record<string, unknown>;
      timeoutMs: number;
    }
  | { type: "tools:cancel"; requestId: number }
  | { type: "tools:disconnect"; server: string }
  | { type: "tools:openSettings" };

/** Host → page: the answer to a request, or a progress notification of a call. */
export type BridgeReply =
  | { type: "tools:reply"; requestId: number; ok: true; value: unknown }
  | { type: "tools:reply"; requestId: number; ok: false; error: string }
  | {
      type: "tools:progress";
      requestId: number;
      progress: number;
      total?: number;
      message?: string;
    };

const REQUEST_TYPES: ReadonlySet<string> = new Set([
  "tools:servers",
  "tools:connect",
  "tools:call",
  "tools:cancel",
  "tools:disconnect",
  "tools:openSettings",
]);

/** Whether `message` is a bridge request (the host also receives other messages). */
export function isBridgeRequest(message: unknown): message is BridgeRequest {
  const type = (message as { type?: unknown } | null)?.type;
  return typeof type === "string" && REQUEST_TYPES.has(type);
}
