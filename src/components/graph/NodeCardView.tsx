/**
 * The compact node card every node-graph editor draws: a category icon,
 * a title and a one-line summary, typed handles on top (inputs) and bottom
 * (outputs), and a status dot. Port names stay hidden until the card is
 * hovered or selected (see `NODE_CARD_CSS`), which keeps them from tangling
 * with the edges.
 *
 * Presentational only: the viewer's pipeline editor (`nodes/NodeCard.tsx`)
 * and megane Builder's Flow mode (`builder/flow/FlowNodeCard.tsx`) each map
 * their own store onto these props, so both graphs look the same.
 */

import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";

/** Width of every card; the layout reads the measured size anyway. */
export const NODE_CARD_WIDTH = 208;

/**
 * Hover rules that inline styles cannot express. Rendered once by the editor
 * inside the element carrying the `megane-split-editor` class.
 */
export const NODE_CARD_CSS = `
.megane-split-editor .megane-port-label { opacity: 0; transition: opacity 120ms ease; }
.megane-split-editor .react-flow__node:hover .megane-port-label,
.megane-split-editor .react-flow__node.selected .megane-port-label { opacity: 1; }
.megane-split-editor .megane-node-card { transition: box-shadow 120ms ease, border-color 120ms ease; }
.megane-split-editor .react-flow__node:hover .megane-node-card:not([data-selected="true"]) {
  border-color: var(--megane-border-strong);
}
`;

/** One handle of a card. */
export interface CardPort {
  /** Handle id. */
  name: string;
  label: string;
  /** The colour of the data type the port carries. */
  color: string;
  /** Drawn greyed out (no data on it). */
  disabled?: boolean;
}

/** The dot beside the title that says something is wrong (or how a run went). */
export interface CardStatus {
  color: string;
  /** Tooltip: the messages behind the dot. */
  title: string;
  testId: string;
}

export interface NodeCardViewProps {
  testId: string;
  nodeId: string;
  title: string;
  summary: string;
  /** Monospace summary (a query). */
  monoSummary?: boolean;
  summaryTestId?: string;
  icon: ReactNode;
  /** Category colour: the icon tile's tint. */
  color: string;
  inputs: CardPort[];
  outputs: CardPort[];
  /** A switched-off node: dashed, faded, marked Off. Default true. */
  enabled?: boolean;
  selected: boolean;
  /** Red border (an error). */
  error?: boolean;
  status?: CardStatus | null;
  /** Extra `data-*` attributes for the card. */
  data?: Record<`data-${string}`, string>;
}

function handleLeft(index: number, total: number): string {
  if (total === 1) return "50%";
  const step = 76 / (total - 1); // distribute across 12%-88%
  return `${12 + step * index}%`;
}

function Port({
  port,
  type,
  index,
  total,
}: {
  port: CardPort;
  type: "source" | "target";
  index: number;
  total: number;
}) {
  const disabled = port.disabled ?? false;
  const color = port.color;
  const isInput = type === "target";
  // Alternate label rows when ports are crowded (the viewport's seven
  // inputs) so neighbouring names never overlap.
  const row = total > 3 && index % 2 === 1 ? 1 : 0;
  const offset = -17 - row * 13;
  return (
    <Handle
      type={type}
      position={isInput ? Position.Top : Position.Bottom}
      id={port.name}
      title={port.label}
      style={{
        width: 9,
        height: 9,
        left: handleLeft(index, total),
        background: disabled ? "var(--megane-border-strong)" : color,
        border: "2px solid var(--megane-surface-solid)",
        boxShadow: disabled ? "none" : `0 0 0 1px ${color}`,
      }}
    >
      <span
        className="megane-port-label"
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          [isInput ? "top" : "bottom"]: offset,
          fontSize: 9,
          lineHeight: "12px",
          padding: "0 4px",
          borderRadius: 4,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          color: disabled ? "var(--megane-text-faint)" : "var(--megane-text-secondary)",
          background: "var(--megane-surface-solid)",
          border: "1px solid var(--megane-border-solid)",
        }}
      >
        {port.label}
      </span>
    </Handle>
  );
}

export function NodeCardView({
  testId,
  nodeId,
  title,
  summary,
  monoSummary = false,
  summaryTestId,
  icon,
  color,
  inputs,
  outputs,
  enabled = true,
  selected,
  error = false,
  status,
  data,
}: NodeCardViewProps) {
  const borderColor = selected
    ? "var(--megane-primary)"
    : error
      ? "var(--megane-danger)"
      : "var(--megane-border-solid)";

  return (
    <div
      className="megane-node-card"
      data-testid={testId}
      data-node-id={nodeId}
      data-enabled={enabled ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      {...data}
      style={{
        width: NODE_CARD_WIDTH,
        boxSizing: "border-box",
        background: "var(--megane-surface-solid)",
        border: `1px ${enabled ? "solid" : "dashed"} ${borderColor}`,
        borderRadius: 10,
        boxShadow: selected
          ? "0 0 0 3px color-mix(in srgb, var(--megane-primary) 22%, transparent)"
          : "0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.05)",
        opacity: enabled ? 1 : 0.55,
      }}
    >
      {inputs.map((port, i) => (
        <Port key={`in-${port.name}`} port={port} type="target" index={i} total={inputs.length} />
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px" }}>
        <div
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: 6,
            display: "grid",
            placeItems: "center",
            color,
            background: `color-mix(in srgb, ${color} 14%, transparent)`,
          }}
        >
          {icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.3,
              color: "var(--megane-text)",
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </div>
          <div
            data-testid={summaryTestId}
            title={summary}
            style={{
              fontSize: 10.5,
              lineHeight: 1.35,
              color: "var(--megane-text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontFamily: monoSummary
                ? "ui-monospace, SFMono-Regular, Menlo, monospace"
                : undefined,
            }}
          >
            {summary}
          </div>
        </div>
        {!enabled && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--megane-text-muted)",
              border: "1px solid var(--megane-border-strong)",
              borderRadius: 4,
              padding: "1px 4px",
            }}
          >
            Off
          </span>
        )}
        {status && (
          <span
            data-testid={status.testId}
            title={status.title}
            style={{
              width: 8,
              height: 8,
              flexShrink: 0,
              borderRadius: "50%",
              background: status.color,
              boxShadow: `0 0 0 3px color-mix(in srgb, ${status.color} 20%, transparent)`,
            }}
          />
        )}
      </div>

      {outputs.map((port, i) => (
        <Port key={`out-${port.name}`} port={port} type="source" index={i} total={outputs.length} />
      ))}
    </div>
  );
}
