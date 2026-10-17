/**
 * Filter node for the pipeline editor.
 * Accepts particle or bond input; filters based on query.
 * When connected to particle: uses the selection query language.
 * When connected to bond: future bond-order filtering.
 */

import { useState, useCallback, useEffect } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import type { PipelineNodeData } from "../../pipeline/execute";
import type { FilterParams } from "../../pipeline/types";
import { useScopedPipelineStore } from "../../stores/MeganeProvider";
import { validateQuery, validateBondQuery } from "../../pipeline/selection";
import { NodeShell } from "./NodeShell";
import { FormStack, Section } from "./form";
import { codeInputStyle, errorTextStyle, hintStyle, inputErrorStyle } from "./formStyles";
import { isImeComposing } from "../../utils/ime";

export function FilterNode({ id, data }: NodeProps<Node<PipelineNodeData>>) {
  const updateNodeParams = useScopedPipelineStore((s) => s.updateNodeParams);
  const params = data.params as FilterParams;
  const [localQuery, setLocalQuery] = useState(params.query);
  const [localBondQuery, setLocalBondQuery] = useState(params.bond_query ?? "");
  const [error, setError] = useState<string | null>(null);
  const [bondError, setBondError] = useState<string | null>(null);

  useEffect(() => {
    setLocalQuery(params.query);
  }, [params.query]);

  useEffect(() => {
    setLocalBondQuery(params.bond_query ?? "");
  }, [params.bond_query]);

  const handleCommit = useCallback(() => {
    const result = validateQuery(localQuery);
    setError(result.valid ? null : (result.error ?? "Invalid query"));
    updateNodeParams(id, { query: localQuery });
  }, [id, localQuery, updateNodeParams]);

  const handleBondCommit = useCallback(() => {
    const result = validateBondQuery(localBondQuery);
    setBondError(result.valid ? null : (result.error ?? "Invalid bond query"));
    updateNodeParams(id, { bond_query: localBondQuery });
  }, [id, localBondQuery, updateNodeParams]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isImeComposing(e)) handleCommit();
    },
    [handleCommit],
  );

  const handleBondKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !isImeComposing(e)) handleBondCommit();
    },
    [handleBondCommit],
  );

  return (
    <NodeShell id={id} nodeType="filter" enabled={data.enabled}>
      <FormStack>
        <Section title="Atoms">
          <input
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            onBlur={handleCommit}
            onKeyDown={handleKeyDown}
            placeholder='element == "C"'
            aria-label="Atom query"
            style={error ? { ...codeInputStyle, ...inputErrorStyle } : codeInputStyle}
          />
          {error && <div style={errorTextStyle}>{error}</div>}
          {!error && !localQuery && (
            <div style={hintStyle}>
              element, index, x, y, z, resname, resid, chain, mass, molecule_id · within R of (…)
            </div>
          )}
        </Section>
        <Section title="Bonds">
          <input
            value={localBondQuery}
            onChange={(e) => setLocalBondQuery(e.target.value)}
            onBlur={handleBondCommit}
            onKeyDown={handleBondKeyDown}
            placeholder="both atom_index >= 24"
            aria-label="Bond query"
            style={bondError ? { ...codeInputStyle, ...inputErrorStyle } : codeInputStyle}
          />
          {bondError && <div style={errorTextStyle}>{bondError}</div>}
          {!bondError && !localBondQuery && (
            <div style={hintStyle}>
              bond_index, atom_index, element, molecule_id · "both" for AND
            </div>
          )}
        </Section>
      </FormStack>
    </NodeShell>
  );
}
