/**
 * Replicate node — OVITO/VESTA-style supercell builder.
 * Takes particle + cell input, produces a replicated particle + enlarged cell.
 * User controls the number of cell images along X, Y, Z (>= 1).
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { ReplicateParams } from "../../pipeline/types";
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

type Axis = "nx" | "ny" | "nz";

const AXES: { key: Axis; label: string; testId: string }[] = [
  { key: "nx", label: "X", testId: "replicate-node-nx" },
  { key: "ny", label: "Y", testId: "replicate-node-ny" },
  { key: "nz", label: "Z", testId: "replicate-node-nz" },
];

export function ReplicateNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as ReplicateParams;

  return (
    <NodeShell id={id} nodeType="replicate" enabled={data.enabled}>
      {AXES.map(({ key, label, testId }) => (
        <div style={rowStyle} key={key}>
          <span style={labelStyle}>{label}</span>
          <input
            type="number"
            className="nodrag"
            data-testid={testId}
            value={params[key]}
            min={1}
            step={1}
            style={inputStyle}
            onChange={(e) => {
              const v = Math.floor(parseFloat(e.target.value));
              if (!isNaN(v) && v >= 1) updateNodeParams(id, { [key]: v });
            }}
          />
        </div>
      ))}
    </NodeShell>
  );
}
