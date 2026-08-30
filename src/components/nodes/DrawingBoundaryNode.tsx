import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { DrawingBoundaryParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const inputStyle: React.CSSProperties = {
  width: 78,
  padding: "4px 6px",
  border: "1px solid #cbd5e1",
  borderRadius: 5,
  background: "var(--megane-node-bg, #fff)",
  color: "inherit",
  fontSize: 16,
};

const AXES = [
  ["a", "xMin", "xMax"],
  ["b", "yMin", "yMax"],
  ["c", "zMin", "zMax"],
] as const;

export function DrawingBoundaryNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const params = data.params as DrawingBoundaryParams;

  return (
    <NodeShell id={id} nodeType="drawing_boundary" enabled={data.enabled}>
      <div style={{ color: "#64748b", fontSize: 13, lineHeight: 1.3, marginBottom: 8 }}>
        Show periodic atom images inside these inclusive fractional-coordinate ranges.
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "24px 1fr 1fr",
          alignItems: "center",
          gap: "6px 8px",
        }}
      >
        <span />
        <span style={{ fontSize: 14, color: "#64748b" }}>Min</span>
        <span style={{ fontSize: 14, color: "#64748b" }}>Max</span>
        {AXES.map(([label, minKey, maxKey]) => (
          <div key={label} style={{ display: "contents" }}>
            <strong style={{ color: "#475569" }}>{label}</strong>
            <input
              className="nodrag"
              type="number"
              step={0.1}
              value={params[minKey]}
              aria-label={`${label} minimum`}
              data-testid={`drawing-boundary-${label}-min`}
              style={inputStyle}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) updateNodeParams(id, { [minKey]: value });
              }}
            />
            <input
              className="nodrag"
              type="number"
              step={0.1}
              value={params[maxKey]}
              aria-label={`${label} maximum`}
              data-testid={`drawing-boundary-${label}-max`}
              style={inputStyle}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) updateNodeParams(id, { [maxKey]: value });
              }}
            />
          </div>
        ))}
      </div>
    </NodeShell>
  );
}
