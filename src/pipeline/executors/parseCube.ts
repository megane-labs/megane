/**
 * Gaussian CUBE file parser.
 *
 * Format reference: https://gaussian.com/cubegen/
 * Units in the file are Bohr; converted to Angstroms on output.
 *
 * Data ordering: outer loop = ix (0…nx-1), middle = iy, inner = iz.
 * Flat index: ix*ny*nz + iy*nz + iz.
 */

import type { VolumetricData } from "../types";

/** 1 Bohr in Angstroms (CODATA 2018). */
export const BOHR_TO_ANGSTROM = 0.529177210903;

/** Result of parsing a CUBE file. */
export interface CubeParseResult extends VolumetricData {
  /** Number of atoms embedded in the CUBE file. */
  nAtoms: number;
  /** Atom positions in Angstroms, length 3*nAtoms. */
  positions: Float32Array;
  /** Atomic numbers, length nAtoms. */
  elements: Uint8Array;
}

/**
 * Parse a Gaussian CUBE file text and return volumetric + atom data.
 * Throws a descriptive string on parse failure.
 */
export function parseCube(text: string): CubeParseResult {
  const lines = text.split("\n");
  let li = 0;

  const next = (): string => {
    while (li < lines.length) {
      const l = lines[li++].trim();
      if (l !== "") return l;
    }
    throw new Error(`Unexpected end of CUBE file at line ${li}`);
  };

  // Two comment lines (ignored).
  next();
  next();

  // Line 3: natoms ox oy oz
  let parts = next().split(/\s+/);
  if (parts.length < 4) throw new Error("CUBE: missing atom count / origin line");
  const nAtomsSigned = parseInt(parts[0], 10);
  if (isNaN(nAtomsSigned)) throw new Error("CUBE: invalid atom count");
  // A negative atom count is the format's flag that a DSET_IDS record follows
  // the atom block (cubegen MO cubes) — the count itself is |NAtoms|.
  const hasDsetIds = nAtomsSigned < 0;
  const nAtoms = Math.abs(nAtomsSigned);
  const ox = parseFloat(parts[1]) * BOHR_TO_ANGSTROM;
  const oy = parseFloat(parts[2]) * BOHR_TO_ANGSTROM;
  const oz = parseFloat(parts[3]) * BOHR_TO_ANGSTROM;
  const origin = new Float32Array([ox, oy, oz]);

  // Lines 4–6: grid dimensions + step vectors (one per axis).
  const step = new Float32Array(9);
  const dims: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    parts = next().split(/\s+/);
    if (parts.length < 4) throw new Error(`CUBE: malformed grid axis line ${axis}`);
    const n = parseInt(parts[0], 10);
    if (isNaN(n) || n <= 0)
      throw new Error(`CUBE: invalid voxel count ${parts[0]} for axis ${axis}`);
    dims[axis] = n;
    step[axis * 3 + 0] = parseFloat(parts[1]) * BOHR_TO_ANGSTROM;
    step[axis * 3 + 1] = parseFloat(parts[2]) * BOHR_TO_ANGSTROM;
    step[axis * 3 + 2] = parseFloat(parts[3]) * BOHR_TO_ANGSTROM;
  }
  const [nx, ny, nz] = dims;

  // Atom lines.
  const positions = new Float32Array(nAtoms * 3);
  const elements = new Uint8Array(nAtoms);
  for (let a = 0; a < nAtoms; a++) {
    parts = next().split(/\s+/);
    if (parts.length < 5) throw new Error(`CUBE: malformed atom line ${a}`);
    // A negative atomic number marks a ghost/dummy site — keep the atom but
    // as element 0 (unknown) rather than pretending it is a real element.
    const z = parseInt(parts[0], 10);
    elements[a] = z < 0 ? 0 : z;
    // parts[1] is the charge (ignored)
    positions[a * 3 + 0] = parseFloat(parts[2]) * BOHR_TO_ANGSTROM;
    positions[a * 3 + 1] = parseFloat(parts[3]) * BOHR_TO_ANGSTROM;
    positions[a * 3 + 2] = parseFloat(parts[4]) * BOHR_TO_ANGSTROM;
  }

  // DSET_IDS record (present iff NAtoms was negative): `m id1 … idm`, wrapping
  // across lines. With m > 1 every grid point carries m values (innermost
  // index over the data sets); we surface the first set.
  let nSets = 1;
  if (hasDsetIds) {
    parts = next().split(/\s+/);
    nSets = parseInt(parts[0], 10);
    if (isNaN(nSets) || nSets <= 0) throw new Error("CUBE: invalid DSET_IDS count");
    let idsRead = parts.length - 1;
    while (idsRead < nSets) {
      idsRead += next().split(/\s+/).length;
    }
  }

  // Volumetric data: nx*ny*nz grid points (× nSets values each), 6 per line.
  const totalVoxels = nx * ny * nz;
  const totalValues = totalVoxels * nSets;
  const data = new Float32Array(totalVoxels);
  let valueIdx = 0;
  let dataMin = Infinity;
  let dataMax = -Infinity;

  while (valueIdx < totalValues && li < lines.length) {
    const line = lines[li++].trim();
    if (line === "") continue;
    const tokens = line.split(/\s+/);
    for (const tok of tokens) {
      if (valueIdx >= totalValues) break;
      const v = parseFloat(tok);
      if (valueIdx % nSets === 0) {
        const gridIdx = valueIdx / nSets;
        data[gridIdx] = v;
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
      valueIdx++;
    }
  }

  if (valueIdx < totalValues) {
    throw new Error(`CUBE: expected ${totalValues} data values, got ${valueIdx}`);
  }

  if (!isFinite(dataMin)) {
    dataMin = 0;
    dataMax = 0;
  }

  return {
    type: "volumetric",
    nx,
    ny,
    nz,
    origin,
    step,
    data,
    dataMin,
    dataMax,
    nAtoms,
    positions,
    elements,
  };
}
