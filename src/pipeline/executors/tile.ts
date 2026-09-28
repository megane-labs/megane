/**
 * Repeat per-atom arrays once per image, as the Replicate and Symmetry nodes
 * do when they copy a structure: an index array is shifted by each image's
 * atom offset, every other array is copied as is.
 */

/** Tile an atom-index array `total` times, shifting copy m by m·nAtoms. */
export function tileIndices(indices: Uint32Array, nAtoms: number, total: number): Uint32Array {
  const out = new Uint32Array(indices.length * total);
  for (let m = 0; m < total; m++) {
    const offset = m * nAtoms;
    const base = m * indices.length;
    for (let i = 0; i < indices.length; i++) {
      out[base + i] = indices[i] + offset;
    }
  }
  return out;
}

type TileableArray = Float32Array | Uint8Array | Uint32Array;

/** Concatenate `total` copies of `arr` into a new array of the same type. */
export function tileArray<T extends TileableArray>(arr: T, total: number): T {
  const out = new (arr.constructor as new (length: number) => T)(arr.length * total);
  for (let m = 0; m < total; m++) out.set(arr, m * arr.length);
  return out;
}
