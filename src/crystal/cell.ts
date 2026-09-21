/**
 * Unit-cell arithmetic shared by the Builder's crystal tools and the edit
 * engine: cell parameters ⇄ lattice vectors, fractional ⇄ Cartesian
 * coordinates, and the small integer helpers the surface builder needs.
 *
 * Conventions match the rest of megane: a cell is a row-major 3×3
 * `[ax,ay,az, bx,by,bz, cx,cy,cz]` whose rows are the lattice vectors, and
 * Cartesian = fractional · cell (row-vector convention), exactly as
 * `src/pipeline/executors/symmetry.ts` and `replicate.ts` read it.
 */

export type Vec3 = [number, number, number];
/** Row-major 3×3 matrix. */
export type Mat3 = number[];

/** Cell lengths (Å) and angles (degrees). */
export interface CellParams {
  a: number;
  b: number;
  c: number;
  alpha: number;
  beta: number;
  gamma: number;
}

const DEG = Math.PI / 180;

export function dot(u: ArrayLike<number>, v: ArrayLike<number>): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

export function cross(u: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

export function norm(u: ArrayLike<number>): number {
  return Math.sqrt(dot(u, u));
}

/** Row `i` (0..2) of a row-major 3×3 as a vector. */
export function row(m: ArrayLike<number>, i: number): Vec3 {
  return [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
}

export function det3(m: ArrayLike<number>): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Inverse of a row-major 3×3, or null when singular. */
export function inverse3(m: ArrayLike<number>): Mat3 | null {
  const d = det3(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const [a, b, c, d1, e, f, g, h, i] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
  const inv = 1 / d;
  return [
    (e * i - f * h) * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    (f * g - d1 * i) * inv,
    (a * i - c * g) * inv,
    (c * d1 - a * f) * inv,
    (d1 * h - e * g) * inv,
    (b * g - a * h) * inv,
    (a * e - b * d1) * inv,
  ];
}

/** Row-major product `a · b` of two 3×3 matrices. */
export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return out;
}

/** Row vector `v · m`. */
export function mulVec(v: ArrayLike<number>, m: ArrayLike<number>): Vec3 {
  return [
    v[0] * m[0] + v[1] * m[3] + v[2] * m[6],
    v[0] * m[1] + v[1] * m[4] + v[2] * m[7],
    v[0] * m[2] + v[1] * m[5] + v[2] * m[8],
  ];
}

/**
 * Lattice vectors for cell parameters, in the standard orientation (a along
 * x, b in the xy plane) — the same construction as ASE's `cellpar_to_cell`.
 */
export function cellParamsToBox(p: CellParams): Mat3 {
  const { a, b, c } = p;
  const alpha = p.alpha * DEG;
  const beta = p.beta * DEG;
  const gamma = p.gamma * DEG;
  // Exact right angles: avoid 6e-17 noise in the off-diagonal entries.
  const cosA = p.alpha === 90 ? 0 : Math.cos(alpha);
  const cosB = p.beta === 90 ? 0 : Math.cos(beta);
  const cosG = p.gamma === 90 ? 0 : Math.cos(gamma);
  const sinG = p.gamma === 90 ? 1 : Math.sin(gamma);
  const cy = (cosA - cosB * cosG) / sinG;
  const cz = Math.sqrt(Math.max(0, 1 - cosB * cosB - cy * cy));
  return [a, 0, 0, b * cosG, b * sinG, 0, c * cosB, c * cy, c * cz];
}

/** Lengths and angles of a cell (degrees). */
export function boxToCellParams(box: ArrayLike<number>): CellParams {
  const va = row(box, 0);
  const vb = row(box, 1);
  const vc = row(box, 2);
  const a = norm(va);
  const b = norm(vb);
  const c = norm(vc);
  const angle = (u: Vec3, v: Vec3, lu: number, lv: number) =>
    lu === 0 || lv === 0 ? 90 : Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)))) / DEG;
  return {
    a,
    b,
    c,
    alpha: angle(vb, vc, b, c),
    beta: angle(va, vc, a, c),
    gamma: angle(va, vb, a, b),
  };
}

/** Fractional coordinates of flat Cartesian `positions` in `box` (needs `boxInv`). */
export function cartToFrac(positions: ArrayLike<number>, boxInv: ArrayLike<number>): Float64Array {
  const n = Math.floor(positions.length / 3);
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = mulVec([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]], boxInv);
    out[i * 3] = f[0];
    out[i * 3 + 1] = f[1];
    out[i * 3 + 2] = f[2];
  }
  return out;
}

/** Cartesian coordinates of flat fractional `frac` in `box`. */
export function fracToCart(frac: ArrayLike<number>, box: ArrayLike<number>): Float64Array {
  const n = Math.floor(frac.length / 3);
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = mulVec([frac[i * 3], frac[i * 3 + 1], frac[i * 3 + 2]], box);
    out[i * 3] = p[0];
    out[i * 3 + 1] = p[1];
    out[i * 3 + 2] = p[2];
  }
  return out;
}

/** `v − floor(v + tol)`: the fractional part in `[0, 1)`, tolerant at the top face. */
export function wrapFrac(v: number, tol = 1e-8): number {
  return v - Math.floor(v + tol);
}

/** Greatest common divisor of two integers (non-negative result). */
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * Extended Euclid as ASE's `ext_gcd` writes it: returns `[x, y]` with
 * `x·a + y·b = gcd(a, b)`, using Python's floor semantics for `%` and `//`
 * so the surface cells come out identical to ASE's.
 */
export function extGcd(a: number, b: number): [number, number] {
  if (b === 0) return [1, 0];
  if (pyMod(a, b) === 0) return [0, 1];
  const [x, y] = extGcd(b, pyMod(a, b));
  return [y, x - y * pyFloorDiv(a, b)];
}

/** Python-style modulo (result has the sign of the divisor). */
export function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Python-style floor division. */
export function pyFloorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}
