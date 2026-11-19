/**
 * Sample sequences for the publication (studio) renderer.
 *
 * The studio renderer averages many cheap rasterized frames. Each frame takes
 * one sub-pixel camera offset (anti-aliasing), one direction on the sky dome
 * (ambient occlusion), and one direction inside the key light's cone (soft
 * shadows). Low-discrepancy sequences spread those evenly, so a few hundred
 * frames converge without visible banding.
 */

export type Vec3 = [number, number, number];

/** The `index`-th element (from 1) of the van der Corput / Halton sequence in `base`. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/**
 * `n` sub-pixel offsets in pixels, each in [-0.5, 0.5), from the Halton (2, 3)
 * sequence. The first is the pixel centre, so a one-sample render is unjittered.
 */
export function pixelJitter(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      out.push([0, 0]);
      continue;
    }
    out.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  }
  return out;
}

/** A small seeded PRNG (mulberry32) so renders are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` unit vectors spread evenly over the whole sphere (Fibonacci lattice),
 * in an order shuffled by `rand` so that any prefix of the list — what a
 * progressive render has accumulated so far — still covers the sphere.
 */
export function sphereDirections(n: number, rand: () => number = Math.random): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spin = rand() * 2 * Math.PI;
  const dirs: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden + spin;
    dirs.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  return dirs;
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len === 0) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * A direction inside the cone of half-angle `halfAngle` (radians) around
 * `axis`, uniform over the cone's spherical cap for `u`, `v` uniform in [0, 1).
 * This is how an area light of that angular size is sampled: averaging hard
 * shadows cast from directions across the cap gives its soft penumbra.
 */
export function coneDirection(axis: Vec3, halfAngle: number, u: number, v: number): Vec3 {
  const a = normalize(axis);
  if (halfAngle <= 0) return a;
  const cosMax = Math.cos(halfAngle);
  const cosT = 1 - u * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = 2 * Math.PI * v;
  const ref: Vec3 = Math.abs(a[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const t = normalize(cross(ref, a));
  const b = cross(a, t);
  const x = Math.cos(phi) * sinT;
  const y = Math.sin(phi) * sinT;
  return normalize([
    t[0] * x + b[0] * y + a[0] * cosT,
    t[1] * x + b[1] * y + a[1] * cosT,
    t[2] * x + b[2] * y + a[2] * cosT,
  ]);
}
