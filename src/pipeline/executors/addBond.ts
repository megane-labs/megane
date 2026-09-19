import type {
  PipelineData,
  ParticleData,
  BondData,
  AddBondParams,
  PeriodicBondTopologyData,
} from "../types";
import { inferBondsVdwJS, DEFAULT_VDW_BOND_FACTOR } from "../../parsers/inferBondsJS";
import { DEFAULT_RADIUS, VDW_RADII } from "../../constants";
import { invert3x3 } from "./mathUtils";
import { collectDisplaySites, displaySiteKey, type DisplaySite } from "./displaySites";
import {
  minimumImageTargetShift,
  periodicDisplacementsWithinCutoff,
} from "./periodicDisplacements";

/**
 * Result of PBC bond processing: normal bonds kept as-is,
 * PBC-crossing bonds replaced with half-bonds to ghost atoms.
 */
export interface PbcBondResult {
  bondIndices: Uint32Array;
  bondOrders: Uint8Array | null;
  nBonds: number;
  // Extended positions/elements including ghost atoms (null when no PBC bonds)
  positions: Float32Array | null;
  elements: Uint8Array | null;
  nAtoms: number;
}

/** Attach one minimum-image lattice shift to each explicit structural bond. */
function topologyFromPairs(
  bondIndices: Uint32Array,
  bondOrders: Uint8Array | null,
  particle: ParticleData,
): PeriodicBondTopologyData {
  const snapshot = particle.source;
  const box = snapshot.box;
  const inverse = box && box.some((value) => value !== 0) ? invert3x3(box) : null;
  const targetLatticeShifts = new Int32Array((bondIndices.length / 2) * 3);
  if (inverse) {
    for (let bond = 0; bond < bondIndices.length / 2; bond++) {
      const source = bondIndices[bond * 2];
      const target = bondIndices[bond * 2 + 1];
      const dx = snapshot.positions[target * 3] - snapshot.positions[source * 3];
      const dy = snapshot.positions[target * 3 + 1] - snapshot.positions[source * 3 + 1];
      const dz = snapshot.positions[target * 3 + 2] - snapshot.positions[source * 3 + 2];
      const [a, b, c] = minimumImageTargetShift(dx, dy, dz, inverse);
      targetLatticeShifts[bond * 3] = a;
      targetLatticeShifts[bond * 3 + 1] = b;
      targetLatticeShifts[bond * 3 + 2] = c;
    }
  }
  return { bondIndices, targetLatticeShifts, bondOrders };
}

/**
 * Infer a periodic bond topology without moving structural coordinates.
 * Multiple valid images of the same atom pair remain distinct topology edges.
 */
