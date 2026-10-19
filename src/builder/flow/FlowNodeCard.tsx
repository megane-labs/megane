/**
 * One block in the Flow graph: a compact card with its title, its settings
 * in a line, its run status, an input handle on top per input, and the
 * output handle at the bottom. Like the viewer's pipeline cards, the card
 * has no controls; the block is edited in the pane under the graph.
 */

import { memo, useMemo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { allMolecules, useLibraryStore } from "../library/store";
import { useScopedFlowStore, useScopedToolsStore } from "../BuilderStores";
import { blockSubtitle, blockTitle, runStatusColor, runStatusText } from "./describe";
import { blockPorts, type FlowPort } from "./ports";
import { IDLE_RUN, OUTPUT_HANDLE, type FlowNodeData } from "./types";

export const FLOW_CARD_WIDTH = 210;

/** Handle colours: a molecule, a structure to add to, and what a block puts out. */
const PORT_COLORS: Record<FlowPort["kind"] | "out", string> = {
  molecule: "#10b981",
  document: "#3b82f6",
  out: "#64748b",
};

function handleLeft(index: number, total: number): string {
  if (total === 1) return "50%";
  return `${15 + (70 / (total - 1)) * index}%`;
}

function PortHandle({
  id,
  label,
  type,
  color,
  left,
  required,
}: {
  id: string;
  label: string;
  type: "source" | "target";
  color: string;
  left: string;
  required?: boolean;
}) {
  const isInput = type === "target";
  return (
    <Handle
      type={type}
      id={id}
      position={isInput ? Position.Top : Position.Bottom}
      title={label}
      data-testid={`builder-flow-handle-${id}`}
      style={{
        width: 10,
        height: 10,
        left,
        background: color,
        border: "2px solid var(--megane-surface-solid, #fff)",
        boxShadow: `0 0 0 1px ${color}`,
      }}
    >
      <span
        className="megane-flow-port-label"
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          [isInput ? "top" : "bottom"]: -18,
          fontSize: 9,
          lineHeight: "12px",
          padding: "0 4px",
          borderRadius: 4,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          color: "var(--megane-text-secondary, #64748b)",
          background: "var(--megane-surface-solid, #fff)",
          border: "1px solid var(--megane-border-solid, #e2e8f0)",
        }}
      >
        {label}
        {required ? "" : isInput ? " (optional)" : ""}
      </span>
    </Handle>
  );
}

export const FlowNodeCard = memo(function FlowNodeCard({
  id,
  data,
  selected,
}: NodeProps<Node<FlowNodeData>>) {
  const params = data.params;
  const run = useScopedFlowStore((s) => s.runs[id] ?? IDLE_RUN);
  const edges = useScopedFlowStore((s) => s.edges);
  const connection = useScopedToolsStore((s) => s.connection);
  const user = useLibraryStore((s) => s.user);
  const tool =
    params.type === "tool"
      ? (connection?.listing.tools.find((t) => t.name === params.tool) ?? null)
      : null;
  const wired = useMemo(
    () => edges.filter((e) => e.target === id).map((e) => e.targetHandle ?? ""),
    [edges, id],
  );
  const ports = blockPorts(params, tool, wired);
  const library = useMemo(() => allMolecules({ user }), [user]);
  const status = runStatusText(run);

  return (
    <div
      className="megane-flow-card"
      data-testid={`builder-flow-node-${params.type}`}
      data-node-id={id}
      data-status={run.status}
      data-selected={selected ? "true" : "false"}
      style={{
        width: FLOW_CARD_WIDTH,
        boxSizing: "border-box",
        background: "var(--megane-surface-solid, #fff)",
        border: `1px solid ${
          selected
            ? "var(--megane-primary, #3b82f6)"
            : run.status === "error"
              ? "var(--megane-danger, #ef4444)"
              : "var(--megane-border-solid, #e2e8f0)"
        }`,
        borderRadius: 10,
        boxShadow: selected
          ? "0 0 0 3px color-mix(in srgb, var(--megane-primary, #3b82f6) 22%, transparent)"
          : "0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.05)",
      }}
    >
      {ports.map((port, i) => (
        <PortHandle
          key={port.key}
          id={port.key}
          label={port.multiple ? `${port.label} (any number)` : port.label}
          type="target"
          color={PORT_COLORS[port.kind]}
          left={handleLeft(i, ports.length)}
          required={port.required}
        />
      ))}
      <div style={{ padding: "7px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.3,
            color: "var(--megane-text, #1e293b)",
          }}
        >
          {blockTitle(params, tool)}
        </div>
        <div
          title={blockSubtitle(params, library)}
          style={{
            fontSize: 10.5,
            lineHeight: 1.35,
            color: "var(--megane-text-muted, #94a3b8)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {blockSubtitle(params, library)}
        </div>
        <div
          data-testid="builder-flow-node-status"
          title={status}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 10.5,
            lineHeight: 1.35,
            color:
              run.status === "error"
                ? "var(--megane-danger-text, #b91c1c)"
                : "var(--megane-text-secondary, #64748b)",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              flexShrink: 0,
              borderRadius: "50%",
              background: runStatusColor(run),
            }}
          />
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {status}
          </span>
        </div>
      </div>
      <PortHandle
        id={OUTPUT_HANDLE}
        label="structure"
        type="source"
        color={PORT_COLORS.out}
        left="50%"
        required
      />
    </div>
  );
});

/** xyflow node types of the Flow graph: every block uses the same card. */
export const flowNodeTypes = {
  molecule: FlowNodeCard,
  document: FlowNodeCard,
  tool: FlowNodeCard,
};

/** Hover rules inline styles cannot express: port names show on hover or selection. */
export const FLOW_CARD_CSS = `
.megane-flow-editor .megane-flow-port-label { opacity: 0; transition: opacity 120ms ease; }
.megane-flow-editor .react-flow__node:hover .megane-flow-port-label,
.megane-flow-editor .react-flow__node.selected .megane-flow-port-label { opacity: 1; }
`;
