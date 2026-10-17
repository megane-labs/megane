/**
 * Replicate node — OVITO/VESTA-style supercell builder.
 * Takes particle + cell input, produces a replicated particle + enlarged cell.
 * User controls the number of cell images along X, Y, Z (>= 1).
 */

import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { ReplicateParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { NodeShell } from "./NodeShell";
import { Field } from "./form";
import { inputStyle } from "./formStyles";

type Axis = "nx" | "ny" | "nz";

const AXES: { key: Axis; label: string; testId: string }[] = [
  { key: "nx", label: "X", testId: "replicate-node-nx" },
  { key: "ny", label: "Y", testId: "replicate-node-ny" },
  { key: "nz", label: "Z", testId: "replicate-node-nz" },
];

export function ReplicateNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as ReplicateParams;

  return (
    <NodeShell id={id} nodeType="replicate" enabled={data.enabled}>
      <Field label="Repeats" group>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
          {AXES.map(({ key, label, testId }) => (
            <label key={key} style={{ position: "relative", display: "block" }}>
              <span
                style={{
                  position: "absolute",
                  left: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--megane-text-muted)",
                  pointerEvents: "none",
                }}
              >
                {label}
              </span>
              <input
                type="number"
                className="nodrag"
                data-testid={testId}
                aria-label={`Repeats along ${label}`}
                value={params[key]}
                min={1}
                step={1}
                style={{ ...inputStyle, paddingLeft: 22 }}
                onChange={(e) => {
                  const v = Math.floor(parseFloat(e.target.value));
                  if (!isNaN(v) && v >= 1) updateNodeParams(id, { [key]: v });
                }}
              />
            </label>
          ))}
        </div>
      </Field>
    </NodeShell>
  );
}
