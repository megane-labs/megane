/**
 * Invert a 3x3 row-major matrix. Returns null if singular.
 */
export function invert3x3(m: Float32Array): Float32Array | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-20) return null;
  const invDet = 1 / det;
  return new Float32Array([
    (e * i - f * h) * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    (f * g - d * i) * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    (d * h - e * g) * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ]);
}

/**
 * A cell the renderer draws: nine numbers, not all zero. Trajectory formats
 * write an all-zero box for "no cell in this frame"; the renderer keeps the
 * structure's cell on screen then, so nodes that map coordinates through a
 * frame's cell (wrap, replicate) fall back to the structure's as well.
 */
export function isDrawableCell(box: Float32Array | null | undefined): box is Float32Array {
  if (!box || box.length !== 9) return false;
  for (let i = 0; i < 9; i++) if (box[i] !== 0) return true;
  return false;
}
