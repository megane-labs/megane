/**
 * Tool servers reached through the host (Builder Tool Contract §8).
 *
 * The web app connects to a Streamable HTTP server itself (`client.ts`). A
 * page embedded in an editor cannot: a VS Code webview may not spawn a stdio
 * server, its CSP blocks loopback requests, and its origin changes with every
 * tab, so no server can allow it. There the host owns the connections, and the
 * page talks to it over a message channel (`BridgePort`, `postMessage` in VS
 * Code) with the messages of `bridgeProtocol.ts`.
 *
 * `createMessageBridge` turns that channel into a `ToolBridge`: the servers the
 * user configured, and a `ToolConnection` per server that behaves exactly like
 * a direct one, so the Tools menu, the forms and the apply path are shared.
 */

import { parseTools, type McpTool } from "./contract";
import { interpretCall, type RawCallResult, type ToolConnection } from "./client";
import type { BridgeConnected, BridgeRequest, BridgeServer } from "./bridgeProtocol";

export type { BridgeServer } from "./bridgeProtocol";

/** The page's end of the message channel to the host. */
export interface BridgePort {
  post: (message: BridgeRequest) => void;
  /** Receive the host's messages; returns the function that stops receiving. */
  listen: (handler: (message: unknown) => void) => () => void;
}

/** Tool servers the host connects to on the page's behalf. */
export interface ToolBridge {
  /** Where the user adds servers, for the server form (e.g. the setting's name). */
  configHint: string;
  listServers: () => Promise<BridgeServer[]>;
  connect: (serverId: string) => Promise<ToolConnection>;
  /** Show the host's configuration of servers, if it has a place to show. */
  openSettings?: () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: number, total: number | undefined, message: string | undefined) => void;
}

type HostMessage =
  | { type: "tools:reply"; requestId: number; ok: boolean; value?: unknown; error?: string }
  | {
      type: "tools:progress";
      requestId: number;
      progress: number;
      total?: number;
      message?: string;
    };

export function createMessageBridge(
  port: BridgePort,
  options: { configHint: string; openSettings?: boolean },
): ToolBridge {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let listening = false;

  function onMessage(raw: unknown) {
    const message = raw as HostMessage | null;
    if (!message || typeof message !== "object" || typeof message.requestId !== "number") return;
    const entry = pending.get(message.requestId);
    if (!entry) return; // cancelled, or another page's
    if (message.type === "tools:progress") {
      entry.onProgress?.(message.progress, message.total, message.message);
    } else if (message.type === "tools:reply") {
      pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error || "The host reported an error."));
    }
  }

  /** Send a request; resolves to the host's value. */
  function request(
    build: (requestId: number) => BridgeRequest,
    onProgress?: Pending["onProgress"],
  ): { requestId: number; promise: Promise<unknown> } {
    if (!listening) {
      port.listen(onMessage);
      listening = true;
    }
    const requestId = nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(requestId, { resolve, reject, onProgress });
    });
    port.post(build(requestId));
    return { requestId, promise };
  }

  async function connect(server: string): Promise<ToolConnection> {
    const { promise } = request((requestId) => ({ type: "tools:connect", requestId, server }));
    const connected = (await promise) as BridgeConnected;
    return {
      serverName: connected.serverName || server,
      serverVersion: connected.serverVersion ?? null,
      listing: parseTools(connected.tools as McpTool[]),
      call: async (name, args, { onProgress, signal, timeoutMs }) => {
        if (signal?.aborted) return { ok: false, error: "Cancelled." };
        const { requestId, promise } = request(
          (id) => ({ type: "tools:call", requestId: id, server, name, arguments: args, timeoutMs }),
          (progress, total, message) =>
            onProgress?.(total ? progress / total : null, message ?? null),
        );
        const cancelled = new Promise<"cancelled">((resolve) =>
          signal?.addEventListener(
            "abort",
            () => {
              // The host aborts the call (MCP `notifications/cancelled`); its late reply is ignored.
              pending.delete(requestId);
              port.post({ type: "tools:cancel", requestId });
              resolve("cancelled");
            },
            { once: true },
          ),
        );
        try {
          const outcome = await Promise.race([promise, cancelled]);
          if (outcome === "cancelled") return { ok: false, error: "Cancelled." };
          return interpretCall(outcome as RawCallResult);
        } catch (err) {
          return { ok: false, error: `The server failed: ${(err as Error).message}` };
        }
      },
      close: async () => port.post({ type: "tools:disconnect", server }),
    };
  }

  return {
    configHint: options.configHint,
    listServers: async () =>
      (await request((requestId) => ({ type: "tools:servers", requestId }))
        .promise) as BridgeServer[],
    connect,
    openSettings: options.openSettings
      ? () => port.post({ type: "tools:openSettings" })
      : undefined,
  };
}
