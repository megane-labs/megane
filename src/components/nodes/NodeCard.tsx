/**
 * Compact node card for the split pipeline editor: category icon, title and a
 * one-line parameter summary. The node's form is edited in the properties
 * pane, so the card carries no controls of its own. Port names stay hidden
 * until the card is hovered or selected (see `NODE_CARD_CSS`), which keeps
 * them from tangling with the edges.
 */

import { Handle, Position } from "@xyflow/react";
import type { PipelineNodeType, PortDefinition, NodeError } from "../../pipeline/types";
import {
  NODE_TYPE_LABELS,
  NODE_PORTS,
  DATA_TYPE_COLORS,
  NODE_CATEGORY,
  NODE_CATEGORY_COLORS,
} from "../../pipeline/types";
import { summarizeNodeParams } from "../../pipeline/nodeSummary";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { CATEGORY_ICONS } from "./categoryIcons";

const EMPTY_ERRORS: NodeError[] = [];

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

const QUERY_TYPES: ReadonlySet<PipelineNodeType> = new Set(["filter"]);

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
  disabled,
}: {
  port: PortDefinition;
  type: "source" | "target";
  index: number;
  total: number;
  disabled: boolean;
}) {
  const color = DATA_TYPE_COLORS[port.dataType];
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

export function NodeCard({
  id,
  nodeType,
  enabled,
  disabledPorts,
}: {
  id: string;
  nodeType: PipelineNodeType;
  enabled: boolean;
  disabledPorts?: Set<string>;
}) {
  const node = useScopedPipelineStore((s) => s.nodes.find((n) => n.id === id));
  const errors = useScopedPipelineStore((s) => s.nodeErrors[id] ?? EMPTY_ERRORS);
  const ports = NODE_PORTS[nodeType];
  const category = NODE_CATEGORY[nodeType];
  const color = NODE_CATEGORY_COLORS[category];
  const selected = node?.selected === true;
  const summary = node ? summarizeNodeParams(node.data.params) : "";

  const hasError = errors.some((e) => e.severity === "error");
  const statusColor = hasError ? "var(--megane-danger)" : errors.length > 0 ? "#f59e0b" : null;
  const borderColor = selected
    ? "var(--megane-primary)"
    : hasError
      ? "var(--megane-danger)"
      : "var(--megane-border-solid)";

  return (
    <div
      className="megane-node-card"
      data-testid={`pipeline-node-${nodeType}`}
      data-node-id={id}
      data-enabled={enabled ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
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
      {ports.inputs.map((port, i) => (
        <Port
          key={`in-${port.name}`}
          port={port}
          type="target"
          index={i}
          total={ports.inputs.length}
          disabled={disabledPorts?.has(port.name) ?? false}
        />
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
          {CATEGORY_ICONS[category]}
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
            {NODE_TYPE_LABELS[nodeType]}
          </div>
          <div
            data-testid="pipeline-node-summary"
            title={summary}
            style={{
              fontSize: 10.5,
              lineHeight: 1.35,
              color: "var(--megane-text-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontFamily: QUERY_TYPES.has(nodeType)
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
        {statusColor && (
          <span
            data-testid="pipeline-node-status"
            title={errors.map((e) => e.message).join("\n")}
            style={{
              width: 8,
              height: 8,
              flexShrink: 0,
              borderRadius: "50%",
              background: statusColor,
              boxShadow: `0 0 0 3px color-mix(in srgb, ${statusColor} 20%, transparent)`,
            }}
          />
        )}
      </div>

      {ports.outputs.map((port, i) => (
        <Port
          key={`out-${port.name}`}
          port={port}
          type="source"
          index={i}
          total={ports.outputs.length}
          disabled={disabledPorts?.has(port.name) ?? false}
        />
      ))}
    </div>
  );
}
