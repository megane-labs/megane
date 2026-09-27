/**
 * Geometry the Builder edits by number: which atoms move together (a
 * molecule, or the side of a bond), setting a distance / angle / dihedral to
 * a value, and the rigid fit that puts a re-embedded molecule back where it
 * was. Pure functions over rendered-atom indices; `BuilderStore` turns their
 * displacements into `move_atoms` ops.
 */

import type { Snapshot } from "../types";

type Vec3 = [number, number, number];

/** Neighbour lists from the snapshot's bonds. */
export function adjacency(snapshot: Snapshot): number[][] {
  const adj: number[][] = Array.from({ length: snapshot.nAtoms }, () => []);
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = snapshot.bonds[b * 2];
    const j = snapshot.bonds[b * 2 + 1];
    if (i < snapshot.nAtoms && j < snapshot.nAtoms) {
      adj[i].push(j);
      adj[j].push(i);
    }
  }
  return adj;
}

/** Every atom reachable from `start` through bonds, never entering `blocked`. */
export function reachable(adj: number[][], start: number, blocked?: number): number[] {
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (const j of adj[i]) {
      if (j === blocked || seen.has(j)) continue;
      seen.add(j);
      stack.push(j);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** The molecule (bonded component) atom `i` belongs to. */
export function moleculeOf(snapshot: Snapshot, i: number): number[] {
  return reachable(adjacency(snapshot), i);
}

/** Bonded components, each sorted, in order of their lowest atom. */
export function molecules(snapshot: Snapshot): number[][] {
  const adj = adjacency(snapshot);
  const done = new Uint8Array(snapshot.nAtoms);
  const out: number[][] = [];
  for (let i = 0; i < snapshot.nAtoms; i++) {
    if (done[i]) continue;
    const comp = reachable(adj, i);
    for (const k of comp) done[k] = 1;
    out.push(comp);
  }
  return out;
}

/**
 * The atoms that move with `moving` when the geometry around `fixed` changes:
 * everything on `moving`'s side of the `fixed`–`moving` link. When the two
 * sides are joined some other way (a ring), only `moving` itself moves.
 */
export function movingSide(snapshot: Snapshot, fixed: number, moving: number): number[] {
  const adj = adjacency(snapshot);
  const side = reachable(adj, moving, fixed);
  // Another way back to `fixed` than the direct link: the sides are one ring.
  const joined = side.some((i) => i !== moving && adj[i].includes(fixed));
  return joined ? [moving] : side;
}

function pos(p: ArrayLike<number>, i: number): Vec3 {
  return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));

/** Rotate `p` about the axis through `origin` along unit `axis` by `angle` (rad). */
function rotateAbout(p: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 {
  const v = sub(p, origin);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // Rodrigues: v cosθ + (k×v) sinθ + k (k·v)(1−cosθ)
  const r = add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
  return add(origin, r);
}

/** Displacement of each moved atom, keyed by rendered index. */
export type Displacements = Map<number, Vec3>;

/**
 * Move `b`'s side of the pair so that |a–b| = `target` Å, along the a→b
 * direction. Null when the two atoms coincide or the target is not positive.
 */
export function setDistance(
  snapshot: Snapshot,
  a: number,
  b: number,
  target: number,
): Displacements | null {
  if (!(target > 0)) return null;
  const pa = pos(snapshot.positions, a);
  const pb = pos(snapshot.positions, b);
  const d = sub(pb, pa);
  const len = norm(d);
  if (len < 1e-8) return null;
  const shift = scale(d, (target - len) / len);
  const out: Displacements = new Map();
  for (const i of movingSide(snapshot, a, b)) out.set(i, shift);
  return out;
}

/**
 * Rotate `c`'s side about `b` (in the a–b–c plane) so the angle a–b–c is
 * `target` degrees. Null for a degenerate (collinear) triple or an angle
 * outside (0°, 180°).
 */
export function setAngle(
  snapshot: Snapshot,
  a: number,
  b: number,
  c: number,
  target: number,
): Displacements | null {
  if (!(target > 0 && target < 180)) return null;
  const p = snapshot.positions;
  const pb = pos(p, b);
  const ba = sub(pos(p, a), pb);
  const bc = sub(pos(p, c), pb);
  const n = cross(ba, bc);
  const nLen = norm(n);
  if (nLen < 1e-8) return null;
  const axis = scale(n, 1 / nLen);
  const current = Math.atan2(nLen, dot(ba, bc));
  const delta = (target * Math.PI) / 180 - current;
  return rotateSide(snapshot, movingSide(snapshot, b, c), pb, axis, delta);
}

/**
 * Rotate the c side of the b–c bond about the b→c axis so the dihedral
 * a–b–c–d is `target` degrees. Null when b and c coincide.
 */
export function setDihedral(
  snapshot: Snapshot,
  a: number,
  b: number,
  c: number,
  d: number,
  target: number,
): Displacements | null {
  if (!Number.isFinite(target)) return null;
  const p = snapshot.positions;
  const pb = pos(p, b);
  const pc = pos(p, c);
  const bc = sub(pc, pb);
  const len = norm(bc);
  if (len < 1e-8) return null;
  const axis = scale(bc, 1 / len);
  const current = dihedral(pos(p, a), pb, pc, pos(p, d));
  // A right-handed turn about b→c lowers this dihedral, so turn by −Δ.
  const delta = ((current - target) * Math.PI) / 180;
  return rotateSide(snapshot, movingSide(snapshot, b, c), pc, axis, delta);
}

function dihedral(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const b1 = sub(b, a);
  const b2 = sub(c, b);
  const b3 = sub(d, c);
  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  const m1 = cross(n1, scale(b2, 1 / norm(b2)));
  return (Math.atan2(dot(m1, n2), dot(n1, n2)) * 180) / Math.PI;
}

function rotateSide(
  snapshot: Snapshot,
  side: number[],
  origin: Vec3,
  axis: Vec3,
  angle: number,
): Displacements {
  const out: Displacements = new Map();
  for (const i of side) {
    const from = pos(snapshot.positions, i);
    out.set(i, sub(rotateAbout(from, origin, axis, angle), from));
  }
  return out;
}

// ── Rigid fit (Kabsch, via Horn's quaternion method) ──

/** Eigenvector of the largest eigenvalue of a symmetric 4×4 (Jacobi rotations). */
function topEigenvector(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (a[k][k] > a[best][best]) best = k;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * The positions `moving` (flat xyz) take when rigidly rotated and translated
 * onto `reference` (same atom order) with the least squared deviation.
 */
export function superpose(moving: ArrayLike<number>, reference: ArrayLike<number>): Float64Array {
  const n = Math.floor(moving.length / 3);
  const cm: Vec3 = [0, 0, 0];
  const cr: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      cm[k] += moving[i * 3 + k] / n;
      cr[k] += reference[i * 3 + k] / n;
    }
  }
  // Cross-covariance S = Σ (m − cm)(r − cr)ᵀ.
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        S[a][b] += (moving[i * 3 + a] - cm[a]) * (reference[i * 3 + b] - cr[b]);
      }
    }
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [q0, q1, q2, q3] = topEigenvector(N);
  const R = [
    [q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3, 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)],
    [2 * (q1 * q2 + q0 * q3), q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, 2 * (q2 * q3 - q0 * q1)],
    [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3],
  ];
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = moving[i * 3] - cm[0];
    const y = moving[i * 3 + 1] - cm[1];
    const z = moving[i * 3 + 2] - cm[2];
    for (let k = 0; k < 3; k++) {
      out[i * 3 + k] = R[k][0] * x + R[k][1] * y + R[k][2] * z + cr[k];
    }
  }
  return out;
}
