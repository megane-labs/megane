import type {
  BondData,
  BoundaryCompletionParams,
  DrawingBoundaryData,
  ParticleData,
  PeriodicAtomImageData,
  PeriodicBondTopologyData,
  PipelineData,
} from "../types";
import { expandPeriodicTopologyForDrawingBoundary } from "./addBond";

interface PeriodicSite {
  sourceIndex: number;
  shiftA: number;
  shiftB: number;
  shiftC: number;
}

interface AdjacencyEdge {
  target: number;
  shiftA: number;
  shiftB: number;
  shiftC: number;
}

function siteKey(site: PeriodicSite): string {
  return `${site.sourceIndex}:${site.shiftA}:${site.shiftB}:${site.shiftC}`;
}

function buildAdjacency(nAtoms: number, topology: PeriodicBondTopologyData): AdjacencyEdge[][] {
  const adjacency: AdjacencyEdge[][] = Array.from({ length: nAtoms }, () => []);
  for (let bond = 0; bond < topology.bondIndices.length / 2; bond++) {
    const source = topology.bondIndices[bond * 2];
    const target = topology.bondIndices[bond * 2 + 1];
    if (source >= nAtoms || target >= nAtoms) continue;
    const shiftA = topology.targetLatticeShifts[bond * 3];
    const shiftB = topology.targetLatticeShifts[bond * 3 + 1];
    const shiftC = topology.targetLatticeShifts[bond * 3 + 2];
    adjacency[source].push({ target, shiftA, shiftB, shiftC });
    adjacency[target].push({ target: source, shiftA: -shiftA, shiftB: -shiftB, shiftC: -shiftC });
  }
  return adjacency;
}

/** Mark components that cannot be represented by one finite set of atom images. */
function classifyPeriodicComponents(adjacency: AdjacencyEdge[][]): {
  componentByAtom: Int32Array;
  periodic: boolean[];
} {
  const componentByAtom = new Int32Array(adjacency.length).fill(-1);
  const assigned = new Int32Array(adjacency.length * 3);
  const periodic: boolean[] = [];

  for (let start = 0; start < adjacency.length; start++) {
    if (componentByAtom[start] !== -1 || adjacency[start].length === 0) continue;
    const component = periodic.length;
    periodic.push(false);
    componentByAtom[start] = component;
    const stack = [start];
    while (stack.length > 0) {
      const source = stack.pop()!;
      const source3 = source * 3;
      for (const edge of adjacency[source]) {
        const expectedA = assigned[source3] + edge.shiftA;
        const expectedB = assigned[source3 + 1] + edge.shiftB;
        const expectedC = assigned[source3 + 2] + edge.shiftC;
        const target3 = edge.target * 3;
        if (componentByAtom[edge.target] === -1) {
          componentByAtom[edge.target] = component;
          assigned[target3] = expectedA;
          assigned[target3 + 1] = expectedB;
          assigned[target3 + 2] = expectedC;
          stack.push(edge.target);
        } else if (
          componentByAtom[edge.target] === component &&
          (assigned[target3] !== expectedA ||
            assigned[target3 + 1] !== expectedB ||
            assigned[target3 + 2] !== expectedC)
        ) {
          periodic[component] = true;
        }
      }
    }
  }

  return { componentByAtom, periodic };
}

function collectDrawingSites(particle: ParticleData): PeriodicSite[] {
  const boundary = particle.drawingBoundary!;
  const sites: PeriodicSite[] = [];
  for (let atom = 0; atom < particle.source.nAtoms; atom++) {
    if (boundary.sourceVisibleMask[atom]) {
      sites.push({ sourceIndex: atom, shiftA: 0, shiftB: 0, shiftC: 0 });
    }
  }
  for (let image = 0; image < boundary.images.sourceIndices.length; image++) {
    const i3 = image * 3;
    sites.push({
      sourceIndex: boundary.images.sourceIndices[image],
      shiftA: boundary.images.latticeShifts[i3],
      shiftB: boundary.images.latticeShifts[i3 + 1],
      shiftC: boundary.images.latticeShifts[i3 + 2],
    });
  }
  return sites;
}

