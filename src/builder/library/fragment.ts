/**
 * Geometry helpers for library molecules: reading one out of a Snapshot,
 * centring it, scaling a flat sketch to Å, naming it, and deciding where it
 * lands in the document.
 */

import { getCovalentRadius, getElementSymbol } from "../../constants";
import type { EditOp } from "../../pipeline/types";
import type { Snapshot } from "../../types";
import type { MoleculeGeometry } from "./types";

/** Centroid of `positions` (flat xyz), or the origin for no atoms. */
export function centroid(positions: ArrayLike<number>): [number, number, number] {
  const n = Math.floor(positions.length / 3);
  if (n === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    x += positions[i * 3];
    y += positions[i * 3 + 1];
    z += positions[i * 3 + 2];
  }
  return [x / n, y / n, z / n];
}

/** The same geometry with its centroid moved to the origin. */
export function centered(geometry: MoleculeGeometry): MoleculeGeometry {
  const [cx, cy, cz] = centroid(geometry.positions);
  const positions = geometry.positions.map((v, i) => v - [cx, cy, cz][i % 3]);
  return { ...geometry, positions };
}

/** Axis-aligned bounds of a flat xyz array; zeros for no atoms. */
export function bounds(positions: ArrayLike<number>): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const n = Math.floor(positions.length / 3);
  if (n === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** True when every atom lies in the z = 0 plane: a 2D sketch, not a 3D structure. */
export function isPlanar(positions: ArrayLike<number>, eps = 1e-4): boolean {
  const n = Math.floor(positions.length / 3);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (Math.abs(positions[i * 3 + 2]) > eps) return false;
  }
  return true;
}

/**
 * Rescale a sketch so its bonds are as long as covalent radii say they should
 * be. Ketcher (and most 2D sketchers) draw with a unit bond length, which is
 * not Å; the factor is mean(covalent-radius sum) / mean(drawn bond length)
 * over every bond. A geometry with no bonds, or with degenerate bonds, is
 * returned unchanged.
 */
export function scaleBondsToCovalent(geometry: MoleculeGeometry): MoleculeGeometry {
  if (geometry.bonds.length === 0) return geometry;
  const p = geometry.positions;
  let drawn = 0;
  let expected = 0;
  for (const [i, j] of geometry.bonds) {
    const dx = p[i * 3] - p[j * 3];
    const dy = p[i * 3 + 1] - p[j * 3 + 1];
    const dz = p[i * 3 + 2] - p[j * 3 + 2];
    drawn += Math.sqrt(dx * dx + dy * dy + dz * dz);
    expected += getCovalentRadius(geometry.elements[i]) + getCovalentRadius(geometry.elements[j]);
  }
  if (drawn < 1e-6) return geometry;
  const factor = expected / drawn;
  return { ...geometry, positions: p.map((v) => v * factor) };
}

/**
 * The geometry of `indices` (or every atom) of a snapshot, with the bonds
 * both of whose atoms are included, renumbered to the subset.
 */
export function geometryFromSnapshot(snapshot: Snapshot, indices?: number[]): MoleculeGeometry {
  const picked = indices ? [...new Set(indices)].sort((a, b) => a - b) : null;
  const atoms = picked ?? Array.from({ length: snapshot.nAtoms }, (_, i) => i);
  const local = new Map<number, number>(atoms.map((a, k) => [a, k]));
  const elements: number[] = [];
  const positions: number[] = [];
  for (const a of atoms) {
    elements.push(snapshot.elements[a]);
    positions.push(
      snapshot.positions[a * 3],
      snapshot.positions[a * 3 + 1],
      snapshot.positions[a * 3 + 2],
    );
  }
  const bonds: [number, number][] = [];
  const bondOrders: number[] = [];
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = local.get(snapshot.bonds[b * 2]);
    const j = local.get(snapshot.bonds[b * 2 + 1]);
    if (i === undefined || j === undefined) continue;
    bonds.push([i, j]);
    bondOrders.push(snapshot.bondOrders ? snapshot.bondOrders[b] : 1);
  }
  const geometry: MoleculeGeometry = { elements, positions, bonds };
  if (bondOrders.some((o) => o !== 1)) geometry.bondOrders = bondOrders;
  return geometry;
}

/** Hill-order formula (`C` first, then `H`, then the rest alphabetically). */
export function formulaOf(elements: ArrayLike<number>): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < elements.length; i++) {
    const sym = getElementSymbol(elements[i]);
    counts.set(sym, (counts.get(sym) ?? 0) + 1);
  }
  const rest = [...counts.keys()].filter((s) => s !== "C" && s !== "H").sort();
  const order = counts.has("C")
    ? ["C", ...(counts.has("H") ? ["H"] : []), ...rest]
    : [...counts.keys()].sort();
  return order.map((s) => `${s}${counts.get(s)! > 1 ? counts.get(s) : ""}`).join("");
}

/** Gap left between an added molecule and the structure it is placed beside, in Å. */
export const PLACEMENT_MARGIN = 2;

/**
 * Where an added molecule's centroid goes when the user did not click a spot:
 * beside the structure along +x (past its bounding box, level with its
 * centre) when there are atoms, at the cell centre when there is only a
 * cell, and at the origin otherwise.
 */
export function autoPlacement(
  shown: Snapshot | null,
  geometry: MoleculeGeometry,
): [number, number, number] {
  if (!shown) return [0, 0, 0];
  if (shown.nAtoms > 0) {
    const { min, max } = bounds(shown.positions);
    const half = bounds(geometry.positions);
    const halfWidth = (half.max[0] - half.min[0]) / 2;
    return [max[0] + PLACEMENT_MARGIN + halfWidth, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }
  if (shown.box) {
    const b = shown.box;
    const o = shown.boxOrigin ?? [0, 0, 0];
    return [
      o[0] + (b[0] + b[3] + b[6]) / 2,
      o[1] + (b[1] + b[4] + b[7]) / 2,
      o[2] + (b[2] + b[5] + b[8]) / 2,
    ];
  }
  return [0, 0, 0];
}

let nextFragmentSerial = 1;

/** Fresh fragment id carrying the molecule's name, unique within the page. */
export function newFragmentId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "fragment";
  return `${slug}-${nextFragmentSerial++}`;
}

/** The `add_fragment` op that drops `geometry` with its centroid at `at`. */
export function fragmentOp(
  id: string,
  geometry: MoleculeGeometry,
  at: [number, number, number],
): EditOp {
  const op: Extract<EditOp, { op: "add_fragment" }> = {
    op: "add_fragment",
    id,
    elements: [...geometry.elements],
    positions: [...geometry.positions],
    bonds: geometry.bonds.map(([i, j]) => [i, j] as [number, number]),
    translate: [at[0], at[1], at[2]],
  };
  if (geometry.bondOrders) op.bondOrders = [...geometry.bondOrders];
  return op;
}
