/**
 * Modify node — adjusts scale and opacity of incoming data.
 * Accepts particle or bond input.
 *
 * Color and representation were split into their own dedicated nodes so each
 * modifier owns a single visual property (Ovito-style modifier stack).
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { ModifyParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const sliderStyle: React.CSSProperties = {
  width: "100%",
  height: 7,
  cursor: "pointer",
  appearance: "none",
  WebkitAppearance: "none",
  borderRadius: 3,
  outline: "none",
};

const valueStyle: React.CSSProperties = {
  fontSize: 19,
  fontWeight: 500,
  color: "#3b82f6",
  minWidth: 50,
  textAlign: "right",
};

const labelStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  marginBottom: 3,
};

export function ModifyNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as ModifyParams;

  return (
    <NodeShell id={id} nodeType="modify" enabled={data.enabled}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={labelStyle}>Scale</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              data-testid="modify-node-scale"
              className="nodrag"
              type="range"
              min={0.1}
              max={2.0}
              step={0.01}
              value={params.scale}
              onChange={(e) => updateNodeParams(id, { scale: parseFloat(e.target.value) })}
              style={sliderStyle}
            />
            <span style={valueStyle}>{params.scale.toFixed(2)}</span>
          </div>
        </div>
        <div>
          <div style={labelStyle}>Opacity</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              data-testid="modify-node-opacity"
              className="nodrag"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={params.opacity}
              onChange={(e) => updateNodeParams(id, { opacity: parseFloat(e.target.value) })}
              style={sliderStyle}
            />
            <span style={valueStyle}>{`${Math.round(params.opacity * 100)}%`}</span>
          </div>
        </div>
      </div>
    </NodeShell>
  );
}
