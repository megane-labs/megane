/**
 * Shared node shell for all pipeline nodes.
 * Renders header with title, enable/disable toggle, delete button,
 * error indicator with tooltip, and typed input/output handles.
 */

import { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { PipelineNodeType, PortDefinition, NodeError } from "../../pipeline/types";
import {
  NODE_TYPE_LABELS,
  NODE_PORTS,
  DATA_TYPE_COLORS,
  NODE_CATEGORY,
  NODE_CATEGORY_COLORS,
} from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";

interface NodeShellProps {
  id: string;
  nodeType: PipelineNodeType;
  enabled: boolean;
  children: React.ReactNode;
  /** Port names that should be visually disabled (grayed out). */
  disabledPorts?: Set<string>;
}

const nodeStyle: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.95)",
  backdropFilter: "blur(8px)",
  border: "1px solid #e2e8f0",
  borderRadius: 14,
  minWidth: 340,
  maxWidth: 420,
  fontSize: 20,
  boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
};

const disabledStyle: React.CSSProperties = {
  ...nodeStyle,
  opacity: 0.5,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 17px",
  borderBottom: "1px solid #e2e8f0",
  gap: 10,
};

const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 19,
  color: "#1e293b",
  letterSpacing: "-0.02em",
  flex: 1,
};

const iconBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 19,
  color: "#94a3b8",
  padding: "3px 7px",
  lineHeight: 1,
};

const bodyStyle: React.CSSProperties = {
  padding: "14px 17px",
};

const baseHandleStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  border: "3px solid white",
  boxShadow: "0 0 3px rgba(0,0,0,0.2)",
};

const handleLabelStyle: React.CSSProperties = {
  position: "absolute",
  fontSize: 14,
  color: "#94a3b8",
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

const EMPTY_ERRORS: NodeError[] = [];

const errorIndicatorStyle: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: "50%",
  fontSize: 13,
  fontWeight: 700,
  cursor: "default",
  flexShrink: 0,
  lineHeight: 1,
};

const tooltipStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
  padding: "8px 12px",
  zIndex: 1000,
  minWidth: 200,
  maxWidth: 300,
  fontSize: 13,
  lineHeight: 1.4,
  color: "#334155",
  pointerEvents: "none",
};

function ErrorIndicator({ errors }: { errors: NodeError[] }) {
  const [hovered, setHovered] = useState(false);
  const hasError = errors.some((e) => e.severity === "error");
  const color = hasError ? "#ef4444" : "#f59e0b";
  const bgColor = hasError ? "rgba(239, 68, 68, 0.12)" : "rgba(245, 158, 11, 0.12)";

  return (
    <div
      style={{ ...errorIndicatorStyle, background: bgColor, color }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      !
      {hovered && (
        <div style={tooltipStyle}>
          {errors.map((err, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                marginBottom: i < errors.length - 1 ? 4 : 0,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: err.severity === "error" ? "#ef4444" : "#f59e0b",
                  flexShrink: 0,
                  marginTop: 5,
                }}
              />
              <span>{err.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function getHandleColor(port: PortDefinition, disabled?: boolean): string {
  if (disabled) return "#cbd5e1"; // slate-300 gray
  return DATA_TYPE_COLORS[port.dataType];
}

/**
 * Compute handle positions evenly distributed across the node width.
 * Returns a percentage (0-100) for the `left` CSS property.
 */
function getHandlePosition(index: number, total: number): string {
  if (total === 1) return "50%";
  const step = 80 / (total - 1); // distribute across 10%-90%
  return `${10 + step * index}%`;
}

export function NodeShell({ id, nodeType, enabled, children, disabledPorts }: NodeShellProps) {
  const toggleNode = useScopedPipelineStore((s) => s.toggleNode);
  const removeNode = useScopedPipelineStore((s) => s.removeNode);
  const errors = useScopedPipelineStore((s) => s.nodeErrors[id] ?? EMPTY_ERRORS);
  const ports = NODE_PORTS[nodeType];
  const categoryColor = NODE_CATEGORY_COLORS[NODE_CATEGORY[nodeType]];

  const hasError = errors.some((e) => e.severity === "error");
  const hasWarning = errors.length > 0 && !hasError;
  const borderColor = hasError ? "#ef4444" : hasWarning ? "#f59e0b" : "#e2e8f0";

  const containerStyle: React.CSSProperties = {
    ...(enabled ? nodeStyle : disabledStyle),
    borderLeft: `5px solid ${categoryColor}`,
    borderColor,
    borderLeftColor: categoryColor,
  };

  return (
    <div
      style={containerStyle}
      data-testid={`pipeline-node-${nodeType}`}
      data-node-id={id}
      data-enabled={enabled ? "true" : "false"}
    >
      {/* Input handles */}
      {ports.inputs.map((port, i) => {
        const isDisabled = disabledPorts?.has(port.name) ?? false;
        return (
          <Handle
            key={`in-${port.name}`}
            type="target"
            position={Position.Top}
            id={port.name}
            style={{
              ...baseHandleStyle,
              background: getHandleColor(port, isDisabled),
              left: getHandlePosition(i, ports.inputs.length),
            }}
          >
            <span
              style={{
                ...handleLabelStyle,
                top: -22,
                left: "50%",
                transform: "translateX(-50%)",
                color: isDisabled ? "#cbd5e1" : "#94a3b8",
              }}
            >
              {port.label}
            </span>
          </Handle>
        );
      })}

      <div style={headerStyle}>
        <span style={titleStyle}>{NODE_TYPE_LABELS[nodeType]}</span>
        {errors.length > 0 && <ErrorIndicator errors={errors} />}
        <div
          onClick={() => toggleNode(id)}
          style={{
            width: 48,
            height: 24,
            borderRadius: 12,
            background: enabled ? "#3b82f6" : "#cbd5e1",
            position: "relative",
            cursor: "pointer",
            transition: "background 0.15s",
            flexShrink: 0,
          }}
          title={enabled ? "Disable node" : "Enable node"}
        >
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "white",
              position: "absolute",
              top: 3,
              left: enabled ? 27 : 3,
              transition: "left 0.15s",
            }}
          />
        </div>
        {nodeType !== "viewport" && (
          <button onClick={() => removeNode(id)} style={iconBtnStyle} title="Remove node">
            &times;
          </button>
        )}
      </div>
      <div style={bodyStyle}>{children}</div>

      {/* Output handles */}
      {ports.outputs.map((port, i) => {
        const isDisabled = disabledPorts?.has(port.name) ?? false;
        return (
          <Handle
            key={`out-${port.name}`}
            type="source"
            position={Position.Bottom}
            id={port.name}
            style={{
              ...baseHandleStyle,
              background: getHandleColor(port, isDisabled),
              left: getHandlePosition(i, ports.outputs.length),
            }}
          >
            <span
              style={{
                ...handleLabelStyle,
                bottom: -22,
                left: "50%",
                transform: "translateX(-50%)",
                color: isDisabled ? "#cbd5e1" : "#94a3b8",
              }}
            >
              {port.label}
            </span>
          </Handle>
        );
      })}
    </div>
  );
}
