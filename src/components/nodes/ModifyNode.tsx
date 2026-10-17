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
import { FormStack, SliderField } from "./form";

export function ModifyNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as ModifyParams;

  return (
    <NodeShell id={id} nodeType="modify" enabled={data.enabled}>
      <FormStack>
        <SliderField
          label="Scale"
          testId="modify-node-scale"
          min={0.1}
          max={2.0}
          step={0.01}
          value={params.scale}
          format={(v) => v.toFixed(2)}
          onChange={(v) => updateNodeParams(id, { scale: v })}
        />
        <SliderField
          label="Opacity"
          testId="modify-node-opacity"
          min={0}
          max={1}
          step={0.01}
          value={params.opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateNodeParams(id, { opacity: v })}
        />
      </FormStack>
    </NodeShell>
  );
}
