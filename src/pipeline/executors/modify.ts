import type { PipelineData, ParticleData, BondData, ModifyParams } from "../types";

/**
 * Modify node — applies per-stream scale and opacity overrides.
 *
 * Color was extracted into a dedicated `color` node; representation lives on
 * the dedicated `representation` node. This keeps each modifier responsible
 * for exactly one visual property, mirroring the Ovito-style modifier stack.
 */
export function executeModify(
  params: ModifyParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const inData = inputs.get("in")?.[0];
  if (!inData) return outputs;

  if (inData.type === "particle") {
    const particle = inData as ParticleData;
    const nAtoms = particle.source.nAtoms;

    let scaleArr = particle.scaleOverrides;
    if (particle.indices !== null && particle.indices.length > 0) {
      if (!scaleArr) {
        scaleArr = new Float32Array(nAtoms).fill(1.0);
      } else {
        scaleArr = new Float32Array(scaleArr);
      }
      for (const idx of particle.indices) {
        scaleArr[idx] = params.scale;
      }
    } else if (particle.indices === null) {
      if (params.scale !== 1.0) {
        scaleArr = new Float32Array(nAtoms).fill(params.scale);
      }
    }

    let opacityArr = particle.opacityOverrides;
    if (particle.indices !== null && particle.indices.length > 0) {
      if (!opacityArr) {
        opacityArr = new Float32Array(nAtoms).fill(1.0);
      } else {
        opacityArr = new Float32Array(opacityArr);
      }
      for (const idx of particle.indices) {
        opacityArr[idx] = params.opacity;
      }
    } else if (particle.indices === null) {
      if (params.opacity !== 1.0) {
        opacityArr = new Float32Array(nAtoms).fill(params.opacity);
      }
    }

    const modified: ParticleData = {
      ...particle,
      scaleOverrides: scaleArr,
      opacityOverrides: opacityArr,
    };
    outputs.set("out", modified);
  } else if (inData.type === "bond") {
    const bond = inData as BondData;
    if (bond.selectedBondIndices !== null) {
      // Start from the upstream per-bond opacity so bonds outside this
      // selection keep a fade an earlier modify gave them.
      const opacityArr = bond.bondOpacityOverrides
        ? new Float32Array(bond.bondOpacityOverrides)
        : new Float32Array(bond.nBonds).fill(1.0);
      for (const idx of bond.selectedBondIndices) {
        opacityArr[idx] = params.opacity;
      }
      outputs.set("out", {
        ...bond,
        scale: params.scale,
        bondOpacityOverrides: opacityArr,
      });
    } else {
      outputs.set("out", { ...bond, scale: params.scale, opacity: params.opacity });
    }
  }

  return outputs;
}
