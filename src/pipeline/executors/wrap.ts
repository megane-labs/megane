import type { Snapshot, Frame, TrajectoryMeta } from "../../types";
import type {
  PipelineData,
  ParticleData,
  TrajectoryData,
  WrapParams,
  FrameProvider,
} from "../types";
import { invert3x3 } from "./mathUtils";
import { inferBondsVdwJS } from "../../parsers/inferBondsJS";

/**
 * Wrap / Unwrap node — periodic-image coordinate mapping.
 *
 * "wrap" folds every atom back into the home unit cell (fractional [0,1),
 * anchored at the snapshot's box origin). "unwrap" shifts atoms by whole
 * lattice vectors so bonded molecules that straddle a periodic face become
 * spatially contiguous — the VESTA/Mercury whole-molecule depiction. The unit
 * cell itself is never changed, so unwrapped molecules may poke outside the
 * cell wireframe.
 *
 * Connectivity for the unwrap comes from the file's own bonds when the
 * snapshot carries any; otherwise it is inferred with the same PBC-aware VDW
 * criterion the add_bond node uses, so exactly the bonds the user would see
 * are used to knit each molecule together.
 *
 * "none" (the default), a missing unit cell, or a singular cell matrix are
 * pass-throughs, which keeps the node safe to wire into default pipelines as
 * an on-demand toggle. A connected trajectory is remapped per frame through a
 * wrapping FrameProvider so playback follows the same convention as the
 * static snapshot.
 */
export function executeWrap(
  params: WrapParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
  const trajIn = inputs.get("trajectory")?.[0] as TrajectoryData | undefined;
  if (!particle) return outputs;

  const src = particle.source;
  const box = src.box;
  const boxInv = box ? invert3x3(box) : null;

  // Pass-through: nothing to do, or no usable cell to map against.
  if (params.mode === "none" || !box || !boxInv) {
    outputs.set("particle", particle);
    if (trajIn) outputs.set("trajectory", trajIn);
    return outputs;
  }

  let mapFrame: (
    positions: Float32Array,
    box: Float32Array,
    origin: Float32Array | null,
  ) => Float32Array;
  if (params.mode === "wrap") {
    mapFrame = wrapPositions;
  } else {
    // Unwrap connectivity is fixed by the topology: file bonds when present,
    // otherwise the same PBC-aware VDW inference add_bond's distance mode uses.
    const bondPairs =
      src.nBonds > 0
        ? src.bonds
        : inferBondsVdwJS(src.positions, src.elements, src.nAtoms, undefined, box);
    const adjacency = buildAdjacency(bondPairs, src.nAtoms);
    mapFrame = (positions, frameBox, origin) =>
      unwrapPositions(positions, frameBox, origin, adjacency);
  }

  const newSnapshot: Snapshot = {
    ...src,
    positions: mapFrame(src.positions, box, src.boxOrigin),
  };
  outputs.set("particle", { ...particle, source: newSnapshot });

  if (trajIn) {
    const newTrajectory: TrajectoryData = {
      type: "trajectory",
      provider: new MappedFrameProvider(trajIn.provider, mapFrame, box, src.boxOrigin),
      meta: trajIn.meta,
      source: trajIn.source,
    };
    outputs.set("trajectory", newTrajectory);
  }

  return outputs;
}

/** CSR adjacency over the bond graph: neighbor list per atom. */
interface Adjacency {
  nAtoms: number;
  /** neighbors[start[i]..start[i+1]) are the atoms bonded to atom i. */
  start: Uint32Array;
  neighbors: Uint32Array;
}

function buildAdjacency(bondPairs: Uint32Array, nAtoms: number): Adjacency {
  const start = new Uint32Array(nAtoms + 1);
  const nBonds = bondPairs.length / 2;
  for (let b = 0; b < nBonds; b++) {
    start[bondPairs[b * 2] + 1]++;
    start[bondPairs[b * 2 + 1] + 1]++;
  }
  for (let i = 0; i < nAtoms; i++) start[i + 1] += start[i];
  const neighbors = new Uint32Array(nBonds * 2);
  const cursor = Uint32Array.from(start.subarray(0, nAtoms));
  for (let b = 0; b < nBonds; b++) {
    const i = bondPairs[b * 2];
    const j = bondPairs[b * 2 + 1];
    neighbors[cursor[i]++] = j;
    neighbors[cursor[j]++] = i;
  }
  return { nAtoms, start, neighbors };
}

/**
 * Fold every atom into the home unit cell: fractional coordinates in [0,1)
 * relative to the box anchored at `origin`.
 */
function wrapPositions(
  positions: Float32Array,
  box: Float32Array,
  origin: Float32Array | null,
): Float32Array {
  const boxInv = invert3x3(box);
  if (!boxInv) return positions;
  const nAtoms = positions.length / 3;
  const out = new Float32Array(positions.length);
  const ox = origin ? origin[0] : 0;
  const oy = origin ? origin[1] : 0;
  const oz = origin ? origin[2] : 0;
  for (let i = 0; i < nAtoms; i++) {
    const px = positions[i * 3] - ox;
    const py = positions[i * 3 + 1] - oy;
    const pz = positions[i * 3 + 2] - oz;
    // Row-vector convention: position = frac · box (rows are lattice vectors).
    let fx = boxInv[0] * px + boxInv[3] * py + boxInv[6] * pz;
    let fy = boxInv[1] * px + boxInv[4] * py + boxInv[7] * pz;
    let fz = boxInv[2] * px + boxInv[5] * py + boxInv[8] * pz;
    fx -= Math.floor(fx);
    fy -= Math.floor(fy);
    fz -= Math.floor(fz);
    out[i * 3] = box[0] * fx + box[3] * fy + box[6] * fz + ox;
    out[i * 3 + 1] = box[1] * fx + box[4] * fy + box[7] * fz + oy;
    out[i * 3 + 2] = box[2] * fx + box[5] * fy + box[8] * fz + oz;
  }
  return out;
}

