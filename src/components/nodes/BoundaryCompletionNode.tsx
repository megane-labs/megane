import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { BoundaryCompletionParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

export function BoundaryCompletionNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const params = data.params as BoundaryCompletionParams;

  return (
    <NodeShell id={id} nodeType="boundary_completion" enabled={data.enabled}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 16 }}>
        <label>
          Complete&nbsp;
          <select
            className="nodrag"
            value={params.mode}
            aria-label="Boundary completion mode"
            onChange={(event) =>
              updateNodeParams(id, {
                mode: event.target.value as BoundaryCompletionParams["mode"],
              })
            }
          >
            <option value="neighbors">Direct neighbors</option>
            <option value="components">Finite connected components</option>
          </select>
        </label>
        <div style={{ color: "#64748b", fontSize: 13, lineHeight: 1.3 }}>
          Adds periodic display copies without changing structural coordinates. Infinite periodic
          networks are not expanded in component mode.
        </div>
      </div>
    </NodeShell>
  );
}
