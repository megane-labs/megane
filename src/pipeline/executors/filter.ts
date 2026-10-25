import type { PipelineData, ParticleData, BondData, FilterParams } from "../types";
import { evaluateSelection, evaluateBondSelection } from "../selection";

export function executeFilter(
  params: FilterParams,
  inputs: Map<string, PipelineData[]>,
  atomLabels: string[] | null,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const inData = inputs.get("in")?.[0];
  if (!inData) return outputs;

  if (inData.type === "particle") {
    const particle = inData as ParticleData;
    if (!params.query.trim()) {
      outputs.set("out", particle);
      return outputs;
    }

    try {
      const selectionResult = evaluateSelection(params.query, particle.source, atomLabels);

      if (selectionResult === null) {
        outputs.set("out", particle);
      } else {
        let finalIndices: Uint32Array;
        if (particle.indices === null) {
          finalIndices = new Uint32Array(selectionResult);
        } else {
          const existing = new Set(particle.indices);
          const intersected = [...selectionResult].filter((i) => existing.has(i));
          finalIndices = new Uint32Array(intersected);
        }

        const filtered: ParticleData = {
          ...particle,
          indices: finalIndices,
          scaleOverrides: particle.scaleOverrides,
          opacityOverrides: particle.opacityOverrides,
          colorOverrides: particle.colorOverrides,
        };
        outputs.set("out", filtered);
      }
    } catch {
      outputs.set("out", particle);
    }
  } else if (inData.type === "bond") {
    const bond = inData as BondData;
    const bondQuery = params.bond_query?.trim() ?? "";
    if (bondQuery && bond.atomElements) {
      try {
        const selectedSet = evaluateBondSelection(
          bondQuery,
          bond.bondIndices,
          bond.atomElements,
          bond.nBonds,
          bond.nAtoms,
          bond.periodicTopology?.bondIndices,
        );
        if (selectedSet !== null) {
          outputs.set("out", {
            ...bond,
            selectedBondIndices: new Uint32Array(selectedSet),
          });
          return outputs;
        }
      } catch {
        // Invalid query: pass through unchanged
      }
    }
    outputs.set("out", bond);
  }

  return outputs;
}
