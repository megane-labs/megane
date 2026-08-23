/**
 * Pure JavaScript VDW bond inference.
 * A deliberate port of the Rust implementation in
 * crates/megane-core/src/bonds.rs that runs entirely in JS — executors are
 * synchronous, so they cannot depend on the async-initialised WASM module.
 * The two implementations MUST stay in sync: any cutoff/tolerance or
 * algorithm change lands in both files in the same commit (bonds.rs carries
 * the matching note).
 *
 * Uses a cell-list spatial data structure for O(N) performance.
 * Supports periodic boundary conditions (PBC) via minimum-image convention.
 *
 * Hot-path notes:
 * - CSR cell list (two Uint32Arrays) instead of `number[][]` — no per-cell heap allocation.
 * - Per-atom VDW radius precomputed into a Float32Array — no Record lookups in the inner loop.
 * - Pair-check body inlined; PBC / non-PBC paths specialized into separate loops.
 * - Bond pairs written to a growable Uint32Array — no intermediate `number[]` + `push`.
 */

import { VDW_RADII, DEFAULT_RADIUS } from "../constants";
import { invert3x3 } from "../pipeline/executors/mathUtils";

export const DEFAULT_VDW_BOND_FACTOR = 0.6;
const MIN_BOND_DIST = 0.4;
const CELL_SIZE = 2.0;

// 13 half-shell neighbor offsets (flattened to avoid per-iteration array destructure).
// prettier-ignore
const OFFSETS = new Int8Array([
  0, 0, 1,
  0, 1, -1,
  0, 1, 0,
  0, 1, 1,
  1, -1, -1,
  1, -1, 0,
  1, -1, 1,
  1, 0, -1,
  1, 0, 0,
  1, 0, 1,
  1, 1, -1,
  1, 1, 0,
  1, 1, 1,
]);
const N_OFFSETS = 13;

/**
 * Infer bonds based on van der Waals radii.
 * Two atoms are bonded if:
 *   MIN_BOND_DIST < distance <= (vdw_i + vdw_j) * VDW_BOND_FACTOR
 *
 * When a periodic box is provided, uses minimum-image convention
 * so bonds across cell boundaries are correctly detected.
 */
