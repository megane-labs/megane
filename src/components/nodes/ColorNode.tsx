/**
 * Color node — recolors the upstream particle stream by a chosen scheme
 * (uniform / element / residue / chain / B-factor / property). Extracted from
 * the original Modify node so each modifier owns a single visual property.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { ColorMode, ColorParams } from "../../pipeline/types";
import { usePipelineStore } from "../../pipeline/store";
import { NodeShell } from "./NodeShell";

const labelStyle: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 500,
  color: "#64748b",
  marginBottom: 3,
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
};

const colorPickerStyle: React.CSSProperties = {
  width: 36,
  height: 24,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  cursor: "pointer",
  padding: 0,
  background: "transparent",
};

const COLOR_MODE_LABELS: Record<ColorMode, string> = {
  uniform: "Uniform",
  byElement: "Element",
  byResidue: "Residue",
  byChain: "Chain",
  byBFactor: "B-Factor",
  byProperty: "Property",
  illustrative: "Illustrative",
};

export function ColorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = usePipelineStore((s) => s.updateNodeParams);
  const params = data.params as ColorParams;

  return (
    <NodeShell id={id} nodeType="color" enabled={data.enabled}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={labelStyle}>Mode</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            data-testid="color-node-mode"
            className="nodrag"
            value={params.mode}
            onChange={(e) => updateNodeParams(id, { mode: e.target.value as ColorMode })}
            style={selectStyle}
          >
            {(Object.entries(COLOR_MODE_LABELS) as [ColorMode, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {params.mode === "uniform" && (
            <input
              data-testid="color-node-uniform-color"
              className="nodrag"
              type="color"
              value={params.uniformColor}
              onChange={(e) => updateNodeParams(id, { uniformColor: e.target.value })}
              style={colorPickerStyle}
            />
          )}
        </div>
      </div>
    </NodeShell>
  );
}
