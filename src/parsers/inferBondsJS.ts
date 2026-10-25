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
/** Smallest cell edge; `planVdwScan` widens it when the cutoffs need it. */
const BASE_CELL_SIZE = 2.0;
/** Relative slack on a cutoff-sized cell (bonds.rs `CELL_SLACK`). */
const CELL_SLACK = 1.001;
/** At most `1 / WIDE_ATOM_SHARE` of the atoms may be wide (bonds.rs uses the same). */
const WIDE_ATOM_SHARE = 8;

/**
 * How the cell-list scan finds every pair within
 * `(vdw_i + vdw_j) * vdwScale` (bonds.rs `ScanPlan`).
 *
 * The half-shell scan only pairs atoms in the same or adjacent cells, so it is
 * exact only when every cutoff fits in one cell. A fixed 2 Å cell was narrower
 * than the cutoff of carbon (2.04 Å), of every metal, and of everything once
 * the tolerance slider passes ~0.6, so such bonds came and went with the grid
 * origin. The cell is now sized for all but a small minority of *wide* atoms,
 * which instead search `reach` cells along each axis.
 */
export interface VdwScanPlan {
  cellSize: number;
  /** Indices of the wide atoms, ascending. */
  wide: Uint32Array;
  /** `isWide[i] === 1` for every wide atom (empty when there are none). */
  isWide: Uint8Array;
  /** Cells a wide atom searches along each axis. */
  reach: number;
}

function vdwRadiusOf(z: number): number {
  const r = VDW_RADII[z];
  return r !== undefined ? r : DEFAULT_RADIUS;
}

/** Plan the scan of `elements[0..nAtoms)` (see {@link VdwScanPlan}). */
export function planVdwScan(elements: Uint8Array, nAtoms: number, vdwScale: number): VdwScanPlan {
  const cutoff = (r: number): number => 2 * r * vdwScale * CELL_SLACK;
  const counts = new Uint32Array(256);
  for (let i = 0; i < nAtoms; i++) counts[elements[i]]++;
  // Elements present, widest radius first.
  const present: [number, number][] = [];
  for (let z = 0; z < 256; z++) if (counts[z] > 0) present.push([vdwRadiusOf(z), counts[z]]);
  present.sort((a, b) => b[0] - a[0]);

  // Grow the cell until the atoms it does not fit are a small minority.
  const budget = Math.floor(nAtoms / WIDE_ATOM_SHARE);
  let cellSize = BASE_CELL_SIZE;
  let outside = 0;
  for (const [r, count] of present) {
    if (cutoff(r) <= BASE_CELL_SIZE) break;
    outside += count;
    if (outside > budget) {
      cellSize = cutoff(r);
      break;
    }
  }

  const wideElement = new Uint8Array(256);
  for (let z = 0; z < 256; z++) wideElement[z] = cutoff(vdwRadiusOf(z)) > cellSize ? 1 : 0;
  let nWide = 0;
  for (let i = 0; i < nAtoms; i++) nWide += wideElement[elements[i]];
  const wide = new Uint32Array(nWide);
  const isWide = new Uint8Array(nWide > 0 ? nAtoms : 0);
  for (let i = 0, k = 0; i < nAtoms; i++) {
    if (wideElement[elements[i]] === 1) {
      wide[k++] = i;
      isWide[i] = 1;
    }
  }
  const maxCutoff = present.length > 0 ? cutoff(present[0][0]) : 0;
  return { cellSize, wide, isWide, reach: Math.ceil(maxCutoff / cellSize) };
}

/**
 * Cell offsets within `reach` that the half-shell scan does not visit (some
 * axis two or more cells away), flattened as (dx, dy, dz) triples. Wide atoms
 * search all of them, so a pair of two wide atoms is seen from both ends and
 * kept only from the lower index.
 */
function farOffsets(reach: number): Int32Array {
  const out: number[] = [];
  for (let x = -reach; x <= reach; x++)
    for (let y = -reach; y <= reach; y++)
      for (let z = -reach; z <= reach; z++)
        if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) >= 2) out.push(x, y, z);
  return new Int32Array(out);
}

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
 * Largest cell grid kept dense: a few cells per atom plus a floor for small
 * systems (crates/megane-core/src/bonds.rs `max_dense_cells` uses the same).
 * A dense grid spans the bounding box, so one atom far from the rest (a
 * 9999 Å placeholder) would otherwise ask for billions of cells.
 */
