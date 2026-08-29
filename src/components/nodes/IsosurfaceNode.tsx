/**
 * Isosurface node.
 * Controls iso level, color, opacity, and optional dual-contour (negative lobe).
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { IsosurfaceParams } from "../../pipeline/types";
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
  accentColor: "#06b6d4",
};

const valueStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#64748b",
  minWidth: 32,
  textAlign: "right",
};

const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 8,
};

export function IsosurfaceNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as IsosurfaceParams;

  return (
    <NodeShell id={id} nodeType="isosurface" enabled={data.enabled}>
      {/* Iso level */}
      <div style={rowStyle}>
        <span style={labelStyle}>Iso level</span>
        <input
          type="number"
          className="nodrag"
          data-testid="isosurface-level"
          value={params.isoLevel}
          step={0.001}
          style={inputStyle}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) updateNodeParams(id, { isoLevel: v });
          }}
        />
      </div>

      {/* Positive color */}
      <div style={rowStyle}>
        <span style={labelStyle}>Color (+)</span>
        <input
          type="color"
          className="nodrag"
          data-testid="isosurface-color"
          value={params.color}
          style={colorStyle}
          onChange={(e) => updateNodeParams(id, { color: e.target.value })}
        />
      </div>

      {/* Opacity */}
      <div style={rowStyle}>
        <span style={labelStyle}>Opacity</span>
        <input
          type="range"
          className="nodrag"
          data-testid="isosurface-opacity"
          min={0}
          max={1}
          step={0.05}
          value={params.opacity}
          style={sliderStyle}
          onChange={(e) => updateNodeParams(id, { opacity: parseFloat(e.target.value) })}
        />
        <span style={valueStyle}>{Math.round(params.opacity * 100)}%</span>
      </div>

      {/* Dual contour toggle */}
      <div style={checkboxRowStyle}>
        <input
          type="checkbox"
          className="nodrag"
          id={`${id}-neg`}
          data-testid="isosurface-show-negative"
          checked={params.showNegative}
          onChange={(e) => updateNodeParams(id, { showNegative: e.target.checked })}
        />
        <label htmlFor={`${id}-neg`} style={{ fontSize: 17, color: "#64748b" }}>
          Show negative lobe
        </label>
      </div>

      {/* Negative color (shown only when toggle is on) */}
      {params.showNegative && (
        <div style={rowStyle}>
          <span style={labelStyle}>Color (−)</span>
          <input
            type="color"
            className="nodrag"
            data-testid="isosurface-negative-color"
            value={params.negativeColor}
            style={colorStyle}
            onChange={(e) => updateNodeParams(id, { negativeColor: e.target.value })}
          />
        </div>
      )}
    </NodeShell>
  );
}
