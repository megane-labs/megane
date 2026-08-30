import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { PolyhedronGeneratorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";

export function PolyhedronGeneratorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const params = data.params as PolyhedronGeneratorParams;

  return (
    <NodeShell id={id} nodeType="polyhedron_generator" enabled={data.enabled}>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 16 }}>
        <label>
          Opacity&nbsp;
          <input
            className="nodrag"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={params.opacity}
            aria-label="Opacity"
            onChange={(event) => updateNodeParams(id, { opacity: Number(event.target.value) })}
          />
          &nbsp;{Math.round(params.opacity * 100)}%
        </label>
        <label>
          Show edges&nbsp;
          <input
            type="checkbox"
            checked={params.showEdges}
            onChange={(event) => updateNodeParams(id, { showEdges: event.target.checked })}
          />
        </label>
        {params.showEdges && (
          <>
            <label>
              Edge color&nbsp;
              <input
                type="color"
                value={params.edgeColor}
                onChange={(event) => updateNodeParams(id, { edgeColor: event.target.value })}
              />
            </label>
            <label>
              Edge width&nbsp;
              <input
                className="nodrag"
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={params.edgeWidth}
                onChange={(event) =>
                  updateNodeParams(id, { edgeWidth: Number(event.target.value) })
                }
              />
            </label>
          </>
        )}
      </div>
    </NodeShell>
  );
}
