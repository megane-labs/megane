/**
 * Vector Overlay node.
 * Takes vector input, applies scale, outputs vector for viewport rendering.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { VectorOverlayParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const labelStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  marginBottom: 3,
};

const sliderStyle: React.CSSProperties = {
  width: "100%",
  height: 7,
  cursor: "pointer",
};

const valueStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  color: "#3b82f6",
  minWidth: 40,
  textAlign: "right",
};

export function VectorOverlayNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as VectorOverlayParams;

  return (
    <NodeShell id={id} nodeType="vector_overlay" enabled={data.enabled}>
      <div style={labelStyle}>Scale</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          className="nodrag"
          type="range"
          min={0.1}
          max={5.0}
          step={0.1}
          value={params.scale}
          onChange={(e) => updateNodeParams(id, { scale: parseFloat(e.target.value) })}
          style={sliderStyle}
        />
        <span style={valueStyle}>{params.scale.toFixed(1)}</span>
      </div>
    </NodeShell>
  );
}
