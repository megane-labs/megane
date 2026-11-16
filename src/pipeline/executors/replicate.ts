import type { Snapshot, Frame, TrajectoryMeta } from "../../types";
import type {
  PipelineData,
  ParticleData,
  CellData,
  ReplicateParams,
  TrajectoryData,
  FrameProvider,
} from "../types";
import { invert3x3, isDrawableCell } from "./mathUtils";
import { tileArray, tileIndices, tileLabels } from "./tile";

/**
 * Replicate node — OVITO/VESTA-style supercell builder.
 *
 * Copies every atom (and its bonds) into an `nx × ny × nz` grid of cell
 * images (images placed in the +a/+b/+c directions, the original cell
 * included) and enlarges the simulation cell to `nx·a, ny·b, nz·c` so the
 * viewport draws the full supercell boundary.
 *
 * Requires a unit cell on the input particle stream — without lattice
 * vectors there is no way to place images, so the input is passed through
 * unchanged (the dispatcher surfaces a warning in that case). An identity
 * replication (1×1×1) is likewise a pass-through.
 */
export function executeReplicate(
  params: ReplicateParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
  const cellIn = inputs.get("cell")?.[0] as CellData | undefined;
  const trajIn = inputs.get("trajectory")?.[0] as TrajectoryData | undefined;
  if (!particle) return outputs;

  const nx = Math.max(1, Math.floor(params.nx));
  const ny = Math.max(1, Math.floor(params.ny));
  const nz = Math.max(1, Math.floor(params.nz));
  const box = particle.source.box;

  // Pass-through: identity replication, or no cell to replicate along.
  if ((nx === 1 && ny === 1 && nz === 1) || !box) {
    outputs.set("particle", particle);
    if (cellIn) outputs.set("cell", cellIn);
    if (trajIn) outputs.set("trajectory", trajIn);
    return outputs;
  }

  const src = particle.source;
  const total = nx * ny * nz;
  const nAtomsOld = src.nAtoms;

  // The pipeline re-executes on every node edit; the supercell of an unchanged
  // structure is the same object each time, so the viewport does not reload
  // (and re-fit the camera to) a structure that did not change.
  let cached = replicateCache.get(src);
  if (!cached || cached.nx !== nx || cached.ny !== ny || cached.nz !== nz) {
    cached = { nx, ny, nz, snapshot: replicateSnapshot(src, box, nx, ny, nz) };
    replicateCache.set(src, cached);
  }
  const newSnapshot = cached.snapshot;
  const newBox = newSnapshot.box!;

  const newParticle: ParticleData = {
    ...particle,
    source: newSnapshot,
    indices: particle.indices && tileIndices(particle.indices, nAtomsOld, total),
    scaleOverrides: particle.scaleOverrides && tileArray(particle.scaleOverrides, total),
    opacityOverrides: particle.opacityOverrides && tileArray(particle.opacityOverrides, total),
    colorOverrides: particle.colorOverrides && tileArray(particle.colorOverrides, total),
  };
  outputs.set("particle", newParticle);

  const newCell: CellData = {
    type: "cell",
    sourceNodeId: cellIn?.sourceNodeId ?? particle.sourceNodeId,
    box: newBox,
  };
  outputs.set("cell", newCell);

  // Trajectory: wrap the upstream provider so every frame is tiled across the
  // same image grid as the static snapshot. Without this the replicated copies
  // would freeze at their base positions while only the original cell animates.
  if (trajIn) {
    if (
      cached.trajectorySource !== trajIn.provider ||
      cached.trajectorySourceMeta !== trajIn.meta ||
      !cached.trajectory
    ) {
      const newMeta: TrajectoryMeta = {
        ...trajIn.meta,
        nAtoms: trajIn.meta.nAtoms * total,
      };
      cached.trajectorySource = trajIn.provider;
      cached.trajectorySourceMeta = trajIn.meta;
      cached.trajectory = new ReplicatedFrameProvider(trajIn.provider, [nx, ny, nz], box, newMeta);
    }
    const newTrajectory: TrajectoryData = {
      type: "trajectory",
      provider: cached.trajectory,
      meta: cached.trajectory.meta,
      source: trajIn.source,
    };
    outputs.set("trajectory", newTrajectory);
  } else {
    cached.trajectorySource = undefined;
    cached.trajectorySourceMeta = undefined;
    cached.trajectory = undefined;
  }

  return outputs;
}

/**
 * What the last execution produced per input snapshot (see `executeReplicate`):
 * the supercell, and the provider replicating the connected trajectory.
 */
interface ReplicateCacheEntry {
  nx: number;
  ny: number;
  nz: number;
  snapshot: Snapshot;
  trajectorySource?: FrameProvider;
  trajectorySourceMeta?: TrajectoryMeta;
  trajectory?: FrameProvider;
}
const replicateCache = new WeakMap<Snapshot, ReplicateCacheEntry>();

/**
 * Per-image translation offsets (length `nx·ny·nz·3`) — the single source of
 * truth for image placement, used for both the static snapshot and trajectory
 * frames. Image order: i (nx outer), j (ny), k (nz inner), matching the atom
 * layout. Rows of the row-major 3×3 `box` are the lattice vectors a, b, c.
 */
