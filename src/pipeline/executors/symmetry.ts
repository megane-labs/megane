import type { Snapshot } from "../../types";
import type { PipelineData, ParticleData, TrajectoryData, SymmetryParams } from "../types";
import { invert3x3 } from "./mathUtils";

/**
 * Symmetry node — space-group expansion of a crystallographic asymmetric unit.
 *
 * A CIF lists only the asymmetric unit plus the space-group operations
 * (`_symmetry_equiv_pos_as_xyz`), which the parser surfaces untouched on the
 * snapshot as `symmetryOps`. Mode "expand" (the default) applies those
 * operations to fill one unit cell with its symmetry-equivalent molecules, the
 * way VESTA does. Each operation is a rigid isometry, so every generated image
 * is a whole, rigidly-copied asymmetric unit — its internal bond graph is
 * identical to the original, and bonds are replicated by index offset rather
 * than re-inferred (which keeps molecules whole and avoids spurious bonds
 * across cell boundaries). Images coinciding within tolerance are dropped
 * (atoms on special positions).
 *
 * This is a faithful port of `crystal.rs::expand_symmetry` in megane-core;
 * the two implementations must stay in sync (see the note at the top of
 * `crates/megane-core/src/crystal.rs`).
 *
 * Pass-throughs keep the node safe to wire into every default pipeline:
 * mode "none", a snapshot without symmetry operations (every non-CIF format),
 * identity-only operations, a missing or singular unit cell — all forward the
 * inputs unchanged. A connected trajectory is likewise always passed through
 * untouched: no format carries both space-group operations and trajectory
 * frames today, and expanding only the base snapshot would desynchronize its
 * atom count from the frames, so when a trajectory input is present the
 * particle stream is passed through unexpanded as well (the engine surfaces a
 * warning, mirroring the wrap node's missing-unit-cell case).
 */
export function executeSymmetry(
  params: SymmetryParams,
  inputs: Map<string, PipelineData[]>,
): Map<string, PipelineData> {
  const outputs = new Map<string, PipelineData>();
  const particle = inputs.get("particle")?.[0] as ParticleData | undefined;
  const trajIn = inputs.get("trajectory")?.[0] as TrajectoryData | undefined;
  if (!particle) return outputs;

  const passThrough = () => {
    outputs.set("particle", particle);
    if (trajIn) outputs.set("trajectory", trajIn);
    return outputs;
  };

  const src = particle.source;
  if (params.mode === "none" || !src.symmetryOps?.length || !src.box || trajIn) {
    return passThrough();
  }

  const expanded = expandSymmetry(src, src.box, src.symmetryOps);
  if (!expanded) return passThrough();

  const nImages = expanded.nAtoms / src.nAtoms;
  outputs.set("particle", {
    ...particle,
    source: expanded,
    indices: tileIndices(particle.indices, src.nAtoms, nImages),
    scaleOverrides: tileFloat(particle.scaleOverrides, nImages),
    opacityOverrides: tileFloat(particle.opacityOverrides, nImages),
    colorOverrides: tileFloat(particle.colorOverrides, nImages),
  });
  return outputs;
}

/** A parsed symmetry operation: fractional 3×3 rotation + translation. */
interface Symop {
  /** Row-major 3×3 rotation/permutation acting on fractional coordinates. */
  rot: number[];
  /** Fractional translation. */
  trans: number[];
}

/** Parse a numeric token that may be a fraction ("1/2") or a decimal. */
function parseNum(s: string): number | null {
  const t = s.trim();
  const slash = t.indexOf("/");
  if (slash >= 0) {
    const n = Number(t.slice(0, slash).trim());
    const d = Number(t.slice(slash + 1).trim());
    if (!Number.isFinite(n) || !Number.isFinite(d)) return null;
    return n / d;
  }
  const v = Number(t);
  return Number.isFinite(v) && t.length > 0 ? v : null;
}

/**
 * Parse one component of a symop (e.g. "-x+1/2", "1/2-y", "z") into the
 * coefficients of (x, y, z) and the constant translation.
 */
