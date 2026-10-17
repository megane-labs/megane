import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { PolyhedronGeneratorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { Field, FormStack, SliderField } from "./form";
import { checkboxStyle, colorInputStyle, inputStyle } from "./formStyles";

export function PolyhedronGeneratorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const params = data.params as PolyhedronGeneratorParams;

  return (
    <NodeShell id={id} nodeType="polyhedron_generator" enabled={data.enabled}>
      <FormStack>
        <SliderField
          label="Opacity"
          min={0}
          max={1}
          step={0.05}
          value={params.opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateNodeParams(id, { opacity: v })}
        />
        <Field label="Show edges">
          <input
            type="checkbox"
            checked={params.showEdges}
            style={checkboxStyle}
            onChange={(event) => updateNodeParams(id, { showEdges: event.target.checked })}
          />
        </Field>
        {params.showEdges && (
          <>
            <Field label="Edge color">
              <input
                type="color"
                value={params.edgeColor}
                style={colorInputStyle}
                onChange={(event) => updateNodeParams(id, { edgeColor: event.target.value })}
              />
            </Field>
            <Field label="Edge width">
              <input
                className="nodrag"
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={params.edgeWidth}
                style={inputStyle}
                onChange={(event) =>
                  updateNodeParams(id, { edgeWidth: Number(event.target.value) })
                }
              />
            </Field>
          </>
        )}
      </FormStack>
    </NodeShell>
  );
}