export function inferBondsVdwJS(
  positions: Float32Array,
  elements: Uint8Array,
  nAtoms: number,
  vdwScale: number = DEFAULT_VDW_BOND_FACTOR,
  box: Float32Array | null = null,
): Uint32Array {
  if (nAtoms < 2) return new Uint32Array(0);

  const hasBox = box !== null && box.some((v) => v !== 0);
  const boxInv = hasBox ? invert3x3(box!) : null;
  const usePbc = hasBox && boxInv !== null;

  // Precompute per-atom VDW radius — replaces the per-pair Record lookup.
  const radii = new Float32Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) {
    const r = VDW_RADII[elements[i]];
    radii[i] = r !== undefined ? r : DEFAULT_RADIUS;
  }

  let nx: number, ny: number, nz: number;
  // originX/Y/Z are subtracted from positions before grid assignment (0 in PBC mode).
  let originX = 0,
    originY = 0,
    originZ = 0;

  if (usePbc) {
    const b = box!;
    const lx = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
    const ly = Math.sqrt(b[3] * b[3] + b[4] * b[4] + b[5] * b[5]);
    const lz = Math.sqrt(b[6] * b[6] + b[7] * b[7] + b[8] * b[8]);
    nx = Math.max(1, Math.floor(lx / CELL_SIZE));
    ny = Math.max(1, Math.floor(ly / CELL_SIZE));
    nz = Math.max(1, Math.floor(lz / CELL_SIZE));
  } else {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < nAtoms; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    originX = minX;
    originY = minY;
    originZ = minZ;
    nx = Math.max(1, Math.floor((maxX - minX) / CELL_SIZE) + 1);
    ny = Math.max(1, Math.floor((maxY - minY) / CELL_SIZE) + 1);
    nz = Math.max(1, Math.floor((maxZ - minZ) / CELL_SIZE) + 1);
  }

  const nyz = ny * nz;
  const nCells = nx * ny * nz;

  // CSR cell list: assign every atom a cell index, then counting-sort into a flat array.
  const atomCell = new Uint32Array(nAtoms);
  const cellStart = new Uint32Array(nCells + 1);

  // In PBC mode, work off positions wrapped into the home cell `[0,1)`. The
  // cell-list distance path derives its neighbor shift from the cell-index
  // wrap (±1 box vector), which is only consistent with the atom coordinates
  // when those coordinates already lie in the home cell. Crystal inputs do NOT
  // satisfy this: `crystal::expand_symmetry` only centroid-wraps each symmetry
  // image, so its atoms sit at fractional coords outside `[0,1)`. Using the raw
  // (unwrapped) coordinates there makes a cross-face bond compute ~1 box too
  // long and get dropped (Issue #558). Bond inference returns only index pairs,
  // so wrapping internally changes connectivity to be correct without affecting
  // any downstream positions.
  const pbcPositions = usePbc ? new Float32Array(nAtoms * 3) : positions;

  if (usePbc) {
    const bi0 = boxInv![0],
      bi1 = boxInv![1],
      bi2 = boxInv![2];
    const bi3 = boxInv![3],
      bi4 = boxInv![4],
      bi5 = boxInv![5];
    const bi6 = boxInv![6],
      bi7 = boxInv![7],
      bi8 = boxInv![8];
    const b0 = box![0],
      b1 = box![1],
      b2 = box![2];
    const b3 = box![3],
      b4 = box![4],
      b5 = box![5];
    const b6 = box![6],
      b7 = box![7],
      b8 = box![8];
    const nxF = nx,
      nyF = ny,
      nzF = nz;
    for (let i = 0; i < nAtoms; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      let fx = bi0 * px + bi3 * py + bi6 * pz;
      let fy = bi1 * px + bi4 * py + bi7 * pz;
      let fz = bi2 * px + bi5 * py + bi8 * pz;
      fx = fx - Math.floor(fx);
      fy = fy - Math.floor(fy);
      fz = fz - Math.floor(fz);
      // Store the home-cell Cartesian position for the distance loops below.
      pbcPositions[i * 3] = b0 * fx + b3 * fy + b6 * fz;
      pbcPositions[i * 3 + 1] = b1 * fx + b4 * fy + b7 * fz;
      pbcPositions[i * 3 + 2] = b2 * fx + b5 * fy + b8 * fz;
      let cx = (fx * nxF) | 0;
      let cy = (fy * nyF) | 0;
      let cz = (fz * nzF) | 0;
      if (cx >= nxF) cx = nxF - 1;
      if (cy >= nyF) cy = nyF - 1;
      if (cz >= nzF) cz = nzF - 1;
      const idx = cx * nyz + cy * nz + cz;
      atomCell[i] = idx;
      cellStart[idx + 1]++;
    }
  } else {
    for (let i = 0; i < nAtoms; i++) {
      const px = positions[i * 3] - originX;
      const py = positions[i * 3 + 1] - originY;
      const pz = positions[i * 3 + 2] - originZ;
      let cx = (px / CELL_SIZE) | 0;
      let cy = (py / CELL_SIZE) | 0;
      let cz = (pz / CELL_SIZE) | 0;
      if (cx >= nx) cx = nx - 1;
      if (cy >= ny) cy = ny - 1;
      if (cz >= nz) cz = nz - 1;
      const idx = cx * nyz + cy * nz + cz;
      atomCell[i] = idx;
      cellStart[idx + 1]++;
    }
  }

  // Prefix-sum the per-cell counts, then scatter atoms into cellAtoms.
  for (let c = 0; c < nCells; c++) {
    cellStart[c + 1] += cellStart[c];
  }
  const cellAtoms = new Uint32Array(nAtoms);
  // Use cellStart as a moving cursor; restore afterward by shifting.
  for (let i = 0; i < nAtoms; i++) {
    const c = atomCell[i];
    const pos = cellStart[c]++;
    cellAtoms[pos] = i;
  }
  // Shift cellStart back so cellStart[c] points to the start of cell c again.
  for (let c = nCells; c > 0; c--) {
    cellStart[c] = cellStart[c - 1];
  }
  cellStart[0] = 0;

  // Output buffer — grows by doubling.
  let outBuf = new Uint32Array(Math.min(nAtoms * 8, 1024));
  let outLen = 0;

  const pushBond = (a: number, b: number): void => {
    if (outLen + 2 > outBuf.length) {
      const grown = new Uint32Array(outBuf.length * 2);
      grown.set(outBuf);
      outBuf = grown;
    }
    outBuf[outLen++] = a;
    outBuf[outLen++] = b;
  };

  const minDistSq = MIN_BOND_DIST * MIN_BOND_DIST;

  if (usePbc) {
    const b = box!;
    const b0 = b[0],
      b1 = b[1],
      b2 = b[2];
    const b3 = b[3],
      b4 = b[4],
      b5 = b[5];
    const b6 = b[6],
      b7 = b[7],
      b8 = b[8];

    // Per-neighbor-cell shift: when the cell index wraps around the box,
    // shift the neighbor atom by ±box vector(s) so the inner pair loop can
    // do plain Cartesian distance. Avoids running the minimum-image
    // transform (9 mults + 3 Math.round + 9 mults) for *every* candidate
    // pair — instead it's amortized over all atoms in the neighbor cell.
    //
    // This half-shell scheme is only correct when each axis has ≥ 3 cells.
    // With exactly 2 cells, a cell's +1 and −1 neighbours along an axis
    // collapse to the *same* cell but need opposite box shifts, while the
    // half-shell visits it once (with only the +1 shift) and same-cell pairs
    // get no shift at all — so both the wrap-around image and the direct
    // image cannot be represented and the min-image distance is wrong (e.g.
    // NaCl's 5.64 Å cube → 2 cells/axis produced spurious bonds). For such
    // small boxes we fall back to the exact per-pair minimum-image transform.
    if (nx < 3 || ny < 3 || nz < 3) {
      const bi0 = boxInv![0],
        bi1 = boxInv![1],
        bi2 = boxInv![2];
      const bi3 = boxInv![3],
        bi4 = boxInv![4],
        bi5 = boxInv![5];
      const bi6 = boxInv![6],
        bi7 = boxInv![7],
        bi8 = boxInv![8];
      // Brute-force min-image: at most a few dozen atoms per cell × few cells.
      for (let i = 0; i < nAtoms; i++) {
        const ix3 = i * 3;
        const pix = pbcPositions[ix3];
        const piy = pbcPositions[ix3 + 1];
        const piz = pbcPositions[ix3 + 2];
        const ri = radii[i];
        for (let j = i + 1; j < nAtoms; j++) {
          const jx3 = j * 3;
          let dx = pbcPositions[jx3] - pix;
          let dy = pbcPositions[jx3 + 1] - piy;
          let dz = pbcPositions[jx3 + 2] - piz;
          let sx = bi0 * dx + bi3 * dy + bi6 * dz;
          let sy = bi1 * dx + bi4 * dy + bi7 * dz;
          let sz = bi2 * dx + bi5 * dy + bi8 * dz;
          sx -= Math.round(sx);
          sy -= Math.round(sy);
          sz -= Math.round(sz);
          dx = b0 * sx + b3 * sy + b6 * sz;
          dy = b1 * sx + b4 * sy + b7 * sz;
          dz = b2 * sx + b5 * sy + b8 * sz;
          const distSq = dx * dx + dy * dy + dz * dz;
          const th = (ri + radii[j]) * vdwScale;
          if (distSq > minDistSq && distSq <= th * th) {
            pushBond(i, j);
          }
        }
      }
      return outBuf.slice(0, outLen);
    }

    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const cellIdx = ix * nyz + iy * nz + iz;
          const aStart = cellStart[cellIdx];
          const aEnd = cellStart[cellIdx + 1];
          if (aStart === aEnd) continue;

          // Self-cell pairs: same image, no shift.
          for (let a = aStart; a < aEnd; a++) {
            const i = cellAtoms[a];
            const ix3 = i * 3;
            const pix = pbcPositions[ix3];
            const piy = pbcPositions[ix3 + 1];
            const piz = pbcPositions[ix3 + 2];
            const ri = radii[i];
            for (let b2i = a + 1; b2i < aEnd; b2i++) {
              const j = cellAtoms[b2i];
              const jx3 = j * 3;
              const dx = pbcPositions[jx3] - pix;
              const dy = pbcPositions[jx3 + 1] - piy;
              const dz = pbcPositions[jx3 + 2] - piz;
              const distSq = dx * dx + dy * dy + dz * dz;
              const th = (ri + radii[j]) * vdwScale;
              if (distSq > minDistSq && distSq <= th * th) {
                if (i < j) pushBond(i, j);
                else pushBond(j, i);
              }
            }
          }

          // Neighbor-cell pairs (half-shell). For each visited neighbor,
          // compute one shift vector and reuse it for all atoms in that cell.
          for (let o = 0; o < N_OFFSETS; o++) {
            const dxo = OFFSETS[o * 3];
            const dyo = OFFSETS[o * 3 + 1];
            const dzo = OFFSETS[o * 3 + 2];

            // Detect per-axis wrap and accumulate the shift in fractional
            // units (-1, 0, or +1 along each box vector).
            let wx = 0;
            let wy = 0;
            let wz = 0;
            let jx = ix + dxo;
            let jy = iy + dyo;
            let jz = iz + dzo;
            if (jx < 0) {
              jx += nx;
              wx = -1;
            } else if (jx >= nx) {
              jx -= nx;
              wx = 1;
            }
            if (jy < 0) {
              jy += ny;
              wy = -1;
            } else if (jy >= ny) {
              jy -= ny;
              wy = 1;
            }
            if (jz < 0) {
              jz += nz;
              wz = -1;
            } else if (jz >= nz) {
              jz -= nz;
              wz = 1;
            }
            const nbrIdx = jx * nyz + jy * nz + jz;
            // In very small boxes, wrapped neighbor can map back to self — skip to avoid dup.
            if (nbrIdx === cellIdx) continue;
            const bStart = cellStart[nbrIdx];
            const bEnd = cellStart[nbrIdx + 1];
            if (bStart === bEnd) continue;

            // Cartesian shift to apply to neighbor atom positions.
            const shiftX = wx * b0 + wy * b3 + wz * b6;
            const shiftY = wx * b1 + wy * b4 + wz * b7;
            const shiftZ = wx * b2 + wy * b5 + wz * b8;

            for (let a = aStart; a < aEnd; a++) {
              const i = cellAtoms[a];
              const ix3 = i * 3;
              const pix = pbcPositions[ix3];
              const piy = pbcPositions[ix3 + 1];
              const piz = pbcPositions[ix3 + 2];
              const ri = radii[i];
              for (let bb = bStart; bb < bEnd; bb++) {
                const j = cellAtoms[bb];
                const jx3 = j * 3;
                const dx = pbcPositions[jx3] + shiftX - pix;
                const dy = pbcPositions[jx3 + 1] + shiftY - piy;
                const dz = pbcPositions[jx3 + 2] + shiftZ - piz;
                const distSq = dx * dx + dy * dy + dz * dz;
                const th = (ri + radii[j]) * vdwScale;
                if (distSq > minDistSq && distSq <= th * th) {
                  if (i < j) pushBond(i, j);
                  else pushBond(j, i);
                }
              }
            }
          }
        }
      }
    }
  } else {
    // Non-PBC: plain Cartesian distance, no minimum-image math.
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          const cellIdx = ix * nyz + iy * nz + iz;
          const aStart = cellStart[cellIdx];
          const aEnd = cellStart[cellIdx + 1];

          for (let a = aStart; a < aEnd; a++) {
            const i = cellAtoms[a];
            const ix3 = i * 3;
            const pix = positions[ix3];
            const piy = positions[ix3 + 1];
            const piz = positions[ix3 + 2];
            const ri = radii[i];
            for (let b2i = a + 1; b2i < aEnd; b2i++) {
              const j = cellAtoms[b2i];
              const jx3 = j * 3;
              const dx = positions[jx3] - pix;
              const dy = positions[jx3 + 1] - piy;
              const dz = positions[jx3 + 2] - piz;
              const distSq = dx * dx + dy * dy + dz * dz;
              const th = (ri + radii[j]) * vdwScale;
              if (distSq > minDistSq && distSq <= th * th) {
                if (i < j) pushBond(i, j);
                else pushBond(j, i);
              }
            }
          }

          for (let o = 0; o < N_OFFSETS; o++) {
            const jx = ix + OFFSETS[o * 3];
            const jy = iy + OFFSETS[o * 3 + 1];
            const jz = iz + OFFSETS[o * 3 + 2];
            if (jx < 0 || jx >= nx || jy < 0 || jy >= ny || jz < 0 || jz >= nz) continue;
            const nbrIdx = jx * nyz + jy * nz + jz;
            const bStart = cellStart[nbrIdx];
            const bEnd = cellStart[nbrIdx + 1];
            for (let a = aStart; a < aEnd; a++) {
              const i = cellAtoms[a];
              const ix3 = i * 3;
              const pix = positions[ix3];
              const piy = positions[ix3 + 1];
              const piz = positions[ix3 + 2];
              const ri = radii[i];
              for (let bb = bStart; bb < bEnd; bb++) {
                const j = cellAtoms[bb];
                const jx3 = j * 3;
                const dx = positions[jx3] - pix;
                const dy = positions[jx3 + 1] - piy;
                const dz = positions[jx3 + 2] - piz;
                const distSq = dx * dx + dy * dy + dz * dz;
                const th = (ri + radii[j]) * vdwScale;
                if (distSq > minDistSq && distSq <= th * th) {
                  if (i < j) pushBond(i, j);
                  else pushBond(j, i);
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(
    "IBJ-CALLED nAtoms=" +
      nAtoms +
      " usePbc=" +
      usePbc +
      " nx=" +
      nx +
      " ny=" +
      ny +
      " nz=" +
      nz +
      " bonds=" +
      outLen / 2,
  );
  return outBuf.slice(0, outLen);
}