function inferDistancePeriodicTopology(
  particle: ParticleData,
  vdwScale: number,
): PeriodicBondTopologyData {
  const snapshot = particle.source;
  const pairs = inferBondsVdwJS(
    snapshot.positions,
    snapshot.elements,
    snapshot.nAtoms,
    vdwScale,
    snapshot.box,
  );
  const box = snapshot.box;
  const inverse = box && box.some((value) => value !== 0) ? invert3x3(box) : null;
  if (!box || !inverse) return topologyFromPairs(pairs, null, particle);

  const bondIndices: number[] = [];
  const shifts: number[] = [];
  const seen = new Set<string>();
  for (let bond = 0; bond < pairs.length / 2; bond++) {
    const source = pairs[bond * 2];
    const target = pairs[bond * 2 + 1];
    const dx = snapshot.positions[target * 3] - snapshot.positions[source * 3];
    const dy = snapshot.positions[target * 3 + 1] - snapshot.positions[source * 3 + 1];
    const dz = snapshot.positions[target * 3 + 2] - snapshot.positions[source * 3 + 2];
    const sourceRadius = VDW_RADII[snapshot.elements[source]] ?? DEFAULT_RADIUS;
    const targetRadius = VDW_RADII[snapshot.elements[target]] ?? DEFAULT_RADIUS;
    const cutoff = (sourceRadius + targetRadius) * vdwScale;
    for (const [, , , a, b, c] of periodicDisplacementsWithinCutoff(
      dx,
      dy,
      dz,
      box,
      inverse,
      cutoff * cutoff,
    )) {
      const key = `${source}:${target}:${a}:${b}:${c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bondIndices.push(source, target);
      shifts.push(a, b, c);
    }
  }

  return {
    bondIndices: new Uint32Array(bondIndices),
    targetLatticeShifts: new Int32Array(shifts),
    bondOrders: null,
  };
}

/** Materialize exact periodic topology as ordinary bonds plus ghost endpoints. */
function renderPeriodicTopology(
  particle: ParticleData,
  topology: PeriodicBondTopologyData,
): PbcBondResult {
  const snapshot = particle.source;
  const box = snapshot.box;
  if (!box || !box.some((value) => value !== 0)) {
    return {
      bondIndices: topology.bondIndices,
      bondOrders: topology.bondOrders,
      nBonds: topology.bondIndices.length / 2,
      positions: null,
      elements: null,
      nAtoms: 0,
    };
  }

  const bonds: number[] = [];
  const orders: number[] = [];
  const ghostPositions: number[] = [];
  const ghostElements: number[] = [];
  let ghostIndex = snapshot.nAtoms;
  for (let bond = 0; bond < topology.bondIndices.length / 2; bond++) {
    const source = topology.bondIndices[bond * 2];
    const target = topology.bondIndices[bond * 2 + 1];
    const a = topology.targetLatticeShifts[bond * 3];
    const b = topology.targetLatticeShifts[bond * 3 + 1];
    const c = topology.targetLatticeShifts[bond * 3 + 2];
    if (a === 0 && b === 0 && c === 0) {
      bonds.push(source, target);
      if (topology.bondOrders) orders.push(topology.bondOrders[bond]);
      continue;
    }

    ghostPositions.push(
      snapshot.positions[target * 3] + a * box[0] + b * box[3] + c * box[6],
      snapshot.positions[target * 3 + 1] + a * box[1] + b * box[4] + c * box[7],
      snapshot.positions[target * 3 + 2] + a * box[2] + b * box[5] + c * box[8],
    );
    ghostElements.push(snapshot.elements[target]);
    bonds.push(source, ghostIndex++);
    if (topology.bondOrders) orders.push(topology.bondOrders[bond]);

    ghostPositions.push(
      snapshot.positions[source * 3] - a * box[0] - b * box[3] - c * box[6],
      snapshot.positions[source * 3 + 1] - a * box[1] - b * box[4] - c * box[7],
      snapshot.positions[source * 3 + 2] - a * box[2] - b * box[5] - c * box[8],
    );
    ghostElements.push(snapshot.elements[source]);
    bonds.push(target, ghostIndex++);
    if (topology.bondOrders) orders.push(topology.bondOrders[bond]);
  }

  if (ghostPositions.length === 0) {
    return {
      bondIndices: new Uint32Array(bonds),
      bondOrders: topology.bondOrders ? new Uint8Array(orders) : null,
      nBonds: bonds.length / 2,
      positions: null,
      elements: null,
      nAtoms: 0,
    };
  }

  const positions = new Float32Array(snapshot.positions.length + ghostPositions.length);
  positions.set(snapshot.positions);
  positions.set(ghostPositions, snapshot.positions.length);
  const elements = new Uint8Array(snapshot.elements.length + ghostElements.length);
  elements.set(snapshot.elements);
  elements.set(ghostElements, snapshot.elements.length);
  return {
    bondIndices: new Uint32Array(bonds),
    bondOrders: topology.bondOrders ? new Uint8Array(orders) : null,
    nBonds: bonds.length / 2,
    positions,
    elements,
    nAtoms: elements.length,
  };
}

/** Repeat a periodic structural topology over Drawing Boundary atom copies. */
export function expandPeriodicTopologyForDrawingBoundary(
  particle: ParticleData,
  topology: PeriodicBondTopologyData,
): PbcBondResult {
  const boundary = particle.drawingBoundary!;
  const snapshot = particle.source;
  const positions = new Float32Array(snapshot.positions.length + boundary.images.positions.length);
  positions.set(snapshot.positions);
  positions.set(boundary.images.positions, snapshot.positions.length);
  const elements = new Uint8Array(snapshot.elements.length + boundary.images.elements.length);
  elements.set(snapshot.elements);
  elements.set(boundary.images.elements, snapshot.elements.length);

  const { sites, byKey: sitesByKey } = collectDisplaySites(
    snapshot.positions,
    snapshot.nAtoms,
    boundary,
  );
  const sitesBySource = new Map<number, DisplaySite[]>();
  for (const site of sites) {
    const bySource = sitesBySource.get(site.sourceIndex) ?? [];
    bySource.push(site);
    sitesBySource.set(site.sourceIndex, bySource);
  }

  const expanded: number[] = [];
  const orders: number[] = [];
  const seen = new Set<string>();
  for (let bond = 0; bond < topology.bondIndices.length / 2; bond++) {
    const sourceA = topology.bondIndices[bond * 2];
    const sourceB = topology.bondIndices[bond * 2 + 1];
    const relativeA = topology.targetLatticeShifts[bond * 3];
    const relativeB = topology.targetLatticeShifts[bond * 3 + 1];
    const relativeC = topology.targetLatticeShifts[bond * 3 + 2];
    for (const siteA of sitesBySource.get(sourceA) ?? []) {
      const siteB = sitesByKey.get(
        displaySiteKey(
          sourceB,
          siteA.shiftA + relativeA,
          siteA.shiftB + relativeB,
          siteA.shiftC + relativeC,
        ),
      );
      if (!siteB) continue;
      const key =
        siteA.dataIndex < siteB.dataIndex
          ? `${siteA.dataIndex}:${siteB.dataIndex}`
          : `${siteB.dataIndex}:${siteA.dataIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      expanded.push(siteA.dataIndex, siteB.dataIndex);
      if (topology.bondOrders) orders.push(topology.bondOrders[bond]);
    }
  }
  return {
    bondIndices: new Uint32Array(expanded),
    bondOrders: topology.bondOrders ? new Uint8Array(orders) : null,
    nBonds: expanded.length / 2,
    positions,
    elements,
    nAtoms: elements.length,
  };
}

/**
 * Process bonds for periodic boundary conditions (OVITO-style).
 *
 * Bonds that cross PBC are replaced with two half-bonds:
 * - atom A → ghost position of B (minimum-image near A)
 * - atom B → ghost position of A (minimum-image near B)
 *
 * Ghost atoms are appended to positions/elements arrays so the existing
 * impostor bond renderer handles them without modification.
 */
export function processPbcBonds(
  bondIndices: Uint32Array,
  bondOrders: Uint8Array | null,
  positions: Float32Array,
  elements: Uint8Array,
  nAtoms: number,
  box: Float32Array | null,
): PbcBondResult {
  if (!box || !box.some((v) => v !== 0)) {
    return {
      bondIndices,
      bondOrders,
      nBonds: bondIndices.length / 2,
      positions: null,
      elements: null,
      nAtoms: 0,
    };
  }

  const boxInv = invert3x3(box);
  if (!boxInv) {
    return {
      bondIndices,
      bondOrders,
      nBonds: bondIndices.length / 2,
      positions: null,
      elements: null,
      nAtoms: 0,
    };
  }

  // Threshold: half the shortest cell vector length
  const lenA = Math.sqrt(box[0] * box[0] + box[1] * box[1] + box[2] * box[2]);
  const lenB = Math.sqrt(box[3] * box[3] + box[4] * box[4] + box[5] * box[5]);
  const lenC = Math.sqrt(box[6] * box[6] + box[7] * box[7] + box[8] * box[8]);
  const half = Math.min(lenA, lenB, lenC) / 2;
  const thresholdSq = half * half;

  const nBondsIn = bondIndices.length / 2;

  // First pass: count normal and PBC bonds
  let nNormal = 0;
  let nPbc = 0;
  for (let b = 0; b < nBondsIn; b++) {
    const i = bondIndices[b * 2];
    const j = bondIndices[b * 2 + 1];
    const dx = positions[j * 3] - positions[i * 3];
    const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
    const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
    if (dx * dx + dy * dy + dz * dz > thresholdSq) {
      nPbc++;
    } else {
      nNormal++;
    }
  }

  if (nPbc === 0) {
    // No PBC bonds — return original data unchanged
    return {
      bondIndices,
      bondOrders,
      nBonds: nBondsIn,
      positions: null,
      elements: null,
      nAtoms: 0,
    };
  }

  // Allocate: normal bonds + 2 half-bonds per PBC bond
  const totalBonds = nNormal + nPbc * 2;
  const outBonds = new Uint32Array(totalBonds * 2);
  const outOrders = bondOrders ? new Uint8Array(totalBonds) : null;

  // Ghost atoms: 2 per PBC bond
  const ghostPositions: number[] = [];
  const ghostElements: number[] = [];
  let ghostIdx = nAtoms;
  let outIdx = 0;

  for (let b = 0; b < nBondsIn; b++) {
    const i = bondIndices[b * 2];
    const j = bondIndices[b * 2 + 1];
    const dx = positions[j * 3] - positions[i * 3];
    const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
    const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq <= thresholdSq) {
      // Normal bond — keep as-is
      outBonds[outIdx * 2] = i;
      outBonds[outIdx * 2 + 1] = j;
      if (outOrders && bondOrders) outOrders[outIdx] = bondOrders[b];
      outIdx++;
    } else {
      // PBC bond — compute minimum-image displacement
      // Convert to fractional coords
      let sx = boxInv[0] * dx + boxInv[3] * dy + boxInv[6] * dz;
      let sy = boxInv[1] * dx + boxInv[4] * dy + boxInv[7] * dz;
      let sz = boxInv[2] * dx + boxInv[5] * dy + boxInv[8] * dz;

      // Wrap to [-0.5, 0.5]
      sx -= Math.round(sx);
      sy -= Math.round(sy);
      sz -= Math.round(sz);

      // Convert back to Cartesian (minimum-image displacement)
      const dxMin = box[0] * sx + box[3] * sy + box[6] * sz;
      const dyMin = box[1] * sx + box[4] * sy + box[7] * sz;
      const dzMin = box[2] * sx + box[5] * sy + box[8] * sz;

      // Ghost B: minimum-image position of j near i
      ghostPositions.push(
        positions[i * 3] + dxMin,
        positions[i * 3 + 1] + dyMin,
        positions[i * 3 + 2] + dzMin,
      );
      ghostElements.push(elements[j]);
      outBonds[outIdx * 2] = i;
      outBonds[outIdx * 2 + 1] = ghostIdx;
      if (outOrders && bondOrders) outOrders[outIdx] = bondOrders[b];
      outIdx++;
      ghostIdx++;

      // Ghost A: minimum-image position of i near j
      ghostPositions.push(
        positions[j * 3] - dxMin,
        positions[j * 3 + 1] - dyMin,
        positions[j * 3 + 2] - dzMin,
      );
      ghostElements.push(elements[i]);
      outBonds[outIdx * 2] = j;
      outBonds[outIdx * 2 + 1] = ghostIdx;
      if (outOrders && bondOrders) outOrders[outIdx] = bondOrders[b];
      outIdx++;
      ghostIdx++;
    }
  }

  // Build extended positions and elements arrays
  const extPositions = new Float32Array(positions.length + ghostPositions.length);
  extPositions.set(positions);
  extPositions.set(new Float32Array(ghostPositions), positions.length);

  const extElements = new Uint8Array(elements.length + ghostElements.length);
  extElements.set(elements);
  extElements.set(new Uint8Array(ghostElements), elements.length);

  return {
    bondIndices: outBonds,
    bondOrders: outOrders,
    nBonds: totalBonds,
    positions: extPositions,
    elements: extElements,
    nAtoms: ghostIdx,
  };
}

