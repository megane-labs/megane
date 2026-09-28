/**
 * Python tools on the operations rail: the *Tools* menu lists the connected tool
 * server's tools, grouped by category (§3); choosing one opens its form
 * (`ToolDialog`). *Tool server…* opens a dialog to connect to a server (an MCP
 * server implementing the Builder Tool Contract) — set once, so it is a
 * dialog rather than a panel that stays on screen.
 *
 * `#tools=<url>&token=<token>` in the page URL connects on load
 * (`useToolServerLaunch`), which is what a tool server can print as a
 * ready-to-open link; the token is removed from the address bar once read. A
 * build with a site tool server (`VITE_BUILDER_TOOLS_URL`, the demo site)
 * connects to it on load while it is the chosen server.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { MenuItem } from "../Menu";
import { buttonStyle, hintStyle, inputStyle, rowStyle } from "../styles";
import { CATEGORY_LABELS, type BuilderToolInfo, type ToolCategory } from "./contract";
import { readLaunchParams, siteToolServerUrl, useToolsStore, type ToolsStore } from "./store";

function groupByCategory(tools: BuilderToolInfo[]): [ToolCategory, BuilderToolInfo[]][] {
  const groups = new Map<ToolCategory, BuilderToolInfo[]>();
  for (const tool of tools) {
    const list = groups.get(tool.category) ?? [];
    list.push(tool);
    groups.set(tool.category, list);
  }
  return [...groups.entries()];
}

/** Connect from a launch link, or to the site's tool server, once on mount. */
export function useToolServerLaunch() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const launch = readLaunchParams(window.location.hash);
    const api = useToolsStore.getState();
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
  }, []);
}

/** The Tools menu: the server's tools by category, then the way to (re)connect. */
export function toolsMenuItems(
  state: Pick<ToolsStore, "status" | "connection" | "openForm">,
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
  }
  items.push({ separator: true });
  items.push({ label: "Tool server…", testId: "builder-tools-server", onSelect: openServer });
  return items;
}

/** Connect to (or disconnect from) a tool server. */
export function ToolServerDialog({ onClose }: { onClose: () => void }) {
  const url = useToolsStore((s) => s.url);
  const token = useToolsStore((s) => s.token);
  const status = useToolsStore((s) => s.status);
  const error = useToolsStore((s) => s.error);
  const connection = useToolsStore((s) => s.connection);
  const setUrl = useToolsStore((s) => s.setUrl);
  const setToken = useToolsStore((s) => s.setToken);
  const connect = useToolsStore((s) => s.connect);
  const disconnect = useToolsStore((s) => s.disconnect);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      data-testid="builder-tools-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Tool server"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(460px, 94vw)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 16,
          borderRadius: 10,
          background: "var(--megane-surface-solid, #fff)",
          color: "var(--megane-text, #1e293b)",
          border: "1px solid var(--megane-border-solid, #e2e8f0)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700 }}>Tool server</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="builder-tools-dialog-close"
            style={buttonStyle()}
            onClick={onClose}
          >
            Close
          </button>
        </div>
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
          {status === "connected" ? (
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
          )}
        </div>
        {error && (
          <div
            data-testid="builder-tools-error"
            role="alert"
            style={{ ...hintStyle, color: "var(--megane-danger-text, #b91c1c)" }}
          >
            {error}
          </div>
        )}
        {status === "idle" && !error && (
          <div style={hintStyle}>
            Run a tool server, e.g. <code>uvx megane-builder-tools --transport http</code>, and
            paste its URL and token.
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
      </div>
    </div>,
    document.body,
  );
}
