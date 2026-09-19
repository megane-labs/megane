/**
 * Shared collapsible panel with frosted glass styling.
 * Used by AppearancePanel and PipelineEditor.
 */

import type { CSSProperties, ReactNode } from "react";

/** Frosted glass panel container style. */
export const panelContainerStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  bottom: 60,
  zIndex: 10,
  background: "var(--megane-surface)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  borderRadius: 12,
  boxShadow: "0 1px 8px var(--megane-shadow)",
  border: "1px solid var(--megane-border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

/** Panel header style. */
export const panelHeaderStyle: CSSProperties = {
  padding: "10px 14px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--megane-border)",
  flexShrink: 0,
};

/** Panel title text style. */
export const panelTitleStyle: CSSProperties = {
  fontWeight: 600,
  color: "var(--megane-text)",
  fontSize: 13,
  letterSpacing: "-0.02em",
};

/** Collapse/expand button (the ▶ / ◀ arrow). */
export const collapseButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  color: "var(--megane-text-muted)",
  padding: "2px 4px",
};

/** Style for the collapsed toggle button. */
const collapsedButtonStyle: CSSProperties = {
  background: "var(--megane-surface)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  border: "1px solid var(--megane-border)",
  borderRadius: 10,
  padding: "8px 12px",
  cursor: "pointer",
  boxShadow: "0 1px 8px var(--megane-shadow)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--megane-text)",
  letterSpacing: "-0.02em",
};

interface CollapsiblePanelProps {
  title: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Panel width (default: 220). */
  width?: number | string;
  /** Top offset in pixels (default: 12). Use to stack multiple panels. */
  top?: number;
  /** Right offset in pixels (default: 12). Use to side-by-side panels. */
  right?: number;
  /**
   * Bottom offset (default: 60, clear of the Timeline). The expanded panel
   * stretches from `top` to `bottom` unless `height` is given, in which case
   * it is anchored at `bottom` with that height and `top` is ignored (a
   * panel stacked under another one). The collapsed stub follows the same
   * anchor: top-right by default, bottom-right when `height` is given.
   */
  bottom?: number | string;
  height?: number | string;
  /**
   * Where the collapsed stub sits (default: top-right, or bottom-right when
   * `height` is given). "bottom" pins it to the bottom-right even for a panel
   * that stretches the full column when expanded.
   */
  stubAnchor?: "top" | "bottom";
  /** Extra header content (buttons etc.) placed before the collapse button. */
  headerExtra?: ReactNode;
  /** Extra elements prepended inside the panel container (e.g. resize handle). */
  containerExtra?: ReactNode;
  children: ReactNode;
}

/**
 * Collapsible frosted glass panel.
 * When collapsed, renders a small button. When expanded, renders a full panel.
 */
export function CollapsiblePanel({
  title,
  collapsed,
  onToggleCollapse,
  width = 220,
  top = 12,
  right = 12,
  bottom = 60,
  height,
  stubAnchor,
  headerExtra,
  containerExtra,
  children,
}: CollapsiblePanelProps) {
  const panelTestId = `panel-${title.replace(/\s+/g, "-").toLowerCase()}`;
  const placement: CSSProperties =
    height !== undefined ? { top: "auto", bottom, height } : { top, bottom };
  const stubAtBottom =
    stubAnchor === "bottom" || (stubAnchor === undefined && height !== undefined);
  const stubPlacement: CSSProperties = stubAtBottom ? { bottom, right } : { top, right };

  if (collapsed) {
    return (
      <div
        style={{ position: "absolute", zIndex: 10, ...stubPlacement }}
        data-testid={panelTestId}
        data-collapsed="true"
      >
        <button
          onClick={onToggleCollapse}
          data-testid={`${panelTestId}-toggle`}
          style={collapsedButtonStyle}
          title={`Open ${title.toLowerCase()}`}
          aria-label={`Open ${title.toLowerCase()}`}
          aria-expanded="false"
        >
          <span style={{ fontSize: 11, color: "var(--megane-text-muted)", fontWeight: 400 }}>
            &#9664;
          </span>
          {title}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{ ...panelContainerStyle, width, right, ...placement }}
      data-testid={panelTestId}
      data-collapsed="false"
    >
      {containerExtra}
      <div style={panelHeaderStyle}>
        <span style={panelTitleStyle}>{title}</span>
        <button
          onClick={onToggleCollapse}
          data-testid={`${panelTestId}-toggle`}
          style={collapseButtonStyle}
          title="Collapse panel"
          aria-label="Collapse panel"
          aria-expanded="true"
        >
          &#9654;
        </button>
      </div>
      {headerExtra && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "5px 8px",
            borderBottom: "1px solid var(--megane-border)",
            flexShrink: 0,
            flexWrap: "wrap",
            rowGap: 4,
          }}
        >
          {headerExtra}
        </div>
      )}
      {children}
    </div>
  );
}
