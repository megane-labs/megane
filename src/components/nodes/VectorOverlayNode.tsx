/**
 * Vector Overlay node.
 * Takes vector input, applies scale, outputs vector for viewport rendering.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { VectorOverlayParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { SliderField } from "./form";

export function VectorOverlayNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as VectorOverlayParams;

  return (
    <NodeShell id={id} nodeType="vector_overlay" enabled={data.enabled}>
      <SliderField
        label="Scale"
        min={0.1}
        max={5.0}
        step={0.1}
        value={params.scale}
        format={(v) => v.toFixed(1)}
        onChange={(v) => updateNodeParams(id, { scale: v })}
      />
    </NodeShell>
  );
}
