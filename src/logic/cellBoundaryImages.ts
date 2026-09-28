import type { Snapshot } from "../types";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { invert3x3 } from "../pipeline/executors/mathUtils";

/**
 * Display-only periodic images needed to draw an inclusive crystallographic
 * cell boundary.  `sourceIndices[i]` identifies the real atom whose visual
 * properties the i-th image must mirror.
 */
export interface CellBoundaryImages {
  positions: Float32Array;
  elements: Uint8Array;
  sourceIndices: Uint32Array;
  /** Integer lattice shift (a,b,c) for each image, length = nImages * 3. */
  latticeShifts: Int32Array;
}

const FRACTIONAL_TOLERANCE = 1e-5;
const POSITION_KEY_TOLERANCE = 1e-4;

function positionKey(element: number, x: number, y: number, z: number): string {
  const q = (value: number) => Math.round(value / POSITION_KEY_TOLERANCE);
  return `${element}:${q(x)}:${q(y)}:${q(z)}`;
}

/**
 * Generate periodic copies inside inclusive fractional-coordinate drawing
 * ranges. The default range is 0 <= x,y,z <= 1.
 *
 * A site on one face gains one copy, a site on an edge gains three copies,
 * and a site on a corner gains seven copies.  Existing atoms at the target
 * position are respected so files that already contain both sides of a cell
 * are not double-rendered.
 */
export function generateDrawingBoundaryImages(
  snapshot: Snapshot,
  min: [number, number, number] = [0, 0, 0],
  max: [number, number, number] = [1, 1, 1],
): DrawingBoundaryData {
  const lower: [number, number, number] = [
    Math.min(min[0], max[0]),
    Math.min(min[1], max[1]),
    Math.min(min[2], max[2]),
  ];
  const upper: [number, number, number] = [
    Math.max(min[0], max[0]),
    Math.max(min[1], max[1]),
    Math.max(min[2], max[2]),
  ];
  const sourceVisibleMask = new Uint8Array(snapshot.nAtoms);
  const { box } = snapshot;
  if (!box || box.length < 9 || box.every((value) => value === 0)) {
    return {
      min: lower,
      max: upper,
      sourceVisibleMask,
      images: {
        positions: new Float32Array(),
        elements: new Uint8Array(),
        sourceIndices: new Uint32Array(),
        latticeShifts: new Int32Array(),
      },
    };
  }

  const inverse = invert3x3(box);
  if (!inverse) {
    return {
      min: lower,
      max: upper,
      sourceVisibleMask,
      images: {
        positions: new Float32Array(),
        elements: new Uint8Array(),
        sourceIndices: new Uint32Array(),
        latticeShifts: new Int32Array(),
      },
    };
  }

  const origin = snapshot.boxOrigin ?? new Float32Array(3);
  const fractional = new Float64Array(snapshot.nAtoms * 3);
  const occupied = new Set<string>();
  for (let atom = 0; atom < snapshot.nAtoms; atom++) {
    const i3 = atom * 3;
    const dx = snapshot.positions[i3] - origin[0];
    const dy = snapshot.positions[i3 + 1] - origin[1];
    const dz = snapshot.positions[i3 + 2] - origin[2];
    fractional[i3] = inverse[0] * dx + inverse[3] * dy + inverse[6] * dz;
    fractional[i3 + 1] = inverse[1] * dx + inverse[4] * dy + inverse[7] * dz;
    fractional[i3 + 2] = inverse[2] * dx + inverse[5] * dy + inverse[8] * dz;
    const sourceVisible =
      fractional[i3] >= lower[0] - FRACTIONAL_TOLERANCE &&
      fractional[i3] <= upper[0] + FRACTIONAL_TOLERANCE &&
      fractional[i3 + 1] >= lower[1] - FRACTIONAL_TOLERANCE &&
      fractional[i3 + 1] <= upper[1] + FRACTIONAL_TOLERANCE &&
      fractional[i3 + 2] >= lower[2] - FRACTIONAL_TOLERANCE &&
      fractional[i3 + 2] <= upper[2] + FRACTIONAL_TOLERANCE;
    if (sourceVisible) {
      sourceVisibleMask[atom] = 1;
      occupied.add(
        positionKey(
          snapshot.elements[atom],
          snapshot.positions[i3],
          snapshot.positions[i3 + 1],
          snapshot.positions[i3 + 2],
        ),
      );
    }
  }

  const positions: number[] = [];
  const elements: number[] = [];
  const sourceIndices: number[] = [];
  const latticeShifts: number[] = [];

  for (let atom = 0; atom < snapshot.nAtoms; atom++) {
    const i3 = atom * 3;
    const x = snapshot.positions[i3];
    const y = snapshot.positions[i3 + 1];
    const z = snapshot.positions[i3 + 2];
    const axisShifts: number[][] = [0, 1, 2].map((axis) => {
      const value = fractional[i3 + axis];
      const first = Math.ceil(lower[axis] - value - FRACTIONAL_TOLERANCE);
      const last = Math.floor(upper[axis] - value + FRACTIONAL_TOLERANCE);
      const shifts: number[] = [];
      for (let shift = first; shift <= last; shift++) shifts.push(shift);
      return shifts;
    });

    for (const sa of axisShifts[0]) {
      for (const sb of axisShifts[1]) {
        for (const sc of axisShifts[2]) {
          if (sa === 0 && sb === 0 && sc === 0) continue;
          const px = x + sa * box[0] + sb * box[3] + sc * box[6];
          const py = y + sa * box[1] + sb * box[4] + sc * box[7];
          const pz = z + sa * box[2] + sb * box[5] + sc * box[8];
          const key = positionKey(snapshot.elements[atom], px, py, pz);
          if (occupied.has(key)) continue;
          occupied.add(key);
          positions.push(px, py, pz);
          elements.push(snapshot.elements[atom]);
          sourceIndices.push(atom);
          latticeShifts.push(sa, sb, sc);
        }
      }
    }
  }

  const images: PeriodicAtomImageData = {
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    sourceIndices: new Uint32Array(sourceIndices),
    latticeShifts: new Int32Array(latticeShifts),
  };
  return {
    min: lower,
    max: upper,
    sourceVisibleMask,
    images,
  };
}

/** Backward-compatible helper for the conventional inclusive unit cell. */
export function generateCellBoundaryImages(snapshot: Snapshot): CellBoundaryImages {
  return generateDrawingBoundaryImages(snapshot).images;
}
