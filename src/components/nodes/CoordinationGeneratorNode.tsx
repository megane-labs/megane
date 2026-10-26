import { useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { CoordinationGeneratorParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { getElementsPresentInUpstream } from "../../pipeline/upstream";
import { validateQuery } from "../../pipeline/selection";
import { ELEMENT_SYMBOLS, isDefaultLigand, isMetalLike } from "../../constants";
import { isImeComposing } from "../../utils/ime";
import { NodeShell } from "./NodeShell";
import { Field, FormStack, Section } from "./form";
import {
  checkboxStyle,
  codeInputStyle,
  emptyFileStyle,
  errorTextStyle,
  hintStyle,
  inputErrorStyle,
  inputStyle,
  selectStyle,
} from "./formStyles";

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

/**
 * One side of the search (centers or neighbors): a selection query that, when
 * set, replaces the auto-detected element list shown below it.
 */
function RoleSection({
  title,
  queryLabel,
  query,
  placeholder,
  candidates,
  excluded,
  onCommitQuery,
  onToggle,
}: {
  title: string;
  queryLabel: string;
  query: string;
  placeholder: string;
  candidates: number[];
  excluded: number[];
  onCommitQuery: (query: string) => void;
  onToggle: (z: number) => void;
}) {
  const [localQuery, setLocalQuery] = useState(query);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const commit = useCallback(() => {
    const result = validateQuery(localQuery);
    setError(result.valid ? null : (result.error ?? "Invalid query"));
    onCommitQuery(localQuery);
  }, [localQuery, onCommitQuery]);

  return (
    <Section title={title}>
      <input
        className="nodrag"
        value={localQuery}
        onChange={(event) => setLocalQuery(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !isImeComposing(event)) commit();
        }}
        placeholder={placeholder}
        aria-label={queryLabel}
        style={error ? { ...codeInputStyle, ...inputErrorStyle } : codeInputStyle}
      />
      {error && <div style={errorTextStyle}>{error}</div>}
      {query.trim() ? (
        <div style={hintStyle}>The query replaces the auto-detected elements.</div>
      ) : (
        <ElementChoices candidates={candidates} excluded={excluded} onToggle={onToggle} />
      )}
    </Section>
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
  const commitCenterQuery = useCallback(
    (centerQuery: string) => updateNodeParams(id, { centerQuery }),
    [id, updateNodeParams],
  );
  const commitNeighborQuery = useCallback(
    (neighborQuery: string) => updateNodeParams(id, { neighborQuery }),
    [id, updateNodeParams],
  );

  return (
    <NodeShell id={id} nodeType="coordination_generator" enabled={data.enabled}>
      <FormStack>
        <RoleSection
          title="Center atoms"
          queryLabel="Center query"
          query={params.centerQuery ?? ""}
          placeholder='Auto · e.g. element == "P"'
          candidates={centers}
          excluded={params.excludedCenters}
          onCommitQuery={commitCenterQuery}
          onToggle={(z) => toggle("excludedCenters", z)}
        />
        <RoleSection
          title="Neighbor atoms"
          queryLabel="Neighbor query"
          query={params.neighborQuery ?? ""}
          placeholder='Auto · e.g. element == "O"'
          candidates={ligands}
          excluded={params.excludedLigands}
          onCommitQuery={commitNeighborQuery}
          onToggle={(z) => toggle("excludedLigands", z)}
        />
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