function completeBoundary(
  particle: ParticleData,
  topology: PeriodicBondTopologyData,
  mode: BoundaryCompletionParams["mode"],
): DrawingBoundaryData {
  const snapshot = particle.source;
  const boundary = particle.drawingBoundary!;
  const box = snapshot.box!;
  const sourceVisibleMask = new Uint8Array(boundary.sourceVisibleMask);
  const positions = Array.from(boundary.images.positions);
  const elements = Array.from(boundary.images.elements);
  const sourceIndices = Array.from(boundary.images.sourceIndices);
  const latticeShifts = Array.from(boundary.images.latticeShifts);
  const sites = collectDrawingSites(particle);
  const seen = new Set(sites.map(siteKey));
  const adjacency = buildAdjacency(snapshot.nAtoms, topology);
  const { componentByAtom, periodic } = classifyPeriodicComponents(adjacency);

  const addSite = (site: PeriodicSite): boolean => {
    const key = siteKey(site);
    if (seen.has(key)) return false;
    seen.add(key);
    if (site.shiftA === 0 && site.shiftB === 0 && site.shiftC === 0) {
      sourceVisibleMask[site.sourceIndex] = 1;
      return true;
    }
    const source3 = site.sourceIndex * 3;
    positions.push(
      snapshot.positions[source3] +
        site.shiftA * box[0] +
        site.shiftB * box[3] +
        site.shiftC * box[6],
      snapshot.positions[source3 + 1] +
        site.shiftA * box[1] +
        site.shiftB * box[4] +
        site.shiftC * box[7],
      snapshot.positions[source3 + 2] +
        site.shiftA * box[2] +
        site.shiftB * box[5] +
        site.shiftC * box[8],
    );
    elements.push(snapshot.elements[site.sourceIndex]);
    sourceIndices.push(site.sourceIndex);
    latticeShifts.push(site.shiftA, site.shiftB, site.shiftC);
    return true;
  };

  for (const seed of sites) {
    if (mode === "neighbors") {
      for (const edge of adjacency[seed.sourceIndex]) {
        addSite({
          sourceIndex: edge.target,
          shiftA: seed.shiftA + edge.shiftA,
          shiftB: seed.shiftB + edge.shiftB,
          shiftC: seed.shiftC + edge.shiftC,
        });
      }
      continue;
    }

    const component = componentByAtom[seed.sourceIndex];
    if (component < 0 || periodic[component]) continue;
    const assigned = new Map<number, [number, number, number]>([
      [seed.sourceIndex, [seed.shiftA, seed.shiftB, seed.shiftC]],
    ]);
    const stack = [seed.sourceIndex];
    while (stack.length > 0) {
      const source = stack.pop()!;
      const sourceShift = assigned.get(source)!;
      addSite({
        sourceIndex: source,
        shiftA: sourceShift[0],
        shiftB: sourceShift[1],
        shiftC: sourceShift[2],
      });
      for (const edge of adjacency[source]) {
        if (assigned.has(edge.target)) continue;
        assigned.set(edge.target, [
          sourceShift[0] + edge.shiftA,
          sourceShift[1] + edge.shiftB,
          sourceShift[2] + edge.shiftC,
        ]);
        stack.push(edge.target);
      }
    }
  }

  const images: PeriodicAtomImageData = {
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    sourceIndices: new Uint32Array(sourceIndices),
    latticeShifts: new Int32Array(latticeShifts),
  };
  return { ...boundary, sourceVisibleMask, images };
}

/** Complete Drawing Boundary with bond-connected periodic display atoms. */
export function executeBoundaryCompletion(
  params: BoundaryCompletionParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
  const bond = inputs.get("bond")?.[0] as BondData | undefined;
  if (!particle || !bond) return outputs;

  const topology = bond.periodicTopology;
  const box = particle.source.box;
  if (!particle.drawingBoundary || !topology || !box || !box.some((value) => value !== 0)) {
    outputs.set("particle", particle);
    outputs.set("bond", bond);
    return outputs;
  }

  const completedParticle: ParticleData = {
    ...particle,
    drawingBoundary: completeBoundary(particle, topology, params.mode),
  };
  const rendered = expandPeriodicTopologyForDrawingBoundary(completedParticle, topology);
  const completedBond: BondData = {
    ...bond,
    bondIndices: rendered.bondIndices,
    bondOrders: rendered.bondOrders,
    nBonds: rendered.nBonds,
    positions: rendered.positions,
    elements: rendered.elements,
    nAtoms: rendered.nAtoms,
    imageMap: rendered.imageMap ?? null,
    ghostSourceIndices: rendered.ghostSourceIndices,
    selectedBondIndices: null,
    bondOpacityOverrides: null,
    periodicImages: null,
  };
  outputs.set("particle", completedParticle);
  outputs.set("bond", completedBond);
  return outputs;
}
