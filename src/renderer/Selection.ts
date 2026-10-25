/**
 * Geometric measurement computations for atom selections.
 * Pure math functions — no Three.js dependency.
 */

import type { Measurement } from "../types";

/** Compute Euclidean distance between two atoms. */
export function computeDistance(pos: Float32Array, a: number, b: number): number {
  const dx = pos[b * 3] - pos[a * 3];
  const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
  const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Compute angle (in degrees) at atom b, formed by atoms a-b-c. */
export function computeAngle(pos: Float32Array, a: number, b: number, c: number): number {
  const bax = pos[a * 3] - pos[b * 3];
  const bay = pos[a * 3 + 1] - pos[b * 3 + 1];
  const baz = pos[a * 3 + 2] - pos[b * 3 + 2];
  const bcx = pos[c * 3] - pos[b * 3];
  const bcy = pos[c * 3 + 1] - pos[b * 3 + 1];
  const bcz = pos[c * 3 + 2] - pos[b * 3 + 2];
  const dot = bax * bcx + bay * bcy + baz * bcz;
  const magBA = Math.sqrt(bax * bax + bay * bay + baz * baz);
  const magBC = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
  return Math.acos(Math.max(-1, Math.min(1, dot / (magBA * magBC)))) * (180 / Math.PI);
}

/**
 * Compute the signed dihedral angle (in degrees, −180…180) for atoms a-b-c-d.
 *
 * IUPAC convention: looking along b→c, the angle is positive when a must turn
 * clockwise to eclipse d (the sign MDAnalysis and MDTraj report):
 * φ = atan2(|b2| b1·(b2×b3), (b1×b2)·(b2×b3)).
 */
export function computeDihedral(
  pos: Float32Array,
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  const b1x = pos[b * 3] - pos[a * 3],
    b1y = pos[b * 3 + 1] - pos[a * 3 + 1],
    b1z = pos[b * 3 + 2] - pos[a * 3 + 2];
  const b2x = pos[c * 3] - pos[b * 3],
    b2y = pos[c * 3 + 1] - pos[b * 3 + 1],
    b2z = pos[c * 3 + 2] - pos[b * 3 + 2];
  const b3x = pos[d * 3] - pos[c * 3],
    b3y = pos[d * 3 + 1] - pos[c * 3 + 1],
    b3z = pos[d * 3 + 2] - pos[c * 3 + 2];
  const n1x = b1y * b2z - b1z * b2y,
    n1y = b1z * b2x - b1x * b2z,
    n1z = b1x * b2y - b1y * b2x;
  const n2x = b2y * b3z - b2z * b3y,
    n2y = b2z * b3x - b2x * b3z,
    n2z = b2x * b3y - b2y * b3x;
  const b2len = Math.sqrt(b2x * b2x + b2y * b2y + b2z * b2z);
  const x = n1x * n2x + n1y * n2y + n1z * n2z;
  const y = b2len * (b1x * n2x + b1y * n2y + b1z * n2z);
  return Math.atan2(y, x) * (180 / Math.PI);
}

/** Compute the geometric measurement for a set of selected atoms. */
export function computeMeasurement(pos: Float32Array, atoms: number[]): Measurement | null {
  if (atoms.length < 2) return null;

  if (atoms.length === 2) {
    const d = computeDistance(pos, atoms[0], atoms[1]);
    return { atoms: [...atoms], type: "distance", value: d, label: `${d.toFixed(3)} \u00c5` };
  }
  if (atoms.length === 3) {
    const a = computeAngle(pos, atoms[0], atoms[1], atoms[2]);
    return { atoms: [...atoms], type: "angle", value: a, label: `${a.toFixed(1)}\u00b0` };
  }
  if (atoms.length === 4) {
    const d = computeDihedral(pos, atoms[0], atoms[1], atoms[2], atoms[3]);
    return { atoms: [...atoms], type: "dihedral", value: d, label: `${d.toFixed(1)}\u00b0` };
  }
  return null;
}
