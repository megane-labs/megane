/**
 * Wrap / Unwrap node — toggles periodic-image coordinate mapping for the
 * upstream particle stream (and its trajectory): fold atoms into the home
 * unit cell ("wrap") or make molecules split across a periodic face whole
 * again ("unwrap"). "none" passes coordinates through untouched.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { WrapMode, WrapParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  padding: "3px 0",
};

const selectStyle: React.CSSProperties = {
  fontSize: 14,
  color: "#334155",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  padding: "3px 6px",
  cursor: "pointer",
  flex: 1,
  marginLeft: 8,
};

const WRAP_OPTIONS: { value: WrapMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "wrap", label: "Wrap" },
  { value: "unwrap", label: "Unwrap" },
];

export function WrapNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as WrapParams;

  return (
    <NodeShell id={id} nodeType="wrap" enabled={data.enabled}>
      <div style={rowStyle}>
        <span>Mode</span>
        <select
          data-testid="wrap-node-mode"
          className="nodrag"
          value={params.mode}
          onChange={(e) => updateNodeParams(id, { mode: e.target.value as WrapMode })}
          style={selectStyle}
        >
          {WRAP_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </NodeShell>
  );
}
