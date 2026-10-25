import type { PeriodicImageMap } from "../pipeline/types";

/**
 * Atom positions followed by periodic copies of some of those atoms: copy `i`
 * is atom `images.sourceIndices[i]` translated by the integer lattice shift
 * `images.latticeShifts[3i..3i+2]` (a, b, c) of the row-major cell `box`.
 *
 * The add_bond executor builds the ghost endpoints of half-bonds that cross the
 * cell with this, and the renderer calls it again for each trajectory frame so
 * those endpoints move with their atoms instead of staying where frame 0 put
 * them. `out` is reused when it already has the right length.
 */
export function positionsWithPeriodicImages(
  positions: Float32Array,
  nAtoms: number,
  images: PeriodicImageMap,
  box: ArrayLike<number>,
  out?: Float32Array | null,
): Float32Array {
  const nImages = images.sourceIndices.length;
  const length = (nAtoms + nImages) * 3;
  const result = out && out.length === length ? out : new Float32Array(length);
  result.set(positions.subarray(0, nAtoms * 3));
  for (let i = 0; i < nImages; i++) {
    const source = images.sourceIndices[i] * 3;
    const a = images.latticeShifts[i * 3];
    const b = images.latticeShifts[i * 3 + 1];
    const c = images.latticeShifts[i * 3 + 2];
    const o = (nAtoms + i) * 3;
    result[o] = positions[source] + a * box[0] + b * box[3] + c * box[6];
    result[o + 1] = positions[source + 1] + a * box[1] + b * box[4] + c * box[7];
    result[o + 2] = positions[source + 2] + a * box[2] + b * box[5] + c * box[8];
  }
  return result;
}