export function maxDenseCells(nAtoms: number): number {
  return nAtoms * 8 + 4096;
}

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
    radii[i] = vdwRadiusOf(elements[i]);
  }
  const plan = planVdwScan(elements, nAtoms, vdwScale);
  const cellSize = plan.cellSize;

  let nx: number, ny: number, nz: number;
  // originX/Y/Z are subtracted from positions before grid assignment (0 in PBC mode).
  let originX = 0,
    originY = 0,
    originZ = 0;

  if (usePbc) {
    // Cells split each box vector evenly, so a cell's width along axis a is
    // the spacing of the lattice planes spanned by the other two vectors
    // (volume / |b × c|), not |a| — in a skewed cell |a| overstates it.
    const [wx, wy, wz] = planeSpacings(box!);
    nx = Math.max(1, Math.floor(wx / cellSize));
    ny = Math.max(1, Math.floor(wy / cellSize));
    nz = Math.max(1, Math.floor(wz / cellSize));
    // A huge, mostly empty box: coarser cells (never finer than the cutoff)
    // keep the table proportional to the atoms. Wrapped atoms fill the box, so
    // there is no far-off outlier to make the cells crowded.
    const cap = maxDenseCells(nAtoms);
    if (nx * ny * nz > cap) {
      const shrink = Math.cbrt((nx * ny * nz) / cap);
      nx = Math.max(1, Math.floor(nx / shrink));
      ny = Math.max(1, Math.floor(ny / shrink));
      nz = Math.max(1, Math.floor(nz / shrink));
    }
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
    nx = Math.max(1, Math.floor((maxX - minX) / cellSize) + 1);
    ny = Math.max(1, Math.floor((maxY - minY) / cellSize) + 1);
    nz = Math.max(1, Math.floor((maxZ - minZ) / cellSize) + 1);
    if (nx * ny * nz > maxDenseCells(nAtoms)) {
      return sparseBondsVdw(
        positions,
        radii,
        nAtoms,
        vdwScale,
        plan,
        [minX, minY, minZ],
        [nx, ny, nz],
      );
    }
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
      let cx = (px / cellSize) | 0;
      let cy = (py / cellSize) | 0;
      let cz = (pz / cellSize) | 0;
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
    // Wide atoms search `reach` cells either way, so they need 2·reach + 1
    // distinct cells per axis for the same reason.
    const minCells = plan.wide.length > 0 ? 2 * plan.reach + 1 : 3;
    if (nx < minCells || ny < minCells || nz < minCells) {
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

  // Wide atoms: the cells beyond the half shell, within their reach. In PBC
  // mode a wrapped cell carries the matching box-vector shift; there are at
  // least 2·reach + 1 cells per axis, so one wrap is all an offset can need.
  if (plan.wide.length > 0) {
    const far = farOffsets(plan.reach);
    const nFar = far.length / 3;
    const b = usePbc ? box! : null;
    const isWide = plan.isWide;
    for (let w = 0; w < plan.wide.length; w++) {
      const i = plan.wide[w];
      const c = atomCell[i];
      const ix = Math.floor(c / nyz);
      const iy = Math.floor(c / nz) % ny;
      const iz = c % nz;
      const pix = pbcPositions[i * 3];
      const piy = pbcPositions[i * 3 + 1];
      const piz = pbcPositions[i * 3 + 2];
      const ri = radii[i];
      for (let o = 0; o < nFar; o++) {
        let jx = ix + far[o * 3];
        let jy = iy + far[o * 3 + 1];
        let jz = iz + far[o * 3 + 2];
        let shiftX = 0;
        let shiftY = 0;
        let shiftZ = 0;
        if (b) {
          const wx = jx < 0 ? -1 : jx >= nx ? 1 : 0;
          const wy = jy < 0 ? -1 : jy >= ny ? 1 : 0;
          const wz = jz < 0 ? -1 : jz >= nz ? 1 : 0;
          jx -= wx * nx;
          jy -= wy * ny;
          jz -= wz * nz;
          shiftX = wx * b[0] + wy * b[3] + wz * b[6];
          shiftY = wx * b[1] + wy * b[4] + wz * b[7];
          shiftZ = wx * b[2] + wy * b[5] + wz * b[8];
        } else if (jx < 0 || jx >= nx || jy < 0 || jy >= ny || jz < 0 || jz >= nz) {
          continue;
        }
        const nbrIdx = jx * nyz + jy * nz + jz;
        for (let bb = cellStart[nbrIdx]; bb < cellStart[nbrIdx + 1]; bb++) {
          const j = cellAtoms[bb];
          if (isWide[j] === 1 && j < i) continue; // checked from j
          const dx = pbcPositions[j * 3] + shiftX - pix;
          const dy = pbcPositions[j * 3 + 1] + shiftY - piy;
          const dz = pbcPositions[j * 3 + 2] + shiftZ - piz;
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

  return outBuf.slice(0, outLen);
}

/**
 * Width of the cell spanned by `box` (row vectors a, b, c) along each axis:
 * the spacing of the lattice planes parallel to the other two vectors,
 * `volume / |b × c|` for a, and so on.
 */
function planeSpacings(box: Float32Array): [number, number, number] {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = box;
  const bc = [by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx];
  const ca = [cy * az - cz * ay, cz * ax - cx * az, cx * ay - cy * ax];
  const ab = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  const volume = Math.abs(ax * bc[0] + ay * bc[1] + az * bc[2]);
  const len = (v: number[]): number => Math.hypot(v[0], v[1], v[2]);
  return [volume / len(bc), volume / len(ca), volume / len(ab)];
}

/**
 * Non-periodic inference over only the occupied cells, for a grid too large
 * to hold densely. Cells are visited in the dense grid's (x, y, z) order and
 * each one's pairs in the same sequence as the dense loop (own pairs, then
 * each half-shell neighbor), so it finds the same bonds in the same order;
 * neighbor cells are found by binary search.
 */
function sparseBondsVdw(
  positions: Float32Array,
  radii: Float32Array,
  nAtoms: number,
  vdwScale: number,
  plan: VdwScanPlan,
  origin: [number, number, number],
  gridDims: [number, number, number],
): Uint32Array {
  // Cell keys are doubles: past 2^52 cells `k + 1 === k`, so a neighbour one
  // cell over would compare as out of range. Clamp like the Rust scan's
  // saturating integer keys — atoms beyond share the last cell, and the pair
  // test still measures their true distance.
  const dims = gridDims.map((d) => Math.min(d, 2 ** 52)) as [number, number, number];
  const keys = new Float64Array(nAtoms * 3);
  for (let i = 0; i < nAtoms; i++) {
    for (let k = 0; k < 3; k++) {
      keys[i * 3 + k] = Math.min(
        Math.floor((positions[i * 3 + k] - origin[k]) / plan.cellSize),
        dims[k] - 1,
      );
    }
  }
  const cmpKey = (a: number, bx: number, by: number, bz: number): number =>
    keys[a * 3] - bx || keys[a * 3 + 1] - by || keys[a * 3 + 2] - bz;
  const order = new Uint32Array(nAtoms);
  for (let i = 0; i < nAtoms; i++) order[i] = i;
  order.sort((a, b) => cmpKey(a, keys[b * 3], keys[b * 3 + 1], keys[b * 3 + 2]) || a - b);

  // Occupied cells: the first atom of each run of equal keys.
  const cellFirst: number[] = [];
  for (let k = 0; k < nAtoms; k++) {
    const a = order[k];
    if (k === 0) {
      cellFirst.push(0);
      continue;
    }
    const p = order[k - 1];
    if (cmpKey(a, keys[p * 3], keys[p * 3 + 1], keys[p * 3 + 2]) !== 0) cellFirst.push(k);
  }
  const nCells = cellFirst.length;
  cellFirst.push(nAtoms);
  const findCell = (x: number, y: number, z: number): number => {
    let lo = 0;
    let hi = nCells - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cmpKey(order[cellFirst[mid]], x, y, z);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  let out = new Uint32Array(Math.min(nAtoms * 8, 1024));
  let len = 0;
  const minDistSq = MIN_BOND_DIST * MIN_BOND_DIST;
  const tryPair = (i: number, j: number): void => {
    const dx = positions[j * 3] - positions[i * 3];
    const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
    const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
    const distSq = dx * dx + dy * dy + dz * dz;
    const th = (radii[i] + radii[j]) * vdwScale;
    if (distSq <= minDistSq || distSq > th * th) return;
    if (len + 2 > out.length) {
      const grown = new Uint32Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    out[len++] = Math.min(i, j);
    out[len++] = Math.max(i, j);
  };

  const neighbors = new Int32Array(N_OFFSETS);
  for (let c = 0; c < nCells; c++) {
    const start = cellFirst[c];
    const end = cellFirst[c + 1];
    const first = order[start];
    const cx = keys[first * 3];
    const cy = keys[first * 3 + 1];
    const cz = keys[first * 3 + 2];
    for (let o = 0; o < N_OFFSETS; o++) {
      const jx = cx + OFFSETS[o * 3];
      const jy = cy + OFFSETS[o * 3 + 1];
      const jz = cz + OFFSETS[o * 3 + 2];
      const outside = jx < 0 || jx >= dims[0] || jy < 0 || jy >= dims[1] || jz < 0 || jz >= dims[2];
      neighbors[o] = outside ? -1 : findCell(jx, jy, jz);
    }
    for (let a = start; a < end; a++) {
      for (let b = a + 1; b < end; b++) tryPair(order[a], order[b]);
    }
    for (let o = 0; o < N_OFFSETS; o++) {
      const n = neighbors[o];
      if (n < 0) continue;
      for (let a = start; a < end; a++) {
        for (let b = cellFirst[n]; b < cellFirst[n + 1]; b++) tryPair(order[a], order[b]);
      }
    }
  }

  // Wide atoms: the cells beyond the half shell, within their reach.
  if (plan.wide.length > 0) {
    const far = farOffsets(plan.reach);
    for (let w = 0; w < plan.wide.length; w++) {
      const i = plan.wide[w];
      for (let o = 0; o < far.length; o += 3) {
        const jx = keys[i * 3] + far[o];
        const jy = keys[i * 3 + 1] + far[o + 1];
        const jz = keys[i * 3 + 2] + far[o + 2];
        if (jx < 0 || jx >= dims[0] || jy < 0 || jy >= dims[1] || jz < 0 || jz >= dims[2]) continue;
        const n = findCell(jx, jy, jz);
        if (n < 0) continue;
        for (let b = cellFirst[n]; b < cellFirst[n + 1]; b++) {
          const j = order[b];
          if (plan.isWide[j] !== 1 || j > i) tryPair(i, j);
        }
      }
    }
  }
  return out.slice(0, len);
}
