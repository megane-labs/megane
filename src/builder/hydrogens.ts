/**
 * Hydrogen bookkeeping for the Builder's Add and Element tools.
 *
 * A structure that already carries explicit hydrogens is edited the way a
 * chemist expects: clicking a hydrogen with the Add tool *replaces* it with
 * the chosen element (C–H + C gives C–C, not C–H–C), and every atom an edit
 * creates or re-elements gets its hydrogen count rebalanced to the element's
 * usual valence (propane's middle C set to O gives CH3–O–CH3, not CH3–OH2–CH3).
 * A bare skeleton (no hydrogen anywhere) is left bare.
 *
 * Everything here only *plans* ops: it reads the rendered snapshot and returns
 * ordinary `EditOp`s addressed by `refAt`, which the store pushes as one undo
 * step.
 */

import { getCovalentRadius } from "../constants";
import type { EditAtomRef, EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";
import { newAtomId, placeBondedAtom } from "./placement";

type Vec3 = [number, number, number];

/** Usual neutral valence of the main-group elements the auto-hydrogen logic knows. */
const VALENCE: Record<number, number> = {
  1: 1,
  5: 3,
  6: 4,
  7: 3,
  8: 2,
  9: 1,
  14: 4,
  15: 3,
  16: 2,
  17: 1,
  32: 4,
  33: 3,
  34: 2,
  35: 1,
  53: 1,
};

/** Usual valence of element `z`, or null when hydrogens should not be touched. */
export function typicalValence(z: number): number | null {
  return VALENCE[z] ?? null;
}

/** Whether the structure uses explicit hydrogens (any H atom present). */
export function hasHydrogens(snapshot: Snapshot): boolean {
  for (let i = 0; i < snapshot.nAtoms; i++) if (snapshot.elements[i] === 1) return true;
  return false;
}

interface Neighbour {
  index: number;
  order: number;
}

/** Bonded neighbours of atom `i` with their bond orders (1 without orders). */
export function neighboursOf(snapshot: Snapshot, i: number): Neighbour[] {
  const out: Neighbour[] = [];
  for (let b = 0; b < snapshot.nBonds; b++) {
    const a = snapshot.bonds[b * 2];
    const c = snapshot.bonds[b * 2 + 1];
    const other = a === i ? c : c === i ? a : -1;
    if (other < 0) continue;
    out.push({ index: other, order: snapshot.bondOrders ? snapshot.bondOrders[b] || 1 : 1 });
  }
  return out;
}

function posOf(snapshot: Snapshot, i: number): Vec3 {
  return [snapshot.positions[i * 3], snapshot.positions[i * 3 + 1], snapshot.positions[i * 3 + 2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-6 ? null : [v[0] / len, v[1] / len, v[2] / len];
}

/** Some unit vector perpendicular to unit vector `u`. */
function perpendicular(u: Vec3): Vec3 {
  const helper: Vec3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(cross(u, helper))!;
}

/**
 * Directions for `count` new bonds on an atom whose existing bonds point along
 * `existing` (unit vectors), in an ideal geometry with `domains` electron
 * domains (4 tetrahedral, 3 trigonal, 2 linear). The ideal polyhedron is
 * aligned to the first one or two existing bonds; the vertices the remaining
 * existing bonds sit closest to are taken, and the free ones are returned.
 */
export function bondDirections(existing: Vec3[], domains: number, count: number): Vec3[] {
  if (count <= 0) return [];
  const d = Math.min(4, Math.max(2, domains));
  const u: Vec3 = existing[0] ?? [1, 0, 0];
  let p: Vec3 = perpendicular(u);
  if (existing[1]) {
    const e1 = existing[1];
    p = unit(sub(e1, [u[0] * dot(e1, u), u[1] * dot(e1, u), u[2] * dot(e1, u)])) ?? p;
  }
  const q = cross(u, p);
  const cosT = d === 4 ? -1 / 3 : d === 3 ? -1 / 2 : -1;
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const vertices: Vec3[] = [u];
  for (let k = 0; k < d - 1; k++) {
    const phi = (2 * Math.PI * k) / (d - 1);
    const c = Math.cos(phi) * sinT;
    const s = Math.sin(phi) * sinT;
    vertices.push([
      u[0] * cosT + p[0] * c + q[0] * s,
      u[1] * cosT + p[1] * c + q[1] * s,
      u[2] * cosT + p[2] * c + q[2] * s,
    ]);
  }
  // Each existing bond occupies the free vertex it is closest to.
  const free = vertices.slice();
  for (const e of existing) {
    if (free.length === 0) break;
    let best = 0;
    for (let k = 1; k < free.length; k++) if (dot(free[k], e) > dot(free[best], e)) best = k;
    free.splice(best, 1);
  }
  return free.slice(0, count);
}

/** One neighbour of the atom being balanced, as it will be after the edit. */
interface PlannedNeighbour {
  ref: EditAtomRef;
  position: Vec3;
  order: number;
  hydrogen: boolean;
}

/**
 * Ops that bring the explicit hydrogens on atom `centerRef` (element `z` at
 * `center`) to its usual valence: delete the surplus ones, and (unless
 * `trimOnly`) add the missing ones at ideal-geometry positions, bonded to it.
 * Empty for an element with no known valence.
 */
export function balanceHydrogens(
  centerRef: EditAtomRef,
  z: number,
  center: Vec3,
  neighbours: PlannedNeighbour[],
  trimOnly = false,
): EditOp[] {
  const valence = typicalValence(z);
  if (valence === null) return [];
  const hydrogens = neighbours.filter((n) => n.hydrogen);
  const heavy = neighbours.filter((n) => !n.hydrogen);
  const heavyOrders = heavy.reduce((sum, n) => sum + n.order, 0);
  const want = Math.max(0, valence - heavyOrders);
  if (want < hydrogens.length) {
    return [{ op: "delete_atoms", atoms: hydrogens.slice(want).map((h) => h.ref) }];
  }
  if (trimOnly || want === hydrogens.length) return [];
  const existing = neighbours
    .map((n) => unit(sub(n.position, center)))
    .filter((v): v is Vec3 => v !== null);
  const multiple = heavy.reduce((sum, n) => sum + Math.max(0, n.order - 1), 0);
  const length = getCovalentRadius(z) + getCovalentRadius(1);
  return bondDirections(existing, 4 - multiple, want - hydrogens.length).map(
    (dir): EditOp => ({
      op: "add_atom",
      id: newAtomId(),
      element: 1,
      position: [
        center[0] + dir[0] * length,
        center[1] + dir[1] * length,
        center[2] + dir[2] * length,
      ],
      bondTo: centerRef,
    }),
  );
}

type RefAt = (i: number) => EditAtomRef;

/** Atom `i`'s neighbours as `PlannedNeighbour`s, optionally overriding one. */
function plannedNeighbours(
  snapshot: Snapshot,
  refAt: RefAt,
  i: number,
  override?: { index: number; position: Vec3; order: number; hydrogen: boolean },
): PlannedNeighbour[] {
  return neighboursOf(snapshot, i).map((n) =>
    override && n.index === override.index
      ? { ref: refAt(n.index), ...override }
      : {
          ref: refAt(n.index),
          position: posOf(snapshot, n.index),
          order: n.order,
          hydrogen: snapshot.elements[n.index] === 1,
        },
  );
}

/**
 * Replace hydrogen `h` (bonded to `parent`) by an atom of element `z`: the H
 * becomes that element, moves out to the new bond length along the same
 * direction, and gets its own hydrogens; the parent drops any hydrogen a
 * multiple bond leaves in excess.
 */
function replaceHydrogen(
  snapshot: Snapshot,
  refAt: RefAt,
  h: number,
  parent: number,
  z: number,
  order: number,
): EditOp[] {
  const hRef = refAt(h);
  const parentRef = refAt(parent);
  const pp = posOf(snapshot, parent);
  const hp = posOf(snapshot, h);
  const dir = unit(sub(hp, pp)) ?? [1, 0, 0];
  const length = getCovalentRadius(snapshot.elements[parent]) + getCovalentRadius(z);
  const target: Vec3 = [pp[0] + dir[0] * length, pp[1] + dir[1] * length, pp[2] + dir[2] * length];
  const ops: EditOp[] = [
    { op: "set_element", atoms: [hRef], element: z },
    { op: "move_atoms", atoms: [hRef], delta: sub(target, hp) },
  ];
  if (order !== 1) ops.push({ op: "add_bond", a: parentRef, b: hRef, order });
  ops.push(
    ...balanceHydrogens(hRef, z, target, [
      { ref: parentRef, position: pp, order, hydrogen: false },
    ]),
    ...balanceHydrogens(
      parentRef,
      snapshot.elements[parent],
      pp,
      plannedNeighbours(snapshot, refAt, parent, {
        index: h,
        position: target,
        order,
        hydrogen: false,
      }),
      true,
    ),
  );
  return ops;
}

/**
 * Ops for the Element tool setting atom `i` to element `z`. In a structure
 * with explicit hydrogens the atom's hydrogen count follows its new valence.
 */
export function setElementOps(snapshot: Snapshot, refAt: RefAt, i: number, z: number): EditOp[] {
  const ref = refAt(i);
  const ops: EditOp[] = [{ op: "set_element", atoms: [ref], element: z }];
  if (!hasHydrogens(snapshot) || snapshot.elements[i] === z) return ops;
  ops.push(...balanceHydrogens(ref, z, posOf(snapshot, i), plannedNeighbours(snapshot, refAt, i)));
  return ops;
}

/**
 * Ops for the Add tool clicked on atom `i` with element `z` and bond order
 * `order`. In a bare skeleton this is the plain "new atom bonded to `i`". With
 * explicit hydrogens, a click on a hydrogen replaces it, a click on a
 * saturated heavy atom replaces one of its hydrogens, and the new atom gets
 * its own hydrogens.
 */
export function addOnAtomOps(
  snapshot: Snapshot,
  refAt: RefAt,
  i: number,
  z: number,
  order: number,
): EditOp[] {
  const ref = refAt(i);
  const id = newAtomId();
  const at = placeBondedAtom(snapshot, i, z);
  const plain: EditOp = { op: "add_atom", id, element: z, position: at, bondTo: ref, order };
  if (z === 1 || !hasHydrogens(snapshot)) return [plain];
  const neighbours = neighboursOf(snapshot, i);
  if (snapshot.elements[i] === 1) {
    // A lone H just changes element; a bonded one is replaced.
    if (neighbours.length !== 1) return setElementOps(snapshot, refAt, i, z);
    return replaceHydrogen(snapshot, refAt, i, neighbours[0].index, z, order);
  }
  const valence = typicalValence(snapshot.elements[i]);
  const used = neighbours.reduce((sum, n) => sum + n.order, 0);
  const h = neighbours.find((n) => snapshot.elements[n.index] === 1);
  if (valence !== null && h && used + order > valence) {
    return replaceHydrogen(snapshot, refAt, h.index, i, z, order);
  }
  return [
    plain,
    ...balanceHydrogens(id, z, at, [{ ref, position: posOf(snapshot, i), order, hydrogen: false }]),
  ];
}