function parseComponent(comp: string): { coef: number[]; trans: number } {
  const coef = [0, 0, 0];
  let trans = 0;
  const cleaned = comp.replace(/\s+/g, "");
  // Split into signed terms, keeping the sign with each term.
  const terms: string[] = [];
  let term = "";
  for (const ch of cleaned) {
    if ((ch === "+" || ch === "-") && term.length > 0) {
      terms.push(term);
      term = "";
    }
    term += ch;
  }
  if (term.length > 0) terms.push(term);
  for (const t of terms) {
    let sign = 1;
    let body = t;
    if (body.startsWith("+")) {
      body = body.slice(1);
    } else if (body.startsWith("-")) {
      sign = -1;
      body = body.slice(1);
    }
    const axis = body.search(/[xyzXYZ]/);
    if (axis >= 0) {
      const ch = body[axis].toLowerCase();
      const numPart = body.slice(0, axis) + body.slice(axis + 1);
      const mag =
        numPart.length === 0 || numPart === "*" ? 1 : (parseNum(numPart.replace(/\*+$/, "")) ?? 1);
      const idx = ch === "x" ? 0 : ch === "y" ? 1 : 2;
      coef[idx] += sign * mag;
    } else {
      const v = parseNum(body);
      if (v !== null) trans += sign * v;
    }
  }
  return { coef, trans };
}

/** Parse a CIF symmetry operation string (e.g. "-x+1/2,y+1/2,-z"). */
export function parseSymop(op: string): Symop | null {
  const comps = op.split(",");
  if (comps.length !== 3) return null;
  const rot = new Array<number>(9).fill(0);
  const trans = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    const { coef, trans: t } = parseComponent(comps[r]);
    rot[r * 3] = coef[0];
    rot[r * 3 + 1] = coef[1];
    rot[r * 3 + 2] = coef[2];
    trans[r] = t;
  }
  return { rot, trans };
}

function isIdentity(op: Symop): boolean {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return op.rot.every((v, i) => v === I[i]) && op.trans.every((v) => v === 0);
}

/**
 * Apply the space-group operations to the asymmetric unit, filling one unit
 * cell. Returns `null` when there is nothing to do (no usable operations, only
 * the identity, no atoms, or a singular cell) so the caller passes the
 * original stream through.
 */