function imageOffsets(box: Float32Array, nx: number, ny: number, nz: number): Float32Array {
  const offsets = new Float32Array(nx * ny * nz * 3);
  let m = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++, m++) {
        offsets[m * 3] = i * box[0] + j * box[3] + k * box[6];
        offsets[m * 3 + 1] = i * box[1] + j * box[4] + k * box[7];
        offsets[m * 3 + 2] = i * box[2] + j * box[5] + k * box[8];
      }
    }
  }
  return offsets;
}

/** The cell spanning the full supercell: `nx·a, ny·b, nz·c`. */
function supercellBox(box: Float32Array, nx: number, ny: number, nz: number): Float32Array {
  return new Float32Array([
    nx * box[0],
    nx * box[1],
    nx * box[2],
    ny * box[3],
    ny * box[4],
    ny * box[5],
    nz * box[6],
    nz * box[7],
    nz * box[8],
  ]);
}

/** Every atom and bond of `src` copied into the `nx × ny × nz` image grid. */
function replicateSnapshot(
  src: Snapshot,
  box: Float32Array,
  nx: number,
  ny: number,
  nz: number,
): Snapshot {
  const total = nx * ny * nz;
  const nAtomsOld = src.nAtoms;
  const nAtomsNew = nAtomsOld * total;
  const nBondsOld = src.nBonds;

  const offsets = imageOffsets(box, nx, ny, nz);

  const positions = new Float32Array(nAtomsNew * 3);
  const elements = new Uint8Array(nAtomsNew);
  const atomChainIds = src.atomChainIds ? new Uint8Array(nAtomsNew) : null;
  const atomBFactors = src.atomBFactors ? new Float32Array(nAtomsNew) : null;

  for (let img = 0; img < total; img++) {
    const offX = offsets[img * 3];
    const offY = offsets[img * 3 + 1];
    const offZ = offsets[img * 3 + 2];
    const atomBase = img * nAtomsOld;
    for (let a = 0; a < nAtomsOld; a++) {
      const dst = (atomBase + a) * 3;
      const s = a * 3;
      positions[dst] = src.positions[s] + offX;
      positions[dst + 1] = src.positions[s + 1] + offY;
      positions[dst + 2] = src.positions[s + 2] + offZ;
      elements[atomBase + a] = src.elements[a];
      if (atomChainIds) atomChainIds[atomBase + a] = src.atomChainIds![a];
      if (atomBFactors) atomBFactors[atomBase + a] = src.atomBFactors![a];
    }
  }

  // Bonds: image-aware tiling (OVITO/VESTA-style supercell connectivity).
  //
  // A unit-cell bond (i,j) that crosses a periodic boundary actually connects
  // atom i to the *periodic image* of j shifted by an integer lattice
  // combination g = round(B⁻¹·(posⱼ−posᵢ)). After replication that partner is
  // usually a real atom in a neighboring image, so bond (i@I) must point at
  // (j@(I−g)) rather than blindly at (j@I). For g=0 (intra-cell) bonds this
  // reduces to the old naive tiling. Boundary bonds that fall outside the
  // supercell wrap around (positive modulo); their endpoints end up a full
  // supercell apart, which the downstream add_bond `processPbcBonds` step then
  // splits into ghost-atom stubs — exactly as it does for a single cell.
  //
  // Per-bond integer shift g, derived from the *original* (unit-cell) box.
  const boxInv = invert3x3(box);
  const bondShifts = new Int32Array(nBondsOld * 3);
  if (boxInv) {
    for (let bd = 0; bd < nBondsOld; bd++) {
      const i = src.bonds[bd * 2];
      const j = src.bonds[bd * 2 + 1];
      const dx = src.positions[j * 3] - src.positions[i * 3];
      const dy = src.positions[j * 3 + 1] - src.positions[i * 3 + 1];
      const dz = src.positions[j * 3 + 2] - src.positions[i * 3 + 2];
      // Fractional displacement (row-major inverse, matching addBond.ts).
      const sx = boxInv[0] * dx + boxInv[3] * dy + boxInv[6] * dz;
      const sy = boxInv[1] * dx + boxInv[4] * dy + boxInv[7] * dz;
      const sz = boxInv[2] * dx + boxInv[5] * dy + boxInv[8] * dz;
      bondShifts[bd * 3] = Math.round(sx);
      bondShifts[bd * 3 + 1] = Math.round(sy);
      bondShifts[bd * 3 + 2] = Math.round(sz);
    }
  }
  // Flatten an image triple to its atom-block index (matches the offsets loop:
  // ix outer (nx), iy (ny), iz inner (nz)).
  const imageIndex = (ix: number, iy: number, iz: number) => (ix * ny + iy) * nz + iz;
  const posMod = (v: number, n: number) => ((v % n) + n) % n;

  const bonds = new Uint32Array(nBondsOld * total * 2);
  const bondOrders = src.bondOrders ? new Uint8Array(nBondsOld * total) : null;
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const m = imageIndex(ix, iy, iz);
        const srcOffset = m * nAtomsOld;
        const bondBase = m * nBondsOld;
        for (let bd = 0; bd < nBondsOld; bd++) {
          const gx = bondShifts[bd * 3];
          const gy = bondShifts[bd * 3 + 1];
          const gz = bondShifts[bd * 3 + 2];
          const jImage = imageIndex(posMod(ix - gx, nx), posMod(iy - gy, ny), posMod(iz - gz, nz));
          const dstOffset = jImage * nAtomsOld;
          bonds[(bondBase + bd) * 2] = src.bonds[bd * 2] + srcOffset;
          bonds[(bondBase + bd) * 2 + 1] = src.bonds[bd * 2 + 1] + dstOffset;
          if (bondOrders) bondOrders[bondBase + bd] = src.bondOrders![bd];
        }
      }
    }
  }

  // Cα backbone arrays (optional): caIndices shift per image, the rest tile.
  // The Cα arrays other than caIndices only exist alongside it.
  const ca = src.caIndices;
  const caIndices = ca && tileIndices(ca, nAtomsOld, total);
  const caChainIds = ca && src.caChainIds && tileArray(src.caChainIds, total);
  const caResNums = ca && src.caResNums && tileArray(src.caResNums, total);
  const caSsType = ca && src.caSsType && tileArray(src.caSsType, total);

  // Enlarge the cell to span the full supercell.
  const newBox = supercellBox(box, nx, ny, nz);

  const newSnapshot: Snapshot = {
    nAtoms: nAtomsNew,
    nBonds: nBondsOld * total,
    nFileBonds: src.nFileBonds * total,
    positions,
    elements,
    bonds,
    bondOrders,
    box: newBox,
    // Replication extends the cell from the same lower corner, so the origin
    // (where the wireframe is anchored) is unchanged.
    boxOrigin: src.boxOrigin,
    atomChainIds,
    atomBFactors,
    atomLabels: src.atomLabels && tileLabels(src.atomLabels, nAtomsOld, total),
    caIndices,
    caChainIds,
    caResNums,
    caSsType,
  };
  return newSnapshot;
}

