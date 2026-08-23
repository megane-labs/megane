/**
 * Symmetry node — expands a crystallographic asymmetric unit into the full
 * unit cell by applying the space-group operations captured by the parser
 * (e.g. a CIF `_symmetry_equiv_pos_as_xyz` loop). "expand" is the default so
 * a loaded CIF shows the VESTA-style packed cell; "none" shows the raw
 * asymmetric unit.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { SymmetryMode, SymmetryParams } from "../../pipeline/types";
import { usePipelineStore } from "../../pipeline/store";
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

const SYMMETRY_OPTIONS: { value: SymmetryMode; label: string }[] = [
  { value: "expand", label: "Expand" },
  { value: "none", label: "None" },
];

export function SymmetryNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = usePipelineStore((s) => s.updateNodeParams);
  const params = data.params as SymmetryParams;

  return (
    <NodeShell id={id} nodeType="symmetry" enabled={data.enabled}>
      <div style={rowStyle}>
        <span>Mode</span>
        <select
          data-testid="symmetry-node-mode"
          className="nodrag"
          value={params.mode}
          onChange={(e) => updateNodeParams(id, { mode: e.target.value as SymmetryMode })}
          style={selectStyle}
        >
          {SYMMETRY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </NodeShell>
  );
}
