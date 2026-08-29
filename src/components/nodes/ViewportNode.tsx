/**
 * Viewport node — terminal sink.
 * Accepts particle, bond, cell, label, mesh inputs.
 * Display settings (perspective, axes, pivot marker) are parameters.
 * Visual representation is set on the dedicated `representation` node and
 * propagated through the particle stream.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { ViewportParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 19,
  color: "#475569",
  padding: "3px 0",
};

const toggleStyle: React.CSSProperties = {
  cursor: "pointer",
  accentColor: "#3b82f6",
};

export function ViewportNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as ViewportParams;

  return (
    <NodeShell id={id} nodeType="viewport" enabled={data.enabled}>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label style={toggleRowStyle}>
          Perspective
          <input
            type="checkbox"
            checked={params.perspective}
            onChange={(e) => updateNodeParams(id, { perspective: e.target.checked })}
            style={toggleStyle}
          />
        </label>
        <label style={toggleRowStyle}>
          Cell axes
          <input
            type="checkbox"
            checked={params.cellAxesVisible}
            onChange={(e) => updateNodeParams(id, { cellAxesVisible: e.target.checked })}
            style={toggleStyle}
          />
        </label>
        <label style={toggleRowStyle}>
          Pivot marker
          <input
            type="checkbox"
            checked={params.pivotMarkerVisible}
            onChange={(e) => updateNodeParams(id, { pivotMarkerVisible: e.target.checked })}
            style={toggleStyle}
          />
        </label>
      </div>
    </NodeShell>
  );
}
