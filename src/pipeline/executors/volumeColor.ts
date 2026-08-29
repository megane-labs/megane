/**
 * Volume-mapped coloring for isosurface meshes.
 *
 * Samples a (possibly different) volumetric field at arbitrary world-space
 * points via trilinear interpolation on the — possibly non-orthogonal — CUBE
 * step lattice, then maps the sampled values through a colormap. This is what
 * lets an electron-density isosurface be painted by an electrostatic
 * potential (ESP) volume, the standard "ESP-mapped density" rendering.
 */

import type { VolumetricData } from "../types";
import type { VolumeColormap } from "../types";

export const VOLUME_COLORMAP_LABELS: Record<VolumeColormap, string> = {
  rwb: "Red-White-Blue",
  bwr: "Blue-White-Red",
  rainbow: "Rainbow",
};

/** Diverging maps get a symmetric-around-zero auto range. */
export function isDivergingColormap(colormap: VolumeColormap): boolean {
  return colormap === "rwb" || colormap === "bwr";
}

/**
 * Invert a row-major 3×3 matrix. Returns null when the matrix is singular
 * (degenerate step vectors), in which case sampling is impossible.
 */
export function invert3x3(m: Float32Array | number[]): Float64Array | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = new Float64Array(9);
  inv[0] = A / det;
  inv[1] = (c * h - b * i) / det;
  inv[2] = (b * f - c * e) / det;
  inv[3] = B / det;
  inv[4] = (a * i - c * g) / det;
  inv[5] = (c * d - a * f) / det;
  inv[6] = C / det;
  inv[7] = (b * g - a * h) / det;
  inv[8] = (a * e - b * d) / det;
  return inv;
}

/**
 * A reusable sampler for one volumetric field. Precomputes the world→grid
 * transform once, then answers point queries with trilinear interpolation
 * (clamped to the grid bounds, so points just outside the box take the value
 * of the nearest face).
 */
export interface VolumeSampler {
  (x: number, y: number, z: number): number;
}

/**
 * Build a trilinear sampler for `vol`, or null when the step matrix is
 * singular / the grid has no extent.
 */
export function createVolumeSampler(vol: VolumetricData): VolumeSampler | null {
  const { nx, ny, nz, origin, step, data } = vol;
  if (nx < 1 || ny < 1 || nz < 1 || data.length < nx * ny * nz) return null;

  // World position p of grid point (ix,iy,iz) is
  //   p = origin + ix*stepX + iy*stepY + iz*stepZ
  // with stepX = step[0..2] etc. (row-major rows). So grid coords are
  //   [ix,iy,iz] = (p - origin) · inv(S)  where S rows are the step vectors.
  const inv = invert3x3(step);
  if (!inv) return null;

  const nynz = ny * nz;

  return (x: number, y: number, z: number): number => {
    const px = x - origin[0];
    const py = y - origin[1];
    const pz = z - origin[2];
    // Row-vector times inverse matrix: g = p · S⁻¹.
    let gx = px * inv[0] + py * inv[3] + pz * inv[6];
    let gy = px * inv[1] + py * inv[4] + pz * inv[7];
    let gz = px * inv[2] + py * inv[5] + pz * inv[8];

    // Clamp into the valid interpolation range.
    gx = Math.max(0, Math.min(nx - 1, gx));
    gy = Math.max(0, Math.min(ny - 1, gy));
    gz = Math.max(0, Math.min(nz - 1, gz));

    const ix = Math.min(Math.floor(gx), Math.max(nx - 2, 0));
    const iy = Math.min(Math.floor(gy), Math.max(ny - 2, 0));
    const iz = Math.min(Math.floor(gz), Math.max(nz - 2, 0));
    const fx = gx - ix;
    const fy = gy - iy;
    const fz = gz - iz;

    const ix1 = Math.min(ix + 1, nx - 1);
    const iy1 = Math.min(iy + 1, ny - 1);
    const iz1 = Math.min(iz + 1, nz - 1);

    const v000 = data[ix * nynz + iy * nz + iz];
    const v100 = data[ix1 * nynz + iy * nz + iz];
    const v010 = data[ix * nynz + iy1 * nz + iz];
    const v110 = data[ix1 * nynz + iy1 * nz + iz];
    const v001 = data[ix * nynz + iy * nz + iz1];
    const v101 = data[ix1 * nynz + iy * nz + iz1];
    const v011 = data[ix * nynz + iy1 * nz + iz1];
    const v111 = data[ix1 * nynz + iy1 * nz + iz1];

    const v00 = v000 + fx * (v100 - v000);
    const v10 = v010 + fx * (v110 - v010);
    const v01 = v001 + fx * (v101 - v001);
    const v11 = v011 + fx * (v111 - v011);
    const v0 = v00 + fy * (v10 - v00);
    const v1 = v01 + fy * (v11 - v01);
    return v0 + fz * (v1 - v0);
  };
}

