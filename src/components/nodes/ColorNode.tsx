/**
 * Color node — recolors the upstream particle stream by a chosen scheme
 * (uniform / element / residue / chain / B-factor / property). Extracted from
 * the original Modify node so each modifier owns a single visual property.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { ColorMode, ColorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { Field, FormStack } from "./form";
import { colorInputStyle, selectStyle } from "./formStyles";

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
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as ColorParams;

  return (
    <NodeShell id={id} nodeType="color" enabled={data.enabled}>
      <FormStack>
        <Field label="Mode">
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
        </Field>
        {params.mode === "uniform" && (
          <Field label="Color">
            <input
              data-testid="color-node-uniform-color"
              className="nodrag"
              type="color"
              value={params.uniformColor}
              onChange={(e) => updateNodeParams(id, { uniformColor: e.target.value })}
              style={colorInputStyle}
            />
          </Field>
        )}
      </FormStack>
    </NodeShell>
  );
}