function expandSymmetry(src: Snapshot, box: Float32Array, symops: string[]): Snapshot | null {
  const ops = symops.map(parseSymop).filter((op): op is Symop => op !== null);
  if (ops.length === 0 || (ops.length === 1 && isIdentity(ops[0]))) return null;
  const boxInv = invert3x3(box);
  if (!boxInv) return null;
  const nBase = src.nAtoms;
  if (nBase === 0) return null;

  // Fractional coordinates of the asymmetric unit (row-vector convention:
  // cartesian = frac · box, rows of `box` are the cell vectors).
  const baseFrac = new Float64Array(nBase * 3);
  for (let i = 0; i < nBase; i++) {
    const px = src.positions[i * 3];
    const py = src.positions[i * 3 + 1];
    const pz = src.positions[i * 3 + 2];
    baseFrac[i * 3] = boxInv[0] * px + boxInv[3] * py + boxInv[6] * pz;
    baseFrac[i * 3 + 1] = boxInv[1] * px + boxInv[4] * py + boxInv[7] * pz;
    baseFrac[i * 3 + 2] = boxInv[2] * px + boxInv[5] * py + boxInv[8] * pz;
  }

  // Each operation produces one rigid image, wrapped (by centroid) into the
  // home cell so molecules stay whole. Images coinciding within tolerance are
  // dropped (atoms on special positions).
  const seen = new Set<string>();
  const imageFracs: Float64Array[] = [];
  for (const op of ops) {
    const frac = new Float64Array(nBase * 3);
    let cx = 0,
      cy = 0,
      cz = 0;
    for (let i = 0; i < nBase; i++) {
      const fa = baseFrac[i * 3];
      const fb = baseFrac[i * 3 + 1];
      const fc = baseFrac[i * 3 + 2];
      const na = op.rot[0] * fa + op.rot[1] * fb + op.rot[2] * fc + op.trans[0];
      const nb = op.rot[3] * fa + op.rot[4] * fb + op.rot[5] * fc + op.trans[1];
      const nc = op.rot[6] * fa + op.rot[7] * fb + op.rot[8] * fc + op.trans[2];
      frac[i * 3] = na;
      frac[i * 3 + 1] = nb;
      frac[i * 3 + 2] = nc;
      cx += na;
      cy += nb;
      cz += nc;
    }
    const sx = -Math.floor(cx / nBase);
    const sy = -Math.floor(cy / nBase);
    const sz = -Math.floor(cz / nBase);
    for (let i = 0; i < nBase; i++) {
      frac[i * 3] += sx;
      frac[i * 3 + 1] += sy;
      frac[i * 3 + 2] += sz;
    }
    const key = imageKey(frac, nBase);
    if (!seen.has(key)) {
      seen.add(key);
      imageFracs.push(frac);
    }
  }

  const nImages = imageFracs.length;
  const nAtoms = nBase * nImages;
  const positions = new Float32Array(nAtoms * 3);
  const elements = new Uint8Array(nAtoms);
  const atomChainIds = src.atomChainIds ? new Uint8Array(nAtoms) : null;
  const atomBFactors = src.atomBFactors ? new Float32Array(nAtoms) : null;
  for (let im = 0; im < nImages; im++) {
    const frac = imageFracs[im];
    const base = im * nBase;
    for (let a = 0; a < nBase; a++) {
      const fa = frac[a * 3];
      const fb = frac[a * 3 + 1];
      const fc = frac[a * 3 + 2];
      const o = (base + a) * 3;
      positions[o] = fa * box[0] + fb * box[3] + fc * box[6];
      positions[o + 1] = fa * box[1] + fb * box[4] + fc * box[7];
      positions[o + 2] = fa * box[2] + fb * box[5] + fc * box[8];
      elements[base + a] = src.elements[a];
      if (atomChainIds) atomChainIds[base + a] = src.atomChainIds![a];
      if (atomBFactors) atomBFactors[base + a] = src.atomBFactors![a];
    }
  }

  // Replicate bonds with a per-image atom-index offset.
  const nBondsBase = src.nBonds;
  const bonds = new Uint32Array(nBondsBase * nImages * 2);
  const bondOrders = src.bondOrders ? new Uint8Array(nBondsBase * nImages) : null;
  for (let im = 0; im < nImages; im++) {
    const off = im * nBase;
    const bondBase = im * nBondsBase;
    for (let b = 0; b < nBondsBase; b++) {
      bonds[(bondBase + b) * 2] = src.bonds[b * 2] + off;
      bonds[(bondBase + b) * 2 + 1] = src.bonds[b * 2 + 1] + off;
      if (bondOrders) bondOrders[bondBase + b] = src.bondOrders![b];
    }
  }

  return {
    ...src,
    nAtoms,
    nBonds: nBondsBase * nImages,
    nFileBonds: src.nFileBonds * nImages,
    positions,
    elements,
    bonds,
    bondOrders,
    atomChainIds,
    atomBFactors,
    // Cα backbone arrays: caIndices shift per image, the rest tile. CIF (the
    // only ops-bearing format) never carries them, but stale asymmetric-unit
    // arrays must not survive on an expanded snapshot.
    caIndices: src.caIndices ? tileIndices(src.caIndices, nBase, nImages)! : undefined,
    caChainIds: src.caChainIds ? tileUint8(src.caChainIds, nImages) : undefined,
    caResNums: src.caResNums ? tileUint32(src.caResNums, nImages) : undefined,
    caSsType: src.caSsType ? tileUint8(src.caSsType, nImages) : undefined,
    // The operations remain file information; expansion consumed them but they
    // stay visible downstream.
  };
}

/** Round centroid + first atom to a stable key for image deduplication. */
function imageKey(frac: Float64Array, n: number): string {
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let a = 0; a < n; a++) {
    cx += frac[a * 3];
    cy += frac[a * 3 + 1];
    cz += frac[a * 3 + 2];
  }
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return `${r(cx / n)},${r(cy / n)},${r(cz / n)}|${r(frac[0])},${r(frac[1])},${r(frac[2])}`;
}

/** Tile a selection-index array `total` times with a per-image atom offset. */
function tileIndices(
  indices: Uint32Array | null,
  nAtomsBase: number,
  total: number,
): Uint32Array | null {
  if (indices === null) return null;
  const out = new Uint32Array(indices.length * total);
  for (let m = 0; m < total; m++) {
    const offset = m * nAtomsBase;
    const base = m * indices.length;
    for (let i = 0; i < indices.length; i++) {
      out[base + i] = indices[i] + offset;
    }
  }
  return out;
}

/** Tile a per-atom (or per-atom×channel) float override array `total` times. */
function tileFloat(arr: Float32Array | null, total: number): Float32Array | null {
  if (arr === null) return null;
  const out = new Float32Array(arr.length * total);
  for (let m = 0; m < total; m++) out.set(arr, m * arr.length);
  return out;
}

function tileUint8(arr: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(arr.length * total);
  for (let m = 0; m < total; m++) out.set(arr, m * arr.length);
  return out;
}

function tileUint32(arr: Uint32Array, total: number): Uint32Array {
  const out = new Uint32Array(arr.length * total);
  for (let m = 0; m < total; m++) out.set(arr, m * arr.length);
  return out;
}
