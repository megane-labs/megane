/**
 * Label Generator node.
 * Takes particle input, produces label output.
 * Source: element symbol, residue name, or atom index.
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { LabelGeneratorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { TabSelector } from "../ui";

export function LabelGeneratorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as LabelGeneratorParams;

  return (
    <NodeShell id={id} nodeType="label_generator" enabled={data.enabled}>
      <TabSelector<"element" | "resname" | "index">
        options={[
          { value: "element", label: "Element" },
          { value: "resname", label: "Resname" },
          { value: "index", label: "Index" },
        ]}
        value={params.source}
        onChange={(v) => updateNodeParams(id, { source: v })}
      />
    </NodeShell>
  );
}
