import type {
  BondData,
  CoordinationData,
  CoordinationGeneratorParams,
  ParticleData,
  PeriodicAtomImageData,
  PipelineData,
} from "../types";
import type { Snapshot } from "../../types";
import { getCovalentRadius, isDefaultLigand, isMetalLike } from "../../constants";
import { evaluateSelection } from "../selection";
import { invert3x3 } from "./mathUtils";
import { collectDisplaySites, displaySiteKey, type DisplaySite } from "./displaySites";
import {
  periodicDisplacementsWithinCutoff,
  type PeriodicDisplacement,
} from "./periodicDisplacements";

/** Convert directed coordination relationships to the normal bond stream. */
export function coordinationToBondData(coordination: CoordinationData): BondData {
  const source = coordination.particleRef.source;
  const hasExtendedAtoms = coordination.nAtoms > source.nAtoms;
  // Extended atoms are the Drawing Boundary copies, then the outside images.
  let ghostSourceIndices: Uint32Array | null = null;
  if (hasExtendedAtoms) {
    const boundarySources = coordination.particleRef.drawingBoundary?.images.sourceIndices ?? [];
    const outsideSources = coordination.outsideBoundaryImages?.sourceIndices ?? [];
    ghostSourceIndices = new Uint32Array(boundarySources.length + outsideSources.length);
    ghostSourceIndices.set(boundarySources);
    ghostSourceIndices.set(outsideSources, boundarySources.length);
  }
  return {
    type: "bond",
    sourceNodeId: coordination.sourceNodeId,
    bondIndices: coordination.bondIndices,
    bondOrders: null,
    nBonds: coordination.nBonds,
    scale: 1,
    opacity: 1,
    positions: hasExtendedAtoms ? coordination.positions : null,
    elements: hasExtendedAtoms ? coordination.elements : null,
    nAtoms: hasExtendedAtoms ? coordination.nAtoms : 0,
    atomElements: source.elements,
    ghostSourceIndices,
    selectedBondIndices: null,
    bondOpacityOverrides: null,
    periodicImages: coordination.outsideBoundaryImages,
  };
}

/**
 * Per-atom membership of one side of the search. A non-empty selection query
 * picks the atoms it matches, whatever their element; an empty one keeps every
 * atom of an auto-detected element that the exclusion list leaves in. A query
 * that does not parse matches nothing (the node reports the syntax error).
 */
function roleMask(
  query: string | undefined,
  snapshot: Snapshot,
  atomLabels: string[] | null,
  isDefault: (z: number) => boolean,
  excluded: number[],
): Uint8Array {
  const mask = new Uint8Array(snapshot.nAtoms);
  if (query?.trim()) {
    let selected: Set<number> | null;
    try {
      selected = evaluateSelection(query, snapshot, atomLabels);
    } catch {
      return mask;
    }
    if (selected === null) mask.fill(1);
    else for (const atom of selected) mask[atom] = 1;
    return mask;
  }
  const excludedSet = new Set(excluded);
  for (let atom = 0; atom < snapshot.nAtoms; atom++) {
    const z = snapshot.elements[atom];
    if (isDefault(z) && !excludedSet.has(z)) mask[atom] = 1;
  }
  return mask;
}

/**
 * Build directed center-neighbor relationships from the shared Drawing Boundary
 * atom collection. With the `complete` policy, only neighbor images needed to
 * complete visible centers are appended outside the drawing range.
 */