/**
 * Distance-mode bonds for a single playback frame: the per-frame counterpart
 * of `executeAddBond`'s distance path. Host viewers must call this during
 * trajectory playback instead of reimplementing the transform (CRITICAL RULE
 * #11 corollary: hosts call the node executor, they never fork it).
 */
export function computeFrameDistanceBonds(
  framePositions: Float32Array,
  elements: Uint8Array,
  nAtoms: number,
  box: Float32Array | null,
  vdwScale?: number,
): PbcBondResult {
  const pairs = inferBondsVdwJS(
    framePositions,
    elements,
    nAtoms,
    vdwScale ?? DEFAULT_VDW_BOND_FACTOR,
    box,
  );
  return processPbcBonds(pairs, null, framePositions, elements, nAtoms, box);
}

/**
 * Bond stream for exactly the bonds a snapshot carries — file bonds, parser
 * inferred bonds, and bonds asserted by the Build panel's edit ops alike —
 * regardless of `nFileBonds`. The edit view (see `pipeline/editView.ts`)
 * draws the loader's output with these rather than re-inferring anything, so
 * what the user drew is what they see. PBC half-bonds get their ghost atoms
 * as in the "structure" source of `executeAddBond`.
 */
export function bondDataFromSnapshotBonds(particle: ParticleData): BondData | null {
  const snapshot = particle.source;
  if (snapshot.nBonds === 0 || snapshot.bonds.length === 0) return null;
  const topology = topologyFromPairs(snapshot.bonds, snapshot.bondOrders, particle);
  const rendered = renderPeriodicTopology(particle, topology);
  return {
    type: "bond",
    sourceNodeId: particle.sourceNodeId,
    bondIndices: rendered.bondIndices,
    bondOrders: rendered.bondOrders,
    nBonds: rendered.nBonds,
    scale: 1,
    opacity: 1,
    positions: rendered.positions,
    elements: rendered.elements,
    nAtoms: rendered.nAtoms,
    atomElements: snapshot.elements,
    selectedBondIndices: null,
    bondOpacityOverrides: null,
    periodicTopology: topology,
  };
}

