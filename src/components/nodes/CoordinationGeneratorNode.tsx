import { useCallback, useMemo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { CoordinationGeneratorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { getElementsPresentInUpstream } from "../../pipeline/upstream";
import { ELEMENT_SYMBOLS, isDefaultLigand, isMetalLike } from "../../constants";
import { NodeShell } from "./NodeShell";

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
    return <div style={{ color: "#94a3b8", fontStyle: "italic" }}>None detected</div>;
  }
  const excludedSet = new Set(excluded);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
      {candidates.map((z) => (
        <label key={z} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" checked={!excludedSet.has(z)} onChange={() => onToggle(z)} />
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
      <div style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 16 }}>
        <div>
          <strong>Center atoms</strong>
          <ElementChoices
            candidates={centers}
            excluded={params.excludedCenters}
            onToggle={(z) => toggle("excludedCenters", z)}
          />
        </div>
        <div>
          <strong>Neighbor atoms</strong>
          <ElementChoices
            candidates={ligands}
            excluded={params.excludedLigands}
            onToggle={(z) => toggle("excludedLigands", z)}
          />
        </div>
        <label>
          Cutoff tolerance&nbsp;
          <input
            className="nodrag"
            type="number"
            min={0.1}
            step={0.01}
            value={params.cutoffTolerance}
            aria-label="Cutoff tolerance"
            style={{ width: 72 }}
            onChange={(event) =>
              updateNodeParams(id, { cutoffTolerance: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Neighbor search&nbsp;
          <select
            className="nodrag"
            value={params.boundaryMode}
            aria-label="Neighbor search range"
            onChange={(event) =>
              updateNodeParams(id, {
                boundaryMode: event.target.value as CoordinationGeneratorParams["boundaryMode"],
              })
            }
          >
            <option value="complete">Complete visible centers</option>
            <option value="inside">Visible atoms only</option>
          </select>
        </label>
        <div style={{ color: "#64748b", fontSize: 13, lineHeight: 1.3 }}>
          Complete visible centers includes bonded neighbors just outside the drawing boundary.
        </div>
      </div>
    </NodeShell>
  );
}