// ─── Colormaps ────────────────────────────────────────────────────────────────

/** 5-stop rainbow, identical to the B-factor scale in src/colorSchemes.ts. */
const RAINBOW_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0.07, 0.11, 0.58], // blue
  [0.07, 0.65, 0.85], // cyan
  [0.22, 0.8, 0.33], // green
  [0.97, 0.9, 0.12], // yellow
  [0.85, 0.1, 0.1], // red
];

/** Diverging red→white→blue (chemistry ESP convention). */
const RWB_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0.84, 0.1, 0.11], // red (negative)
  [1.0, 1.0, 1.0], // white (zero)
  [0.13, 0.31, 0.77], // blue (positive)
];

const COLORMAP_STOPS: Record<VolumeColormap, ReadonlyArray<readonly [number, number, number]>> = {
  rwb: RWB_STOPS,
  bwr: [...RWB_STOPS].reverse(),
  rainbow: RAINBOW_STOPS,
};

/** Map a normalized position t ∈ [0,1] (clamped) to [r,g,b] in 0-1. */
export function colormapColor(t: number, colormap: VolumeColormap): [number, number, number] {
  const stops = COLORMAP_STOPS[colormap];
  const tt = isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.5;
  const n = stops.length - 1;
  const seg = tt * n;
  const i = Math.min(Math.floor(seg), n - 1);
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

/**
 * Compute the colormap range for a set of sampled values.
 * Diverging maps get a symmetric range [-m, m] with m = max(|v|) so the
 * midpoint color always sits at value 0; sequential maps span [min, max].
 * Degenerate inputs (empty, all-equal, non-finite) fall back to [-1, 1] /
 * [0, 1] so callers never divide by zero.
 */
export function computeAutoRange(
  values: ArrayLike<number>,
  colormap: VolumeColormap,
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return isDivergingColormap(colormap) ? [-1, 1] : [0, 1];
  if (isDivergingColormap(colormap)) {
    const m = Math.max(Math.abs(min), Math.abs(max));
    return m < 1e-12 ? [-1, 1] : [-m, m];
  }
  return min === max ? [min, min + 1] : [min, max];
}

/**
 * Fill per-vertex RGBA colors by sampling `colorVol` at each vertex position
 * and mapping through `colormap`. Vertices are `positions[3k..3k+2]`; colors
 * are written to `colors[4k..4k+3]` with `opacity` in the alpha channel.
 *
 * Returns the [min, max] range actually used (the explicit `range` when given,
 * the auto-computed one otherwise), or null when the color volume cannot be
 * sampled — in which case `colors` is left untouched so the caller can fall
 * back to solid coloring.
 */
export function colorVerticesByVolume(
  positions: Float32Array,
  colors: Float32Array,
  opacity: number,
  colorVol: VolumetricData,
  colormap: VolumeColormap,
  range?: [number, number],
): [number, number] | null {
  const sampler = createVolumeSampler(colorVol);
  if (!sampler) return null;

  const nVerts = positions.length / 3;
  const values = new Float32Array(nVerts);
  for (let i = 0; i < nVerts; i++) {
    values[i] = sampler(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  }

  let lo: number;
  let hi: number;
  if (range && isFinite(range[0]) && isFinite(range[1]) && range[1] > range[0]) {
    [lo, hi] = range;
  } else {
    [lo, hi] = computeAutoRange(values, colormap);
  }
  const span = hi - lo;

  for (let i = 0; i < nVerts; i++) {
    const t = span > 0 ? (values[i] - lo) / span : 0.5;
    const [r, g, b] = colormapColor(t, colormap);
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = opacity;
  }
  return [lo, hi];
}
