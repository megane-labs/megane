/**
 * The sidebar's "Python tools" section: connect to a tool server (an MCP
 * server implementing the Builder Tool Contract) and show its tools as
 * buttons, grouped by category (§3). Clicking a button opens its form
 * (`ToolDialog`).
 *
 * `#tools=<url>&token=<token>` in the page URL connects on load, which is
 * what a tool server can print as a ready-to-open link; the token is removed
 * from the address bar once read.
 */

import { useEffect } from "react";
import { Section } from "../Section";
import { buttonStyle, hintStyle, inputStyle, rowStyle } from "../styles";
import { CATEGORY_LABELS, type BuilderToolInfo, type ToolCategory } from "./contract";
import { readLaunchParams, useToolsStore } from "./store";
import { ToolDialog } from "./ToolDialog";

function groupByCategory(tools: BuilderToolInfo[]): [ToolCategory, BuilderToolInfo[]][] {
  const groups = new Map<ToolCategory, BuilderToolInfo[]>();
  for (const tool of tools) {
    const list = groups.get(tool.category) ?? [];
    list.push(tool);
    groups.set(tool.category, list);
  }
  return [...groups.entries()];
}

export function ToolsSection() {
  const url = useToolsStore((s) => s.url);
  const token = useToolsStore((s) => s.token);
  const status = useToolsStore((s) => s.status);
  const error = useToolsStore((s) => s.error);
  const connection = useToolsStore((s) => s.connection);
  const openTool = useToolsStore((s) => s.openTool);
  const setUrl = useToolsStore((s) => s.setUrl);
  const setToken = useToolsStore((s) => s.setToken);
  const connect = useToolsStore((s) => s.connect);
  const disconnect = useToolsStore((s) => s.disconnect);
  const openForm = useToolsStore((s) => s.openForm);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const launch = readLaunchParams(window.location.hash);
    if (!launch) return;
    const api = useToolsStore.getState();
    api.setUrl(launch.url);
    api.setToken(launch.token);
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      /* sandboxed frames may refuse */
    }
    void api.connect();
  }, []);

  const summary =
    status === "connected" && connection
      ? connection.serverName
      : status === "connecting"
        ? "connecting…"
        : "not connected";

  return (
    <Section id="tools" title="Python tools" summary={summary} defaultOpen={false}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
            style={{ ...hintStyle, color: "#b91c1c" }}
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
      </div>
      {connection && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          data-testid="builder-tools-list"
        >
          {connection.listing.tools.length === 0 && (
            <div style={hintStyle}>This server offers no Builder tools.</div>
          )}
          {groupByCategory(connection.listing.tools).map(([category, tools]) => (
            <div key={category} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ ...hintStyle, fontWeight: 600 }}>{CATEGORY_LABELS[category]}</span>
              <div style={rowStyle}>
                {tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    data-testid={`builder-tools-button-${tool.name}`}
                    title={
                      tool.formError
                        ? `Builder cannot build a form: ${tool.formError}`
                        : tool.tooltip
                    }
                    style={buttonStyle("default", !!tool.formError)}
                    disabled={!!tool.formError}
                    onClick={() => openForm(tool)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {connection.listing.unsupported.length > 0 && (
            <div style={hintStyle} data-testid="builder-tools-unsupported">
              Hidden (newer contract than this Builder supports):{" "}
              {connection.listing.unsupported.join(", ")}
            </div>
          )}
        </div>
      )}
      {openTool && <ToolDialog key={openTool.name} tool={openTool} />}
    </Section>
  );
}