/**
 * Wraps a FrameProvider and replicates each frame's positions across the
 * `nx×ny×nz` image grid. A frame that carries its own cell (a variable-cell
 * run) is tiled along *that* cell and keeps it, enlarged like the static one;
 * tiling it along the structure's cell left gaps or overlaps between the
 * images and drew the structure's supercell around atoms it no longer fitted.
 * Other frames use the structure's cell. The number of atoms per image is
 * derived from each frame's own positions array, so the provider stays robust
 * to frame/structure atom-count differences. Streaming semantics are
 * preserved: `getFrame` returns `null` when the wrapped provider has no frame
 * available yet.
 */
class ReplicatedFrameProvider implements FrameProvider {
  readonly kind: "memory" | "stream";
  readonly meta: TrajectoryMeta;
  private readonly source: FrameProvider;
  private readonly counts: [number, number, number];
  private readonly baseOffsets: Float32Array;
  private readonly total: number;

  constructor(
    source: FrameProvider,
    counts: [number, number, number],
    baseBox: Float32Array,
    meta: TrajectoryMeta,
  ) {
    this.source = source;
    this.counts = counts;
    this.baseOffsets = imageOffsets(baseBox, counts[0], counts[1], counts[2]);
    this.total = counts[0] * counts[1] * counts[2];
    this.kind = source.kind;
    this.meta = meta;
  }

  heldBytes(): number {
    return this.source.heldBytes?.() ?? 0;
  }

  getFrame(index: number): Frame | null {
    const frame = this.source.getFrame(index);
    if (!frame) return null;
    const [nx, ny, nz] = this.counts;
    const cell = isDrawableCell(frame.box) ? frame.box : null;
    const offsets = cell ? imageOffsets(cell, nx, ny, nz) : this.baseOffsets;
    const nAtomsPerImage = frame.positions.length / 3;
    const out = new Float32Array(nAtomsPerImage * this.total * 3);
    for (let img = 0; img < this.total; img++) {
      const offX = offsets[img * 3];
      const offY = offsets[img * 3 + 1];
      const offZ = offsets[img * 3 + 2];
      const base = img * nAtomsPerImage * 3;
      for (let a = 0; a < nAtomsPerImage; a++) {
        const s = a * 3;
        const dst = base + s;
        out[dst] = frame.positions[s] + offX;
        out[dst + 1] = frame.positions[s + 1] + offY;
        out[dst + 2] = frame.positions[s + 2] + offZ;
      }
    }
    const replicated: Frame = {
      frameId: frame.frameId,
      nAtoms: nAtomsPerImage * this.total,
      positions: out,
    };
    if (cell) {
      replicated.box = supercellBox(cell, nx, ny, nz);
      // The supercell grows from the same lower corner as the frame's cell.
      if (frame.boxOrigin !== undefined) replicated.boxOrigin = frame.boxOrigin;
    }
    return replicated;
  }
}
