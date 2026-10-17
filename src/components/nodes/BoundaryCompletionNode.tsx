import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { BoundaryCompletionParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { Field, FormStack } from "./form";
import { hintStyle, selectStyle } from "./formStyles";

export function BoundaryCompletionNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const params = data.params as BoundaryCompletionParams;

  return (
    <NodeShell id={id} nodeType="boundary_completion" enabled={data.enabled}>
      <FormStack>
        <Field label="Complete">
          <select
            className="nodrag"
            value={params.mode}
            aria-label="Boundary completion mode"
            style={selectStyle}
            onChange={(event) =>
              updateNodeParams(id, {
                mode: event.target.value as BoundaryCompletionParams["mode"],
              })
            }
          >
            <option value="neighbors">Direct neighbors</option>
            <option value="components">Finite connected components</option>
          </select>
        </Field>
        <div style={hintStyle}>
          Adds periodic display copies without changing structural coordinates. Infinite periodic
          networks are not expanded in component mode.
        </div>
      </FormStack>
    </NodeShell>
  );
}
