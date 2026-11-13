/**
 * Shared collapsible panel with frosted glass styling.
 * Used by the viewer's PipelineEditor and the Builder's Details and History panels.
 */

import type { CSSProperties, ReactNode } from "react";
import { floatingSurfaceStyle } from "./toolbarStyles";

/** Frosted glass panel container style. */
export const panelContainerStyle: CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  bottom: 60,
  zIndex: 10,
  ...floatingSurfaceStyle,
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

/** Muted text beside the title, cut with an ellipsis when it runs long. */
export const panelSubtitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: "0 8px",
  fontSize: 11,
  color: "var(--megane-text-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** Collapse button in the expanded header (an {@link ExpandCircleRightIcon}). */
export const collapseButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  color: "var(--megane-text-muted)",
  padding: "1px 2px",
};

/**
 * Material Symbols Outlined `expand_circle_right` (FILL 0, wght 400, GRAD 0,
 * opsz 24; Apache-2.0, https://fonts.google.com/icons). Drawn in
 * `currentColor` so it follows the theme. `flipped` mirrors it into a
 * left-pointing chevron.
 */
export function ExpandCircleRightIcon({
  size,
  flipped = false,
}: {
  size: number;
  flipped?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -960 960 960"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon={flipped ? "expand-circle-left" : "expand-circle-right"}
      style={{ display: "block", flexShrink: 0, transform: flipped ? "scaleX(-1)" : undefined }}
    >
      <path d="M507-480 384-357l56 57 180-180-180-180-56 57 123 123ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z" />
    </svg>
  );
}

/** Style for the collapsed toggle button. */
const collapsedButtonStyle: CSSProperties = {
  ...floatingSurfaceStyle,
  borderRadius: 10,
  padding: "8px 12px",
  cursor: "pointer",
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
  /** Muted text beside the title in the expanded header (a file name, a count). */
  subtitle?: ReactNode;
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
  subtitle,
  collapsed,
  onToggleCollapse,
  width = 220,
  top = 12,
  right = 12,
  bottom = 60,
  height,
  headerExtra,
  containerExtra,
  children,
}: CollapsiblePanelProps) {
  const panelTestId = `panel-${title.replace(/\s+/g, "-").toLowerCase()}`;
  const placement: CSSProperties =
    height !== undefined ? { top: "auto", bottom, height } : { top, bottom };
  const stubPlacement: CSSProperties = height !== undefined ? { bottom, right } : { top, right };

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
          <span style={{ display: "flex", color: "var(--megane-text-muted)" }}>
            <ExpandCircleRightIcon size={16} flipped />
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
        {subtitle !== undefined && subtitle !== null && (
          <span style={panelSubtitleStyle} data-testid={`${panelTestId}-subtitle`}>
            {subtitle}
          </span>
        )}
        <button
          onClick={onToggleCollapse}
          data-testid={`${panelTestId}-toggle`}
          style={collapseButtonStyle}
          title="Collapse panel"
          aria-label="Collapse panel"
          aria-expanded="true"
        >
          <ExpandCircleRightIcon size={18} />
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
