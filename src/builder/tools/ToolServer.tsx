/**
 * Python tools on the operations rail: the *Tools* menu lists the connected tool
 * server's tools, grouped by category (§3); choosing one opens its form
 * (`ToolDialog`). *Tool server…* opens a form to connect to a server (an MCP
 * server implementing the Builder Tool Contract). Both are forms in the
 * Details panel, as every option a button on the left opens.
 *
 * `#tools=<url>&token=<token>` in the page URL connects on load
 * (`useToolServerLaunch`), which is what a tool server can print as a
 * ready-to-open link; the token is removed from the address bar once read. A
 * build with a site tool server (`VITE_BUILDER_TOOLS_URL`, the demo site)
 * connects to it on load while it is the chosen server.
 *
 * In a host with a bridge (VS Code), the servers are the ones the user
 * configured in the host: the Tools menu offers to connect to each, and the
 * form picks one instead of taking a URL and token.
 */

import { useEffect } from "react";
import { DetailForm } from "../DetailForm";
import type { MenuItem } from "../Menu";
import { buttonStyle, hintStyle, inputStyle, rowStyle } from "../styles";
import { CATEGORY_LABELS, type BuilderToolInfo, type ToolCategory } from "./contract";
import { readLaunchParams, siteToolServerUrl, type ToolsStore } from "./store";
import { useScopedToolsStore, useToolsStoreApi } from "../BuilderStores";

function groupByCategory(tools: BuilderToolInfo[]): [ToolCategory, BuilderToolInfo[]][] {
  const groups = new Map<ToolCategory, BuilderToolInfo[]>();
  for (const tool of tools) {
    const list = groups.get(tool.category) ?? [];
    list.push(tool);
    groups.set(tool.category, list);
  }
  return [...groups.entries()];
}

/**
 * Connect from a launch link, or to the site's tool server, once on mount.
 * A host without the Tools menu (`enabled` false) leaves the page URL alone.
 */
export function useToolServerLaunch(enabled = true) {
  const tools = useToolsStoreApi();
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const launch = readLaunchParams(window.location.hash);
    const api = tools.getState();
    if (!launch) {
      const site = siteToolServerUrl();
      if (site && api.url.trim() === site && api.status === "idle") void api.connect();
      return;
    }
    api.setUrl(launch.url);
    api.setToken(launch.token);
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      /* sandboxed frames may refuse */
    }
    void api.connect();
  }, [enabled, tools]);
}

/**
 * The Tools menu: the server's tools by category, then the way to (re)connect.
 * With a bridge's `servers`, a disconnected menu offers to connect to each.
 */
export function toolsMenuItems(
  state: Pick<ToolsStore, "status" | "connection" | "openForm"> &
    Partial<Pick<ToolsStore, "servers" | "setUrl" | "connect">>,
  openServer: () => void,
): MenuItem[] {
  const items: MenuItem[] = [];
  const { status, connection } = state;
  if (status === "connected" && connection) {
    items.push({ caption: connection.serverName, testId: "builder-tools-server-name" });
    if (connection.listing.tools.length === 0) {
      items.push({
        label: "This server offers no Builder tools.",
        onSelect: () => {},
        disabled: true,
      });
    }
    for (const [category, tools] of groupByCategory(connection.listing.tools)) {
      items.push({ caption: CATEGORY_LABELS[category] });
      for (const tool of tools) {
        items.push({
          label: `${tool.label}…`,
          testId: `builder-tools-button-${tool.name}`,
          disabled: !!tool.formError,
          title: tool.formError ? `Builder cannot build a form: ${tool.formError}` : tool.tooltip,
          onSelect: () => state.openForm(tool),
        });
      }
    }
  } else {
    items.push({
      label: status === "connecting" ? "Connecting…" : "No tool server connected",
      testId: "builder-tools-status",
      onSelect: () => {},
      disabled: true,
    });
    if (status !== "connecting") {
      for (const server of state.servers ?? []) {
        items.push({
          label: `Connect to ${server.id}`,
          testId: `builder-tools-connect-${server.id}`,
          title: server.description,
          onSelect: () => {
            state.setUrl?.(server.id);
            openServer();
            void state.connect?.();
          },
        });
      }
    }
  }
  items.push({ separator: true });
  items.push({ label: "Tool server…", testId: "builder-tools-server", onSelect: openServer });
  return items;
}