export function executeAddBond(
  params: AddBondParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const particleData = inputs.get("particle")?.[0] as ParticleData | undefined;
  if (!particleData) return outputs;

  const snapshot = particleData.source;
  let topology: PeriodicBondTopologyData | null = null;
  if (params.bondSource === "structure" && snapshot.nFileBonds > 0) {
    topology = topologyFromPairs(snapshot.bonds, snapshot.bondOrders, particleData);
  } else if (params.bondSource === "file") {
    const raw = params.bondFileData;
    if (raw && raw.length >= 2) {
      const validPairs: number[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const a = raw[i];
        const b = raw[i + 1];
        if (a < snapshot.nAtoms && b < snapshot.nAtoms) validPairs.push(a, b);
      }
      topology = topologyFromPairs(new Uint32Array(validPairs), null, particleData);
    }
  } else if (params.bondSource === "distance") {
    topology = inferDistancePeriodicTopology(
      particleData,
      params.vdwScale ?? DEFAULT_VDW_BOND_FACTOR,
    );
  }

  if (!topology || topology.bondIndices.length === 0) return outputs;
  const rendered = particleData.drawingBoundary
    ? expandPeriodicTopologyForDrawingBoundary(particleData, topology)
    : renderPeriodicTopology(particleData, topology);

  const bond: BondData = {
    type: "bond",
    sourceNodeId: particleData.sourceNodeId,
    bondIndices: rendered.bondIndices,
    bondOrders: rendered.bondOrders,
    nBonds: rendered.nBonds,
    scale: 1,
    opacity: 1,
    positions: rendered.positions,
    elements: rendered.elements,
    nAtoms: rendered.nAtoms,
    atomElements: snapshot.elements,
    selectedBondIndices: null,
    bondOpacityOverrides: null,
    periodicTopology: topology,
  };
  outputs.set("bond", bond);

  return outputs;
}
