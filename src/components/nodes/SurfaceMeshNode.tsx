/**
 * Surface Mesh node.
 * Takes particle input, produces mesh output (OVITO-style alpha-shape envelope).
 * User controls probe radius, color, and opacity.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { SurfaceMeshParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  flex: 1,
};

const inputStyle: React.CSSProperties = {
  width: 72,
  padding: "3px 6px",
  fontSize: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  background: "var(--megane-node-bg, #fff)",
  color: "inherit",
  boxSizing: "border-box",
};

const colorStyle: React.CSSProperties = {
  width: 40,
  height: 26,
  padding: 2,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  cursor: "pointer",
  background: "none",
};

const sliderStyle: React.CSSProperties = {
  width: 90,
  accentColor: "#ec4899",
};

const valueStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#64748b",
  minWidth: 32,
  textAlign: "right",
};

export function SurfaceMeshNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as SurfaceMeshParams;

  return (
    <NodeShell id={id} nodeType="surface_mesh" enabled={data.enabled}>
      <div style={rowStyle}>
        <span style={labelStyle}>Alpha (Å)</span>
        <input
          type="number"
          className="nodrag"
          data-testid="surface-mesh-alpha"
          value={params.alphaRadius}
          min={0.5}
          max={10}
          step={0.1}
          style={inputStyle}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v > 0) updateNodeParams(id, { alphaRadius: v });
          }}
        />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Color</span>
        <input
          type="color"
          className="nodrag"
          data-testid="surface-mesh-color"
          value={params.color}
          style={colorStyle}
          onChange={(e) => updateNodeParams(id, { color: e.target.value })}
        />
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Opacity</span>
        <input
          type="range"
          className="nodrag"
          data-testid="surface-mesh-opacity"
          min={0}
          max={1}
          step={0.05}
          value={params.opacity}
          style={sliderStyle}
          onChange={(e) => updateNodeParams(id, { opacity: parseFloat(e.target.value) })}
        />
        <span style={valueStyle}>{Math.round(params.opacity * 100)}%</span>
      </div>
    </NodeShell>
  );
}
