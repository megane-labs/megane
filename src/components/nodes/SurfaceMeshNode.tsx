/**
 * Surface Mesh node.
 * Takes particle input, produces mesh output (OVITO-style alpha-shape envelope).
 * User controls probe radius, color, and opacity.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { SurfaceMeshParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { Field, FormStack, SliderField } from "./form";
import { colorInputStyle, inputStyle } from "./formStyles";

export function SurfaceMeshNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as SurfaceMeshParams;

  return (
    <NodeShell id={id} nodeType="surface_mesh" enabled={data.enabled}>
      <FormStack>
        <Field label="Alpha (Å)">
          <input
            type="number"
            className="nodrag"
            data-testid="surface-mesh-alpha"
            value={params.alphaRadius}
            min={0.5}
            max={10}
            step={0.1}
            style={inputStyle}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && v > 0) updateNodeParams(id, { alphaRadius: v });
            }}
          />
        </Field>
        <Field label="Color">
          <input
            type="color"
            className="nodrag"
            data-testid="surface-mesh-color"
            value={params.color}
            style={colorInputStyle}
            onChange={(e) => updateNodeParams(id, { color: e.target.value })}
          />
        </Field>
        <SliderField
          label="Opacity"
          testId="surface-mesh-opacity"
          min={0}
          max={1}
          step={0.05}
          value={params.opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateNodeParams(id, { opacity: v })}
        />
      </FormStack>
    </NodeShell>
  );
}
