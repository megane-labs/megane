/**
 * The pane under a node graph where the selected node is edited, shared by
 * the viewer's pipeline editor and megane Builder's Flow mode: a header with
 * the node's icon, name, summary, an optional On / Off switch and a remove
 * button; its errors and warnings; then the node's form — or, with nothing
 * selected, a hint. Presentational: each editor supplies the node.
 */

import { useEffect, useRef, type ReactNode } from "react";

/** One message under the header. */
export interface PaneMessage {
  severity: "error" | "warning";
  message: string;
}

/** The header's icon buttons: square, muted until hovered. */
const headerIconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  flexShrink: 0,
  display: "grid",
  placeItems: "center",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  cursor: "pointer",
  color: "var(--megane-text-muted)",
  padding: 0,
};

export interface PropertiesHeaderProps {
  icon: ReactNode;
  /** Category colour: the header's tint. */
  color: string;
  title: string;
  summary: string;
  /** With `onToggle`, an On / Off switch. */
  enabled?: boolean;
  onToggle?: () => void;
  /** Without it, the node cannot be removed (the viewport). */
  onRemove?: () => void;
  removeDisabled?: boolean;
  removeTestId?: string;
  testId?: string;
}

export function PropertiesHeader({
  icon,
  color,
  title,
  summary,
  enabled = true,
  onToggle,
  onRemove,
  removeDisabled = false,
  removeTestId,
  testId = "pipeline-properties-header",
}: PropertiesHeaderProps) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 10px 10px 14px",
        borderBottom: "1px solid var(--megane-border)",
        background: `color-mix(in srgb, ${color} 5%, transparent)`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          color,
          background: `color-mix(in srgb, ${color} 15%, transparent)`,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 13,
            letterSpacing: "-0.01em",
            color: "var(--megane-text)",
          }}
        >
          {title}
        </div>
        <div
          title={summary}
          style={{
            fontSize: 11,
            color: "var(--megane-text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </div>
      </div>
      {onToggle && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            color: enabled ? "var(--megane-primary-text)" : "var(--megane-text-muted)",
            cursor: "pointer",
          }}
        >
          {enabled ? "On" : "Off"}
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? "Disable node" : "Enable node"}
            title={enabled ? "Disable node" : "Enable node"}
            onClick={onToggle}
            style={{
              width: 30,
              height: 17,
              flexShrink: 0,
              borderRadius: 9,
              border: "none",
              padding: 0,
              cursor: "pointer",
              position: "relative",
              background: enabled ? "var(--megane-primary)" : "var(--megane-border-strong)",
              transition: "background 0.15s",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: enabled ? 15 : 2,
                width: 13,
                height: 13,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                transition: "left 0.15s",
              }}
            />
          </button>
        </label>
      )}
      {onRemove && (
        <button
          type="button"
          data-testid={removeTestId}
          onClick={onRemove}
          disabled={removeDisabled}
          title="Remove node"
          aria-label="Remove node"
          style={{ ...headerIconButtonStyle, opacity: removeDisabled ? 0.4 : 1 }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--megane-danger)";
            e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--megane-text-muted)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** The selected node's errors and warnings, under its header. */
export function NodeMessages({
  messages,
  testId = "pipeline-properties-messages",
}: {
  messages: PaneMessage[];
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 14px 0" }}
    >
      {messages.map((e, i) => {
        const isError = e.severity === "error";
        const rgb = isError ? "239, 68, 68" : "245, 158, 11";
        return (
          <div
            key={i}
            role={isError ? "alert" : "status"}
            style={{
              display: "flex",
              gap: 6,
              alignItems: "flex-start",
              fontSize: 11.5,
              lineHeight: 1.4,
              padding: "5px 8px",
              borderRadius: 6,
              background: `rgba(${rgb}, 0.08)`,
              border: `1px solid rgba(${rgb}, 0.3)`,
              color: isError ? "var(--megane-danger-text)" : "var(--megane-warning-text)",
            }}
          >
            <span aria-hidden="true" style={{ fontWeight: 700 }}>
              {isError ? "!" : "⚠"}
            </span>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{e.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The pane with nothing selected: an icon and a hint. */
export function PropertiesEmpty({
  text,
  testId = "pipeline-properties-empty",
}: {
  text: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        margin: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        color: "var(--megane-text-muted)",
        textAlign: "center",
        padding: 16,
        lineHeight: 1.5,
      }}
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="13" height="8" rx="2" />
        <path d="M6.5 8h6" />
        <path d="M14 14l6 2.2-2.6 1.1-1.1 2.6z" />
      </svg>
      {text}
    </div>
  );
}

export interface PropertiesPaneViewProps {
  /** CSS height of the pane (its share of the editor). */
  height: string;
  /** Header, messages, … above the body; `empty` replaces them with nothing selected. */
  head?: ReactNode;
  empty?: ReactNode;
  /** Show the body (a node is selected). */
  bodyVisible: boolean;
  /** Fade the body (a switched-off node keeps its settings, faded). */
  bodyFaded?: boolean;
  children: ReactNode;
  /** The selected node's id: a new selection starts at the top of its form. */
  scrollKey?: string | null;
  testId?: string;
  bodyTestId?: string;
}

export function PropertiesPaneView({
  height,
  head,
  empty,
  bodyVisible,
  bodyFaded = false,
  children,
  scrollKey,
  testId = "pipeline-properties",
  bodyTestId = "pipeline-properties-body",
}: PropertiesPaneViewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scrollKey]);
  return (
    <div
      data-testid={testId}
      style={{
        flex: `0 0 ${height}`,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--megane-surface-solid)",
      }}
    >
      {bodyVisible ? head : empty}
      <div
        ref={bodyRef}
        data-testid={bodyTestId}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 14px 14px",
          display: bodyVisible ? "block" : "none",
          opacity: bodyFaded ? 0.55 : 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}
