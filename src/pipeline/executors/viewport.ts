import type {
  ParticleData,
  BondData,
  CellData,
  TrajectoryData,
  LabelData,
  MeshData,
  VectorData,
  ViewportParams,
  ViewportState,
  PipelineData,
  RepresentationMode,
} from "../types";

export function executeViewport(
  params: ViewportParams,
  inputs: Map<string, PipelineData[]>,
): ViewportState {
  const particles = (inputs.get("particle") ?? []) as ParticleData[];
  const bonds = (inputs.get("bond") ?? []) as BondData[];
  const cells = (inputs.get("cell") ?? []) as CellData[];
  const trajectories = (inputs.get("trajectory") ?? []) as TrajectoryData[];
  const labels = (inputs.get("label") ?? []) as LabelData[];
  const meshes = (inputs.get("mesh") ?? []) as MeshData[];
  const vectors = (inputs.get("vector") ?? []) as VectorData[];

  const filteredBonds = filterBondsByParticles(bonds, particles);

  const sortedTrajectories = [...trajectories].sort((a, b) => {
    if (a.source === "file" && b.source !== "file") return -1;
    if (a.source !== "file" && b.source === "file") return 1;
    return 0;
  });

  return {
    particles,
    bonds: filteredBonds,
    cells,
    trajectories: sortedTrajectories,
    labels,
    meshes,
    vectors,
    perspective: params.perspective,
    cellAxesVisible: params.cellAxesVisible,
    pivotMarkerVisible: params.pivotMarkerVisible ?? true,
    ...resolveRepresentation(particles),
  };
}

/**
 * Resolve the effective representation from the incoming particle streams.
 *
 * Each atom takes the override of the *first* stream that both carries a
 * `representationOverride` and covers it, where selection streams (`indices`
 * set) come before whole-structure ones — so a selection's style beats a
 * global style set upstream of it, and among streams of one kind stream order
 * decides, as before. Atoms no override stream covers fall back to the base
 * mode.
 *
 * When every atom ends up with the same mode we return it as the global
 * `representationMode` with `representationByAtom: null` (the fast path that
 * preserves the previous single-mode behavior). When branches disagree (e.g.
 * "water as lines, the rest ball-and-stick") we return a per-atom array plus a
 * global `representationMode` set to the base mesh mode for the non-line atoms.
 */
function resolveRepresentation(particles: ParticleData[]): {
  representationMode: RepresentationMode;
  representationByAtom: RepresentationMode[] | null;
} {
  let nAtoms = 0;
  for (const p of particles) nAtoms = Math.max(nAtoms, p.source?.nAtoms ?? 0);
  if (nAtoms === 0) return { representationMode: "atoms", representationByAtom: null };

  const whole = particles.filter((p) => p.indices === null);
  const subsets = particles.filter((p) => p.indices !== null);

  // The global mesh mode for atoms that no override or a non-"line" override
  // covers: the first non-"line" override seen (whole-structure streams
  // first), else "atoms".
  let base: RepresentationMode = "atoms";
  for (const p of [...whole, ...subsets]) {
    if (p.representationOverride && p.representationOverride !== "line") {
      base = p.representationOverride;
      break;
    }
  }

  // First covering override wins per atom; undefined entries fall back to base.
  const assigned: (RepresentationMode | undefined)[] = new Array(nAtoms);
  for (const p of [...subsets, ...whole]) {
    const mode = p.representationOverride;
    if (!mode) continue;
    if (p.indices === null) {
      for (let i = 0; i < nAtoms; i++) if (assigned[i] === undefined) assigned[i] = mode;
    } else {
      for (const i of p.indices) if (i < nAtoms && assigned[i] === undefined) assigned[i] = mode;
    }
  }

  const byAtom: RepresentationMode[] = new Array(nAtoms);
  let uniform = true;
  for (let i = 0; i < nAtoms; i++) {
    byAtom[i] = assigned[i] ?? base;
    if (byAtom[i] !== byAtom[0]) uniform = false;
  }

  if (uniform) return { representationMode: byAtom[0], representationByAtom: null };
  return { representationMode: base, representationByAtom: byAtom };
}

/**
 * Drop bonds whose atoms are not present in any connected particle stream.
 */
function filterBondsByParticles(bonds: BondData[], particles: ParticleData[]): BondData[] {
  if (bonds.length === 0 || particles.length === 0) return bonds;

  let allIndices: Set<number> | null = null;
  for (const p of particles) {
    if (p.indices === null) {
      return bonds;
    }
    if (!allIndices) {
      allIndices = new Set(p.indices);
    } else {
      for (const idx of p.indices) {
        allIndices.add(idx);
      }
    }
  }

  if (!allIndices) return bonds;

  return bonds.map((bond) => {
    const validBondPairs: number[] = [];
    const validOrders: number[] = [];
    for (let i = 0; i < bond.nBonds; i++) {
      const a = bond.bondIndices[i * 2];
      const b = bond.bondIndices[i * 2 + 1];
      if (allIndices!.has(a) && allIndices!.has(b)) {
        validBondPairs.push(a, b);
        if (bond.bondOrders) validOrders.push(bond.bondOrders[i]);
      }
    }
    if (validBondPairs.length === bond.nBonds * 2) return bond;
    return {
      ...bond,
      bondIndices: new Uint32Array(validBondPairs),
      bondOrders: bond.bondOrders ? new Uint8Array(validOrders) : null,
      nBonds: validBondPairs.length / 2,
    };
  });
}
