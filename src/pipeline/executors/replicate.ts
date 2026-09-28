import type { Snapshot, Frame, TrajectoryMeta } from "../../types";
import type {
  PipelineData,
  ParticleData,
  CellData,
  ReplicateParams,
  TrajectoryData,
  FrameProvider,
} from "../types";
import { invert3x3 } from "./mathUtils";
import { tileArray, tileIndices } from "./tile";

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
  const nAtomsNew = nAtomsOld * total;
  const nBondsOld = src.nBonds;

  // Lattice vectors a, b, c (rows of the row-major 3×3 box matrix).
  const ax = box[0],
    ay = box[1],
    az = box[2];
  const bx = box[3],
    by = box[4],
    bz = box[5];
  const cx = box[6],
    cy = box[7],
    cz = box[8];

  // Per-image translation offsets — the single source of truth for image
  // placement, reused for both the static snapshot and trajectory frames.
  // Image order: i (nx outer), j (ny), k (nz inner), matching the atom layout.
  const offsets = new Float32Array(total * 3);
  {
    let m = 0;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nz; k++, m++) {
          offsets[m * 3] = i * ax + j * bx + k * cx;
          offsets[m * 3 + 1] = i * ay + j * by + k * cy;
          offsets[m * 3 + 2] = i * az + j * bz + k * cz;
        }
      }
    }
  }

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
  const newBox = new Float32Array([
    nx * ax,
    nx * ay,
    nx * az,
    ny * bx,
    ny * by,
    ny * bz,
    nz * cx,
    nz * cy,
    nz * cz,
  ]);

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
    caIndices,
    caChainIds,
    caResNums,
    caSsType,
  };

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
    const newMeta: TrajectoryMeta = {
      ...trajIn.meta,
      nAtoms: trajIn.meta.nAtoms * total,
    };
    const newTrajectory: TrajectoryData = {
      type: "trajectory",
      provider: new ReplicatedFrameProvider(trajIn.provider, offsets, newMeta),
      meta: newMeta,
      source: trajIn.source,
    };
    outputs.set("trajectory", newTrajectory);
  }

  return outputs;
}

/**
 * Wraps a FrameProvider and replicates each frame's positions across an
 * `nx×ny×nz` image grid using the supplied per-image `offsets` (length
 * `total·3`). The number of atoms per image is derived from each frame's own
 * positions array, so the provider stays robust to frame/structure atom-count
 * differences. Streaming semantics are preserved: `getFrame` returns `null`
 * when the wrapped provider has no frame available yet.
 */
class ReplicatedFrameProvider implements FrameProvider {
  readonly kind: "memory" | "stream";
  readonly meta: TrajectoryMeta;
  private readonly source: FrameProvider;
  private readonly offsets: Float32Array;
  private readonly total: number;

  constructor(source: FrameProvider, offsets: Float32Array, meta: TrajectoryMeta) {
    this.source = source;
    this.offsets = offsets;
    this.total = offsets.length / 3;
    this.kind = source.kind;
    this.meta = meta;
  }

  getFrame(index: number): Frame | null {
    const frame = this.source.getFrame(index);
    if (!frame) return null;
    const nAtomsPerImage = frame.positions.length / 3;
    const out = new Float32Array(nAtomsPerImage * this.total * 3);
    for (let img = 0; img < this.total; img++) {
      const offX = this.offsets[img * 3];
      const offY = this.offsets[img * 3 + 1];
      const offZ = this.offsets[img * 3 + 2];
      const base = img * nAtomsPerImage * 3;
      for (let a = 0; a < nAtomsPerImage; a++) {
        const s = a * 3;
        const dst = base + s;
        out[dst] = frame.positions[s] + offX;
        out[dst + 1] = frame.positions[s + 1] + offY;
        out[dst + 2] = frame.positions[s + 2] + offZ;
      }
    }
    return {
      frameId: frame.frameId,
      nAtoms: nAtomsPerImage * this.total,
      positions: out,
    };
  }
}