/** Connect to (or disconnect from) a tool server. */
export function ToolServerDialog({ onClose }: { onClose: () => void }) {
  const url = useScopedToolsStore((s) => s.url);
  const token = useScopedToolsStore((s) => s.token);
  const status = useScopedToolsStore((s) => s.status);
  const error = useScopedToolsStore((s) => s.error);
  const connection = useScopedToolsStore((s) => s.connection);
  const setUrl = useScopedToolsStore((s) => s.setUrl);
  const setToken = useScopedToolsStore((s) => s.setToken);
  const connect = useScopedToolsStore((s) => s.connect);
  const disconnect = useScopedToolsStore((s) => s.disconnect);
  const bridge = useScopedToolsStore((s) => s.bridge);
  const servers = useScopedToolsStore((s) => s.servers);
  const refreshServers = useScopedToolsStore((s) => s.refreshServers);
  // The configuration may have changed since the page listed it.
  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const connectButton =
    status === "connected" ? (
      <button
        type="button"
        data-testid="builder-tools-disconnect"
        style={buttonStyle()}
        onClick={() => void disconnect()}
      >
        Disconnect
      </button>
    ) : (
      <button
        type="button"
        data-testid="builder-tools-connect"
        style={buttonStyle("primary", status === "connecting" || !url.trim())}
        disabled={status === "connecting" || !url.trim()}
        onClick={() => void connect()}
      >
        Connect
      </button>
    );
  const chosen = servers?.find((server) => server.id === url);

  return (
    <DetailForm
      testId="builder-tools-dialog"
      title="Tool server"
      onClose={onClose}
      closeTestId="builder-tools-dialog-close"
    >
      {bridge ? (
        servers === null ? (
          <div style={hintStyle}>Listing the tool servers…</div>
        ) : servers.length === 0 ? (
          <div style={hintStyle} data-testid="builder-tools-no-servers">
            No tool servers are configured. Add one to {bridge.configHint}.
          </div>
        ) : (
          <>
            <div style={rowStyle}>
              <select
                data-testid="builder-tools-server-select"
                aria-label="Tool server"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                value={url}
                disabled={status === "connected" || status === "connecting"}
                onChange={(e) => setUrl(e.target.value)}
              >
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.id}
                  </option>
                ))}
              </select>
              {connectButton}
            </div>
            {chosen && (
              <div style={hintStyle} data-testid="builder-tools-server-description">
                {chosen.kind === "stdio" ? "Runs" : "Connects to"} <code>{chosen.description}</code>
              </div>
            )}
          </>
        )
      ) : (
        <>
          <input
            data-testid="builder-tools-url"
            aria-label="Tool server URL"
            style={inputStyle}
            value={url}
            placeholder="http://127.0.0.1:8765/mcp"
            onChange={(e) => setUrl(e.target.value)}
          />
          <div style={rowStyle}>
            <input
              data-testid="builder-tools-token"
              aria-label="Tool server token"
              type="password"
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              value={token}
              placeholder="token"
              onChange={(e) => setToken(e.target.value)}
            />
            {connectButton}
          </div>
        </>
      )}
      {error && (
        <div
          data-testid="builder-tools-error"
          role="alert"
          style={{ ...hintStyle, color: "var(--megane-danger-text, #b91c1c)" }}
        >
          {error}
        </div>
      )}
      {bridge?.openSettings && (
        <button
          type="button"
          data-testid="builder-tools-open-settings"
          style={buttonStyle()}
          onClick={bridge.openSettings}
        >
          Configure tool servers…
        </button>
      )}
      {!bridge && status === "idle" && !error && (
        <div style={hintStyle}>
          Run a tool server, e.g. <code>uvx megane-builder-tools --transport http</code>, and paste
          its URL and token.
        </div>
      )}
      {status === "connected" && connection && (
        <div style={hintStyle} data-testid="builder-tools-connected">
          Connected to {connection.serverName}:{" "}
          {connection.listing.tools.length === 1
            ? "1 tool"
            : `${connection.listing.tools.length} tools`}{" "}
          in the Tools menu.
        </div>
      )}
      {connection && connection.listing.unsupported.length > 0 && (
        <div style={hintStyle} data-testid="builder-tools-unsupported">
          Hidden (newer contract than this Builder supports):{" "}
          {connection.listing.unsupported.join(", ")}
        </div>
      )}
    </DetailForm>
  );
}