export function executeCoordinationGenerator(
  params: CoordinationGeneratorParams,
  inputs: Map<string, PipelineData[]>,
  atomLabels: string[] | null = null,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
  if (!particle) return outputs;

  const snapshot = particle.source;
  const { positions, elements, nAtoms } = snapshot;
  const isCenter = roleMask(
    params.centerQuery,
    snapshot,
    atomLabels,
    isMetalLike,
    params.excludedCenters,
  );
  const isLigand = roleMask(
    params.neighborQuery,
    snapshot,
    atomLabels,
    isDefaultLigand,
    params.excludedLigands,
  );

  const ligandSourceIndices: number[] = [];
  for (let atom = 0; atom < nAtoms; atom++) {
    if (isLigand[atom]) ligandSourceIndices.push(atom);
  }
  if (ligandSourceIndices.length === 0 || !isCenter.includes(1)) return outputs;

  // Squared cutoff per (center, neighbor) element pair, filled on first use.
  const cutoffSq = new Map<number, number>();
  const cutoffSqFor = (centerZ: number, ligandZ: number): number => {
    const key = centerZ * 256 + ligandZ;
    let value = cutoffSq.get(key);
    if (value === undefined) {
      const cutoff =
        (getCovalentRadius(centerZ) + getCovalentRadius(ligandZ)) * params.cutoffTolerance;
      value = cutoff * cutoff;
      cutoffSq.set(key, value);
    }
    return value;
  };

  const extendedPositions = Array.from(positions);
  const extendedElements = Array.from(elements);
  const { sites: allDisplaySites, byKey: drawingSites } = collectDisplaySites(
    positions,
    nAtoms,
    particle.drawingBoundary,
  );
  for (const site of allDisplaySites) {
    if (site.dataIndex < nAtoms) continue;
    extendedPositions.push(site.x, site.y, site.z);
    extendedElements.push(elements[site.sourceIndex]);
  }

  const centers = allDisplaySites.filter((site) => isCenter[site.sourceIndex]);
  const drawingLigands = allDisplaySites.filter((site) => isLigand[site.sourceIndex]);
  if (centers.length === 0 || drawingLigands.length === 0) return outputs;

  const box = snapshot.box;
  const inverse = box && box.some((value) => value !== 0) ? invert3x3(box) : null;
  const outsidePositions: number[] = [];
  const outsideElements: number[] = [];
  const outsideSourceIndices: number[] = [];
  const outsideLatticeShifts: number[] = [];
  const outsideSites = new Map<string, DisplaySite>();

  const appendOutsideSite = (
    sourceIndex: number,
    shiftA: number,
    shiftB: number,
    shiftC: number,
    x: number,
    y: number,
    z: number,
  ): DisplaySite => {
    const key = displaySiteKey(sourceIndex, shiftA, shiftB, shiftC);
    const drawing = drawingSites.get(key);
    if (drawing) return drawing;
    const existing = outsideSites.get(key);
    if (existing) return existing;
    const site: DisplaySite = {
      sourceIndex,
      dataIndex: extendedElements.length,
      x,
      y,
      z,
      shiftA,
      shiftB,
      shiftC,
    };
    outsideSites.set(key, site);
    extendedPositions.push(x, y, z);
    extendedElements.push(elements[sourceIndex]);
    outsidePositions.push(x, y, z);
    outsideElements.push(elements[sourceIndex]);
    outsideSourceIndices.push(sourceIndex);
    outsideLatticeShifts.push(shiftA, shiftB, shiftC);
    return site;
  };

  const relationships: number[] = [];
  for (const center of centers) {
    const centerZ = elements[center.sourceIndex];

    if (params.boundaryMode === "inside") {
      for (const ligand of drawingLigands) {
        const cutoff = cutoffSqFor(centerZ, elements[ligand.sourceIndex]);
        const dx = ligand.x - center.x;
        const dy = ligand.y - center.y;
        const dz = ligand.z - center.z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq <= cutoff && distanceSq > 0.01) {
          relationships.push(center.dataIndex, ligand.dataIndex);
        }
      }
      continue;
    }

    const centerSourceX = positions[center.sourceIndex * 3];
    const centerSourceY = positions[center.sourceIndex * 3 + 1];
    const centerSourceZ = positions[center.sourceIndex * 3 + 2];
    for (const ligandSource of ligandSourceIndices) {
      const cutoff = cutoffSqFor(centerZ, elements[ligandSource]);
      const dx = positions[ligandSource * 3] - centerSourceX;
      const dy = positions[ligandSource * 3 + 1] - centerSourceY;
      const dz = positions[ligandSource * 3 + 2] - centerSourceZ;
      let displacements: PeriodicDisplacement[];
      if (box && inverse) {
        displacements = periodicDisplacementsWithinCutoff(dx, dy, dz, box, inverse, cutoff);
      } else {
        const distanceSq = dx * dx + dy * dy + dz * dz;
        displacements = distanceSq <= cutoff && distanceSq > 0.01 ? [[dx, dy, dz, 0, 0, 0]] : [];
      }

      for (const [imageDx, imageDy, imageDz, relativeA, relativeB, relativeC] of displacements) {
        const shiftA = center.shiftA + relativeA;
        const shiftB = center.shiftB + relativeB;
        const shiftC = center.shiftC + relativeC;
        const x = center.x + imageDx;
        const y = center.y + imageDy;
        const z = center.z + imageDz;
        const ligand = appendOutsideSite(ligandSource, shiftA, shiftB, shiftC, x, y, z);
        relationships.push(center.dataIndex, ligand.dataIndex);
      }
    }
  }

  if (relationships.length === 0) return outputs;
  const outsideBoundaryImages: PeriodicAtomImageData | null =
    outsideElements.length > 0
      ? {
          positions: new Float32Array(outsidePositions),
          elements: new Uint8Array(outsideElements),
          sourceIndices: new Uint32Array(outsideSourceIndices),
          latticeShifts: new Int32Array(outsideLatticeShifts),
        }
      : null;
  const coordination: CoordinationData = {
    type: "coordination",
    sourceNodeId: particle.sourceNodeId,
    particleRef: particle,
    bondIndices: new Uint32Array(relationships),
    nBonds: relationships.length / 2,
    positions: new Float32Array(extendedPositions),
    elements: new Uint8Array(extendedElements),
    nAtoms: extendedElements.length,
    outsideBoundaryImages,
  };
  outputs.set("coordination", coordination);
  outputs.set("bond", coordinationToBondData(coordination));
  return outputs;
}
