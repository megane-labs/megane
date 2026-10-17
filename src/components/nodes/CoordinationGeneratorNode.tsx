import { useCallback, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { CoordinationGeneratorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { getElementsPresentInUpstream } from "../../pipeline/upstream";
import { ELEMENT_SYMBOLS, isDefaultLigand, isMetalLike } from "../../constants";
import { NodeShell } from "./NodeShell";
import { Field, FormStack, Section } from "./form";
import { checkboxStyle, emptyFileStyle, hintStyle, inputStyle, selectStyle } from "./formStyles";

function ElementChoices({
  candidates,
  excluded,
  onToggle,
}: {
  candidates: number[];
  excluded: number[];
  onToggle: (z: number) => void;
}) {
  if (candidates.length === 0) {
    return <div style={emptyFileStyle}>None detected</div>;
  }
  const excludedSet = new Set(excluded);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
      {candidates.map((z) => (
        <label
          key={z}
          style={{
            display: "inline-flex",
            gap: 6,
            alignItems: "center",
            fontSize: 12,
            color: "var(--megane-text-body)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={!excludedSet.has(z)}
            style={checkboxStyle}
            onChange={() => onToggle(z)}
          />
          {ELEMENT_SYMBOLS[z] ?? `#${z}`}
        </label>
      ))}
    </div>
  );
}

export function CoordinationGeneratorNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((state) => state.updateNodeParams);
  const nodes = useScopedPipelineStore((state) => state.nodes);
  const edges = useScopedPipelineStore((state) => state.edges);
  const snapshots = useScopedPipelineStore((state) => state.nodeSnapshots);
  const params = data.params as CoordinationGeneratorParams;
  const present = useMemo(
    () => getElementsPresentInUpstream(id, nodes, edges, snapshots),
    [id, nodes, edges, snapshots],
  );
  const centers = useMemo(
    () => [...(present ?? [])].filter(isMetalLike).sort((a, b) => a - b),
    [present],
  );
  const ligands = useMemo(
    () => [...(present ?? [])].filter(isDefaultLigand).sort((a, b) => a - b),
    [present],
  );
  const toggle = useCallback(
    (key: "excludedCenters" | "excludedLigands", z: number) => {
      const values = new Set(params[key]);
      if (values.has(z)) values.delete(z);
      else values.add(z);
      updateNodeParams(id, { [key]: [...values].sort((a, b) => a - b) });
    },
    [id, params, updateNodeParams],
  );

  return (
    <NodeShell id={id} nodeType="coordination_generator" enabled={data.enabled}>
      <FormStack>
        <Section title="Center atoms">
          <ElementChoices
            candidates={centers}
            excluded={params.excludedCenters}
            onToggle={(z) => toggle("excludedCenters", z)}
          />
        </Section>
        <Section title="Neighbor atoms">
          <ElementChoices
            candidates={ligands}
            excluded={params.excludedLigands}
            onToggle={(z) => toggle("excludedLigands", z)}
          />
        </Section>
        <Field label="Cutoff tolerance">
          <input
            className="nodrag"
            type="number"
            min={0.1}
            step={0.01}
            value={params.cutoffTolerance}
            aria-label="Cutoff tolerance"
            style={inputStyle}
            onChange={(event) =>
              updateNodeParams(id, { cutoffTolerance: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="Neighbor search">
          <select
            className="nodrag"
            value={params.boundaryMode}
            aria-label="Neighbor search range"
            style={selectStyle}
            onChange={(event) =>
              updateNodeParams(id, {
                boundaryMode: event.target.value as CoordinationGeneratorParams["boundaryMode"],
              })
            }
          >
            <option value="complete">Complete visible centers</option>
            <option value="inside">Visible atoms only</option>
          </select>
        </Field>
        <div style={hintStyle}>
          Complete visible centers includes bonded neighbors just outside the drawing boundary.
        </div>
      </FormStack>
    </NodeShell>
  );
}
