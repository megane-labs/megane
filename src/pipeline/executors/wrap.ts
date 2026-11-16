import type { Snapshot, Frame, TrajectoryMeta } from "../../types";
import type {
  PipelineData,
  ParticleData,
  TrajectoryData,
  WrapParams,
  WrapMode,
  FrameProvider,
} from "../types";
import { invert3x3, isDrawableCell } from "./mathUtils";
import { inverse3, wrapFrac } from "../../crystal/cell";
import { inferBondsVdwJS } from "../../parsers/inferBondsJS";

/** Maps one coordinate set into its periodic-image convention for a given cell. */
type FrameMapper = (
  positions: Float32Array,
  box: Float32Array,
  origin: Float32Array | null,
) => Float32Array;

/**
 * Fractional tolerance of the fold. Coordinates are 32-bit floats, so an atom
 * a rounding error below a cell face (fractional -1e-8) used to be folded to
 * 1 - 1e-8, which rounds to the *opposite face itself* when it is stored — a
 * fractional coordinate of exactly 1, outside `[0, 1)`. With the tolerance an
 * atom within it of a face counts as on that face (ASE's `wrap(eps=…)`): it
 * lands on the lower face, never on the upper one.
 */
const WRAP_TOL = 1e-6;

/**
 * What the last execution produced per input snapshot. The pipeline
 * re-executes on every node edit; without this the node handed the viewport a
 * new (but identical) snapshot and trajectory provider each time, which
 * reloads the atom meshes and re-applies the frame — and the unwrap
 * connectivity was inferred again.
 */
interface WrapCacheEntry {
  mode: WrapMode;
  snapshot: Snapshot;
  mapFrame: FrameMapper;
  /** The upstream provider `trajectory` maps, when a trajectory was connected. */
  trajectorySource?: FrameProvider;
  trajectory?: FrameProvider;
}
const wrapCache = new WeakMap<Snapshot, WrapCacheEntry>();

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
 * "none" (the default) is a pass-through, which keeps the node safe to wire
 * into default pipelines as an on-demand toggle; so is a structure with no
 * usable cell and no trajectory. A connected trajectory is remapped per frame
 * through a wrapping FrameProvider so playback follows the same convention as
 * the static snapshot, each frame in the cell the renderer draws for it: the
 * frame's own cell when it carries one, the structure's otherwise. A topology
 * file without a cell (PSF, prmtop, a PDB without CRYST1) therefore still has
 * its trajectory folded into the cells the trajectory brings.
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
  const box = isDrawableCell(src.box) && invert3x3(src.box) ? src.box : null;

  // Pass-through: nothing to do, or no cell anywhere to map against (frames
  // may carry their own, so a trajectory keeps the node active).
  if (params.mode === "none" || (!box && !trajIn)) {
    outputs.set("particle", particle);
    if (trajIn) outputs.set("trajectory", trajIn);
    return outputs;
  }

  let cached = wrapCache.get(src);
  if (!cached || cached.mode !== params.mode) {
    let mapFrame: FrameMapper;
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
    const snapshot = box ? { ...src, positions: mapFrame(src.positions, box, src.boxOrigin) } : src;
    cached = { mode: params.mode, snapshot, mapFrame };
    wrapCache.set(src, cached);
  }

  outputs.set(
    "particle",
    cached.snapshot === src ? particle : { ...particle, source: cached.snapshot },
  );

  if (trajIn) {
    if (cached.trajectorySource !== trajIn.provider || !cached.trajectory) {
      cached.trajectorySource = trajIn.provider;
      cached.trajectory = new MappedFrameProvider(
        trajIn.provider,
        cached.mapFrame,
        box,
        src.boxOrigin,
      );
    }
    const newTrajectory: TrajectoryData = {
      type: "trajectory",
      provider: cached.trajectory,
      meta: trajIn.meta,
      source: trajIn.source,
    };
    outputs.set("trajectory", newTrajectory);
  } else {
    cached.trajectorySource = undefined;
    cached.trajectory = undefined;
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
 * relative to the box anchored at `origin` (to within `WRAP_TOL`, see there).
 * The inverse is taken in double precision: a single-precision one put an atom
 * exactly on a face a rounding error to either side of it.
 */
function wrapPositions(
  positions: Float32Array,
  box: Float32Array,
  origin: Float32Array | null,
): Float32Array {
  const boxInv = inverse3(box);
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
    const fx = wrapFrac(boxInv[0] * px + boxInv[3] * py + boxInv[6] * pz, WRAP_TOL);
    const fy = wrapFrac(boxInv[1] * px + boxInv[4] * py + boxInv[7] * pz, WRAP_TOL);
    const fz = wrapFrac(boxInv[2] * px + boxInv[5] * py + boxInv[8] * pz, WRAP_TOL);
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
 * mapping function, in the cell the renderer draws for that frame: the
 * frame's own when it carries a drawable one (variable-cell trajectories),
 * else the base snapshot's. A frame with no cell to map against is returned
 * as it is. Streaming semantics are preserved: `getFrame` returns `null` when
 * the wrapped provider has no frame available yet.
 */
class MappedFrameProvider implements FrameProvider {
  readonly kind: "memory" | "stream";
  readonly meta: TrajectoryMeta;
  private readonly source: FrameProvider;
  private readonly mapFrame: FrameMapper;
  private readonly baseBox: Float32Array | null;
  private readonly baseOrigin: Float32Array | null;

  constructor(
    source: FrameProvider,
    mapFrame: FrameMapper,
    baseBox: Float32Array | null,
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
    const box = isDrawableCell(frame.box) ? frame.box : this.baseBox;
    if (!box) return frame;
    const origin = frame.boxOrigin ?? this.baseOrigin;
    const positions = this.mapFrame(frame.positions, box, origin);
    return positions === frame.positions ? frame : { ...frame, positions };
  }
}
