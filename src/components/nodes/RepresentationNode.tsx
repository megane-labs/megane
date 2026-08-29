/**
 * Representation node — picks the visual representation (atoms / cartoon /
 * both / surface / illustrative) for the upstream particle stream. Stacks Ovito-style: the
 * Viewport reads the override from the first particle stream that carries one.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { RepresentationMode, RepresentationParams } from "../../pipeline/types";
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

const REPRESENTATION_OPTIONS: { value: RepresentationMode; label: string }[] = [
  { value: "atoms", label: "Atoms" },
  { value: "licorice", label: "Licorice" },
  { value: "cartoon", label: "Cartoon" },
  { value: "both", label: "Both" },
  { value: "surface", label: "Surface" },
  { value: "line", label: "Line" },
  { value: "illustrative", label: "Illustrative" },
];

export function RepresentationNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = usePipelineStore((s) => s.updateNodeParams);
  const params = data.params as RepresentationParams;

  return (
    <NodeShell id={id} nodeType="representation" enabled={data.enabled}>
      <div style={rowStyle}>
        <span>Mode</span>
        <select
          data-testid="representation-node-mode"
          className="nodrag"
          value={params.mode}
          onChange={(e) => updateNodeParams(id, { mode: e.target.value as RepresentationMode })}
          style={selectStyle}
        >
          {REPRESENTATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </NodeShell>
  );
}