/**
 * Shift atoms by whole lattice vectors so every bonded connected component is
 * expressed in a single periodic image (flood fill; the first atom of each
 * component stays put). Mirrors `bonds::unwrap_molecules` in megane-core.
 * Shifts are recomputed from the given positions, so the same adjacency
 * applies to every trajectory frame.
 */
function unwrapPositions(
  positions: Float32Array,
  box: Float32Array,
  _origin: Float32Array | null,
  adjacency: Adjacency,
): Float32Array {
  const boxInv = invert3x3(box);
  const nAtoms = positions.length / 3;
  if (!boxInv || nAtoms !== adjacency.nAtoms) return positions;

  // Fractional coordinates of every atom (row-vector convention).
  const frac = new Float32Array(nAtoms * 3);
  for (let i = 0; i < nAtoms; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    frac[i * 3] = boxInv[0] * px + boxInv[3] * py + boxInv[6] * pz;
    frac[i * 3 + 1] = boxInv[1] * px + boxInv[4] * py + boxInv[7] * pz;
    frac[i * 3 + 2] = boxInv[2] * px + boxInv[5] * py + boxInv[8] * pz;
  }

  // Accumulated whole-lattice shift per atom, in lattice units.
  const shift = new Int32Array(nAtoms * 3);
  const visited = new Uint8Array(nAtoms);
  const stack: number[] = [];
  for (let seed = 0; seed < nAtoms; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    stack.push(seed);
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (let k = adjacency.start[i]; k < adjacency.start[i + 1]; k++) {
        const j = adjacency.neighbors[k];
        if (visited[j]) continue;
        visited[j] = 1;
        // Minimum image of j relative to i's (already shifted) placement:
        // S_j − S_i = −round((f_j − f_i) − (S_i − 0))… expressed directly on
        // shifted fractionals so chained shifts accumulate correctly.
        const dx = frac[j * 3] - (frac[i * 3] + shift[i * 3]);
        const dy = frac[j * 3 + 1] - (frac[i * 3 + 1] + shift[i * 3 + 1]);
        const dz = frac[j * 3 + 2] - (frac[i * 3 + 2] + shift[i * 3 + 2]);
        shift[j * 3] = -Math.round(dx);
        shift[j * 3 + 1] = -Math.round(dy);
        shift[j * 3 + 2] = -Math.round(dz);
        stack.push(j);
      }
    }
  }

  const out = new Float32Array(positions.length);
  for (let i = 0; i < nAtoms; i++) {
    const sx = shift[i * 3];
    const sy = shift[i * 3 + 1];
    const sz = shift[i * 3 + 2];
    out[i * 3] = positions[i * 3] + sx * box[0] + sy * box[3] + sz * box[6];
    out[i * 3 + 1] = positions[i * 3 + 1] + sx * box[1] + sy * box[4] + sz * box[7];
    out[i * 3 + 2] = positions[i * 3 + 2] + sx * box[2] + sy * box[5] + sz * box[8];
  }
  return out;
}

/**
 * Wraps a FrameProvider and remaps each frame's positions with the node's
 * mapping function. Per-frame cells (variable-cell trajectories) take
 * precedence over the base snapshot's cell. Streaming semantics are
 * preserved: `getFrame` returns `null` when the wrapped provider has no
 * frame available yet.
 */
class MappedFrameProvider implements FrameProvider {
  readonly kind: "memory" | "stream";
  readonly meta: TrajectoryMeta;
  private readonly source: FrameProvider;
  private readonly mapFrame: (
    positions: Float32Array,
    box: Float32Array,
    origin: Float32Array | null,
  ) => Float32Array;
  private readonly baseBox: Float32Array;
  private readonly baseOrigin: Float32Array | null;

  constructor(
    source: FrameProvider,
    mapFrame: (
      positions: Float32Array,
      box: Float32Array,
      origin: Float32Array | null,
    ) => Float32Array,
    baseBox: Float32Array,
    baseOrigin: Float32Array | null,
  ) {
    this.source = source;
    this.mapFrame = mapFrame;
    this.baseBox = baseBox;
    this.baseOrigin = baseOrigin;
    this.kind = source.kind;
    this.meta = source.meta;
  }

  heldBytes(): number {
    return this.source.heldBytes?.() ?? 0;
  }

  getFrame(index: number): Frame | null {
    const frame = this.source.getFrame(index);
    if (!frame) return null;
    const box = frame.box ?? this.baseBox;
    const origin = frame.boxOrigin ?? this.baseOrigin;
    return {
      ...frame,
      positions: this.mapFrame(frame.positions, box, origin),
    };
  }
}
