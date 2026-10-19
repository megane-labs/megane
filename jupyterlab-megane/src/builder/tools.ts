/**
 * The JupyterLab Builder's tool servers, reached through the Jupyter server.
 *
 * The page cannot start a stdio MCP server, and a tool server on another port
 * would have to allow this page's origin. So the Builder talks to megane's
 * Jupyter server extension (`python/megane/builder_tools/`) over a WebSocket
 * (`/megane/builder-tools/ws`) with the bridge messages of
 * `src/builder/tools/bridgeProtocol.ts`, and the server starts or reaches the
 * servers of `MeganeBuilderTools.mcp_servers` in its configuration.
 *
 * Before the first connection to a server, the user is asked, with the
 * command line or URL (Builder Tool Contract §9); the answer is remembered in
 * this browser for exactly that command or URL.
 */

import {
  createMessageBridge,
  type BridgePort,
  type ToolBridge,
} from "@megane/builder/tools/bridge";
import type { BridgeServer } from "@megane/builder/tools/bridgeProtocol";

export const TOOLS_WS_PATH = "megane/builder-tools/ws";
export const ALLOWED_SERVERS_KEY = "megane.builder.allowedToolServers";
export const CONFIG_HINT = "the MeganeBuilderTools.mcp_servers option of jupyter_server_config";
export const LOST_CONNECTION =
  "Could not reach Megane's tool bridge on the Jupyter server. It needs Megane's server " +
  'extension and the MCP SDK (pip install "megane[tools]"), then a restart of Jupyter.';

/** The part of `ServerConnection.ISettings` the WebSocket needs. */
export interface ToolsSocketSettings {
  wsUrl: string;
  token: string;
  appendToken?: boolean;
  WebSocket: typeof WebSocket;
}

/** The bridge's WebSocket URL, with the token as JupyterLab's own sockets add it. */
export function toolsSocketUrl(settings: ToolsSocketSettings): string {
  const base = settings.wsUrl.endsWith("/") ? settings.wsUrl : `${settings.wsUrl}/`;
  const url = `${base}${TOOLS_WS_PATH}`;
  return settings.token && settings.appendToken !== false
    ? `${url}?token=${encodeURIComponent(settings.token)}`
    : url;
}

/** A `BridgePort` that can be closed (the Builder tab went away). */
export interface SocketPort extends BridgePort {
  close: () => void;
}

/**
 * A `BridgePort` on a WebSocket opened on first use (and again after it
 * closed). When it closes, every request still waiting is answered with an
 * error, so no form waits forever on a server that went away.
 */
export function createSocketPort(settings: ToolsSocketSettings): SocketPort {
  let socket: WebSocket | null = null;
  const queue: string[] = [];
  const handlers = new Set<(message: unknown) => void>();
  const waiting = new Set<number>();
  const emit = (message: unknown) => handlers.forEach((handler) => handler(message));

  const open = (): WebSocket => {
    const ws = new settings.WebSocket(toolsSocketUrl(settings));
    ws.onopen = () => {
      for (const text of queue.splice(0)) ws.send(text);
    };
    ws.onmessage = (event: MessageEvent) => {
      let message: { type?: string; requestId?: number };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === "tools:reply" && typeof message.requestId === "number") {
        waiting.delete(message.requestId);
      }
      emit(message);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      queue.length = 0;
      for (const requestId of [...waiting]) {
        emit({ type: "tools:reply", requestId, ok: false, error: LOST_CONNECTION });
      }
      waiting.clear();
    };
    return ws;
  };

  return {
    post: (message) => {
      if ("requestId" in message && message.type !== "tools:cancel") waiting.add(message.requestId);
      const text = JSON.stringify(message);
      socket ??= open();
      if (socket.readyState === settings.WebSocket.OPEN) socket.send(text);
      else queue.push(text);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {
      // The Jupyter server then releases this tab's tool servers.
      const ws = socket;
      socket = null;
      queue.length = 0;
      ws?.close();
    },
  };
}

function readAllowed(storage: Storage | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(ALLOWED_SERVERS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeAllowed(storage: Storage | null, allowed: string[]): void {
  try {
    storage?.setItem(ALLOWED_SERVERS_KEY, JSON.stringify(allowed));
  } catch {
    /* quota or blocked storage: ask again next time */
  }
}

export interface JupyterToolBridgeOptions {
  /** Ask whether megane may use `server`; resolves to the answer. */
  confirm: (server: BridgeServer) => Promise<boolean>;
  /** Where the answers are remembered (localStorage), or null to ask every time. */
  storage: Storage | null;
  port?: BridgePort & Partial<Pick<SocketPort, "close">>;
}

/** One Builder tab's bridge; `dispose` closes its connection to the Jupyter server. */
export interface JupyterToolBridge extends ToolBridge {
  dispose: () => void;
}

/**
 * A JupyterLab Builder tab's `ToolBridge`: the Jupyter server's tool servers,
 * asked about once, over a connection of the tab's own. Each tab has its own,
 * as each VS Code Builder tab has its own webview: the server tracks what a
 * connection uses, so one tab's Disconnect never cuts off another.
 */
export function createJupyterToolBridge(
  settings: ToolsSocketSettings,
  options: JupyterToolBridgeOptions,
): JupyterToolBridge {
  const port = options.port ?? createSocketPort(settings);
  const inner = createMessageBridge(port, { configHint: CONFIG_HINT });
  return {
    ...inner,
    dispose: () => port.close?.(),
    connect: async (id) => {
      const server = (await inner.listServers()).find((s) => s.id === id);
      if (server) {
        const key = server.fingerprint ?? `${server.kind}:${server.description}`;
        const allowed = readAllowed(options.storage);
        if (!allowed.includes(key)) {
          if (!(await options.confirm(server))) {
            throw new Error(`Not allowed to use "${id}" (${server.description}).`);
          }
          writeAllowed(options.storage, [...readAllowed(options.storage), key]);
        }
      }
      // An unknown id is the server's to report.
      return inner.connect(id);
    },
  };
}

/** The question asked before megane first uses a server (§9). */
export function permissionBody(server: BridgeServer): string {
  return server.kind === "stdio"
    ? `Megane Builder will run this command on the Jupyter server's machine to provide its tool buttons: ${server.description} — allow only servers you trust.`
    : `Megane Builder will send the structures you build with its tools to ${server.description} — allow only servers you trust.`;
}
