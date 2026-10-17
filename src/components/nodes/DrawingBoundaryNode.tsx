import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { DrawingBoundaryParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { FormStack } from "./form";
import { fieldLabelStyle, hintStyle, inputStyle, LABEL_WIDTH } from "./formStyles";

const AXES = [
  ["a", "xMin", "xMax"],
  ["b", "yMin", "yMax"],
  ["c", "zMin", "zMax"],
] as const;

export function DrawingBoundaryNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const params = data.params as DrawingBoundaryParams;

  return (
    <NodeShell id={id} nodeType="drawing_boundary" enabled={data.enabled}>
      <FormStack>
        <div style={hintStyle}>
          Show periodic atom images inside these inclusive fractional-coordinate ranges.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr) minmax(0, 1fr)`,
            alignItems: "center",
            gap: "6px 10px",
          }}
        >
          <span />
          <span style={fieldLabelStyle}>Min</span>
          <span style={fieldLabelStyle}>Max</span>
          {AXES.map(([label, minKey, maxKey]) => (
            <div key={label} style={{ display: "contents" }}>
              <span style={fieldLabelStyle}>{label}</span>
              <input
                className="nodrag"
                type="number"
                step={0.1}
                value={params[minKey]}
                aria-label={`${label} minimum`}
                data-testid={`drawing-boundary-${label}-min`}
                style={inputStyle}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) updateNodeParams(id, { [minKey]: value });
                }}
              />
              <input
                className="nodrag"
                type="number"
                step={0.1}
                value={params[maxKey]}
                aria-label={`${label} maximum`}
                data-testid={`drawing-boundary-${label}-max`}
                style={inputStyle}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) updateNodeParams(id, { [maxKey]: value });
                }}
              />
            </div>
          ))}
        </div>
      </FormStack>
    </NodeShell>
  );
}
