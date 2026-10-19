/**
 * The panel a node-graph editor lives in, on the right of the view: a
 * collapsible frosted panel whose left edge drags to resize it, with the
 * editor's rail down its left side and the editor beside it. Inside the
 * editor, `GraphSplit` stacks the graph over the selected node's pane with a
 * draggable separator between them.
 *
 * Shared by the viewer's Pipeline panel and megane Builder's Flow panel, so
 * the two editors have the same frame, the same widths and the same split.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CollapsiblePanel } from "../CollapsiblePanel";

export const GRAPH_PANEL_MIN_WIDTH = 320;
export const GRAPH_PANEL_MAX_WIDTH = 600;
export const GRAPH_PANEL_DEFAULT_WIDTH = 480;

const resizeHandleStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 5,
  cursor: "col-resize",
  zIndex: 20,
  background: "transparent",
};

export interface GraphEditorPanelProps {
  title: string;
  subtitle?: ReactNode;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Told the panel's width on mount and after every drag. */
  onWidthChange?: (width: number) => void;
  /** Bottom offset of the panel. */
  bottom?: number | string;
  /** The column of icon buttons down the panel's left edge. */
  rail: ReactNode;
  /** Rendered inside the panel after the editor (file inputs, dialogs). */
  extra?: ReactNode;
  /** Test id of the row holding the rail and the editor. */
  testId?: string;
  children: ReactNode;
}

export function GraphEditorPanel({
  title,
  subtitle,
  collapsed,
  onToggleCollapse,
  onWidthChange,
  bottom,
  rail,
  extra,
  testId,
  children,
}: GraphEditorPanelProps) {
  const [panelWidth, setPanelWidth] = useState(GRAPH_PANEL_DEFAULT_WIDTH);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // The parent mirrors this width to size the renderer's frustum inset, but
  // `panelWidth` is local state that resets whenever the panel unmounts while
  // the parent's mirror keeps the last dragged value. Reporting on mount
  // keeps the two in sync.
  useEffect(() => {
    onWidthChange?.(panelWidth);
  }, [panelWidth, onWidthChange]);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: panelWidth };

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Panel is on the right: dragging left increases width
        const newWidth = dragRef.current.startWidth - (ev.clientX - dragRef.current.startX);
        const clamped = Math.max(GRAPH_PANEL_MIN_WIDTH, Math.min(GRAPH_PANEL_MAX_WIDTH, newWidth));
        setPanelWidth(clamped);
        onWidthChange?.(clamped);
      };

      const handleMouseUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [panelWidth, onWidthChange],
  );

  const resizeHandle = (
    <div
      style={resizeHandleStyle}
      onMouseDown={handleResizeMouseDown}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "rgba(59,130,246,0.15)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    />
  );

  return (
    <CollapsiblePanel
      title={title}
      collapsed={collapsed}
      onToggleCollapse={onToggleCollapse}
      width={panelWidth}
      bottom={bottom}
      subtitle={subtitle}
      containerExtra={resizeHandle}
    >
      <div data-testid={testId} style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {rail}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
      {extra}
    </CollapsiblePanel>
  );
}

/**
 * The share of the editor the selected node's pane takes, and the handler
 * for the separator above it that drags it.
 */
export function useSplitFraction(initial = 0.34): [number, (e: React.MouseEvent) => void] {
  const [fraction, setFraction] = useState(initial);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const column = (e.currentTarget as HTMLElement).parentElement;
    if (!column) return;
    const rect = column.getBoundingClientRect();
    if (rect.height <= 0) return;
    const onMove = (ev: MouseEvent) => {
      const next = (rect.bottom - ev.clientY) / rect.height;
      setFraction(Math.max(0.15, Math.min(0.7, next)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  return [fraction, onMouseDown];
}

/** The draggable rule between the graph and the selected node's pane. */
export function SplitSeparator({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize properties pane"
      onMouseDown={onMouseDown}
      style={{
        flex: "0 0 7px",
        cursor: "row-resize",
        borderTop: "1px solid var(--megane-border-solid)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <span
        style={{
          width: 28,
          height: 3,
          borderRadius: 2,
          background: "var(--megane-border-strong)",
        }}
      />
    </div>
  );
}
