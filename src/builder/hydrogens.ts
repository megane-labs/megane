/**
 * Hydrogen bookkeeping for the Builder's Add and Element tools.
 *
 * A structure that already carries explicit hydrogens is edited the way a
 * chemist expects: clicking a hydrogen with the Add tool *replaces* it with
 * the chosen element (C–H + C gives C–C, not C–H–C), and every atom an edit
 * creates or re-elements gets its hydrogen count rebalanced to the element's
 * usual valence (propane's middle C set to O gives CH3–O–CH3, not CH3–OH2–CH3).
 * Whether hydrogens are kept balanced follows the document's `HydrogenMode`
 * (`balancesHydrogens`): in `auto`, a bare skeleton (no hydrogen anywhere) is
 * left bare. Deleting an atom takes the hydrogens that hung only on it along,
 * and removing or re-ordering a bond rebalances both of its atoms. Aromatic
 * bonds (order 4) count 1.5 toward a valence.
 *
 * Everything here only *plans* ops: it reads the rendered snapshot and returns
 * ordinary `EditOp`s addressed by `refAt`, which the store pushes as one undo
 * step.
 */

import { getCovalentRadius } from "../constants";
import type { EditAtomRef, EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";
import type { HydrogenMode } from "./store";
import { atomName, bondValence, newAtomId, placeBondedAtom } from "./placement";
import { bondDirections } from "./geometry";

export { bondDirections };

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

/** Whether edits keep hydrogens balanced under `mode` (see `HydrogenMode`). */
export function balancesHydrogens(mode: HydrogenMode, snapshot: Snapshot): boolean {
  return mode === "on" || (mode === "auto" && hasHydrogens(snapshot));
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

/** `neighboursOf` for every atom at once, in one pass over the bonds. */
function neighbourTable(snapshot: Snapshot): Neighbour[][] {
  const out: Neighbour[][] = Array.from({ length: snapshot.nAtoms }, () => []);
  for (let b = 0; b < snapshot.nBonds; b++) {
    const a = snapshot.bonds[b * 2];
    const c = snapshot.bonds[b * 2 + 1];
    const order = snapshot.bondOrders ? snapshot.bondOrders[b] || 1 : 1;
    out[a]?.push({ index: c, order });
    out[c]?.push({ index: a, order });
  }
  return out;
}

function posOf(snapshot: Snapshot, i: number): Vec3 {
  return [snapshot.positions[i * 3], snapshot.positions[i * 3 + 1], snapshot.positions[i * 3 + 2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len < 1e-6 ? null : [v[0] / len, v[1] / len, v[2] / len];
}

/** One neighbour of the atom being balanced, as it will be after the edit. */
interface PlannedNeighbour {
  /** Rendered index, when the neighbour is an atom of the snapshot. */
  index?: number;
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
  const heavyOrders = heavy.reduce((sum, n) => sum + bondValence(n.order), 0);
  // An odd count of aromatic bonds leaves half a bond: round down.
  const want = Math.max(0, Math.floor(valence - heavyOrders + 1e-9));
  if (want < hydrogens.length) {
    return [{ op: "delete_atoms", atoms: hydrogens.slice(want).map((h) => h.ref) }];
  }
  if (trimOnly || want === hydrogens.length) return [];
  const existing = neighbours
    .map((n) => unit(sub(n.position, center)))
    .filter((v): v is Vec3 => v !== null);
  const multiple = heavy.reduce((sum, n) => sum + Math.max(0, bondValence(n.order) - 1), 0);
  const length = getCovalentRadius(z) + getCovalentRadius(1);
  return bondDirections(existing, Math.round(4 - multiple), want - hydrogens.length).map(
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
  neighbours: Neighbour[] = neighboursOf(snapshot, i),
): PlannedNeighbour[] {
  return neighbours.map((n) =>
    override && n.index === override.index
      ? { ref: refAt(n.index), ...override }
      : {
          index: n.index,
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
 * Ops for the Element tool setting atom `i` to element `z`. While hydrogens
 * are balanced (`balance`, by default whenever the structure has any H) the
 * atom's hydrogen count follows its new valence.
 */
export function setElementOps(
  snapshot: Snapshot,
  refAt: RefAt,
  i: number,
  z: number,
  balance = hasHydrogens(snapshot),
): EditOp[] {
  return setElementsOps(snapshot, refAt, [i], z, balance);
}

/**
 * `setElementOps` for several atoms at once: one `set_element` for all of
 * them, then each atom that really changes element rebalanced.
 */
export function setElementsOps(
  snapshot: Snapshot,
  refAt: RefAt,
  indices: number[],
  z: number,
  balance = hasHydrogens(snapshot),
): EditOp[] {
  const atoms = indices.filter((i) => i >= 0 && i < snapshot.nAtoms);
  if (atoms.length === 0) return [];
  const ops: EditOp[] = [{ op: "set_element", atoms: atoms.map(refAt), element: z }];
  if (!balance) return ops;
  const changing = new Set(atoms);
  const table = atoms.length > 1 ? neighbourTable(snapshot) : null;
  for (const i of atoms) {
    if (snapshot.elements[i] === z) continue;
    // A neighbour that changes too is planned with its new element.
    const neighbours = plannedNeighbours(snapshot, refAt, i, undefined, table?.[i]).map((n) =>
      changing.has(n.index!) ? { ...n, hydrogen: z === 1 } : n,
    );
    ops.push(...balanceHydrogens(refAt(i), z, posOf(snapshot, i), neighbours));
  }
  return ops;
}

/**
 * Ops for the Add tool clicked on atom `i` with element `z` and bond order
 * `order`. In a bare skeleton (`balance` off) this is the plain "new atom
 * bonded to `i`". With balanced hydrogens, a click on a hydrogen replaces it,
 * a click on a saturated heavy atom replaces one of its hydrogens, and the new
 * atom gets its own hydrogens.
 */
export function addOnAtomOps(
  snapshot: Snapshot,
  refAt: RefAt,
  i: number,
  z: number,
  order: number,
  balance = hasHydrogens(snapshot),
): EditOp[] {
  const ref = refAt(i);
  const id = newAtomId();
  const at = placeBondedAtom(snapshot, i, z, order);
  const plain: EditOp = { op: "add_atom", id, element: z, position: at, bondTo: ref, order };
  if (z === 1 || !balance) return [plain];
  const neighbours = neighboursOf(snapshot, i);
  if (snapshot.elements[i] === 1) {
    // A lone H just changes element; a bonded one is replaced.
    if (neighbours.length !== 1) return setElementOps(snapshot, refAt, i, z, balance);
    return replaceHydrogen(snapshot, refAt, i, neighbours[0].index, z, order);
  }
  const valence = typicalValence(snapshot.elements[i]);
  const used = neighbours.reduce((sum, n) => sum + bondValence(n.order), 0);
  const h = neighbours.find((n) => snapshot.elements[n.index] === 1);
  if (valence !== null && h && used + bondValence(order) > valence) {
    return replaceHydrogen(snapshot, refAt, h.index, i, z, order);
  }
  return [
    plain,
    ...balanceHydrogens(id, z, at, [{ ref, position: posOf(snapshot, i), order, hydrogen: false }]),
  ];
}

/** Ops for the Add tool clicked on empty space at `at`: the atom, and its hydrogens when balanced. */
export function addFreeAtomOps(z: number, at: Vec3, balance: boolean): EditOp[] {
  const id = newAtomId();
  const op: EditOp = { op: "add_atom", id, element: z, position: at };
  return balance && z !== 1 ? [op, ...balanceHydrogens(id, z, at, [])] : [op];
}

/** The order of the bond between atoms `i` and `j`, or 0 when they are not bonded. */
export function bondOrderBetween(snapshot: Snapshot, i: number, j: number): number {
  return neighboursOf(snapshot, i).find((n) => n.index === j)?.order ?? 0;
}

/** Ops that rebalance heavy atom `i` given its neighbours as they will be. */
function rebalance(snapshot: Snapshot, refAt: RefAt, i: number, neighbours: PlannedNeighbour[]) {
  if (snapshot.elements[i] === 1) return [];
  return balanceHydrogens(refAt(i), snapshot.elements[i], posOf(snapshot, i), neighbours);
}

/**
 * Ops for the Bond tool bonding atoms `i` and `j` with order `order` (a new
 * bond, or a new order for an existing one). With balanced hydrogens both
 * heavy atoms lose the hydrogens the bond leaves in excess, or gain the ones a
 * lower order makes room for.
 */
export function bondOps(
  snapshot: Snapshot,
  refAt: RefAt,
  i: number,
  j: number,
  order: number,
  balance: boolean,
): EditOp[] {
  const ops: EditOp[] = [{ op: "add_bond", a: refAt(i), b: refAt(j), order }];
  if (!balance || bondValence(order) === bondValence(bondOrderBetween(snapshot, i, j))) return ops;
  for (const [x, y] of [
    [i, j],
    [j, i],
  ]) {
    const partner: PlannedNeighbour = {
      ref: refAt(y),
      position: posOf(snapshot, y),
      order,
      hydrogen: false,
    };
    const others = plannedNeighbours(snapshot, refAt, x).filter((n) => n.index !== y);
    ops.push(...rebalance(snapshot, refAt, x, [...others, partner]));
  }
  return ops;
}

/**
 * Ops that remove the bond between atoms `i` and `j`. With balanced
 * hydrogens each heavy atom that loses a heavy partner gets a hydrogen (or
 * more, for a multiple bond) in its place.
 */
export function removeBondOps(
  snapshot: Snapshot,
  refAt: RefAt,
  i: number,
  j: number,
  balance: boolean,
): EditOp[] {
  const ops: EditOp[] = [{ op: "delete_bond", a: refAt(i), b: refAt(j) }];
  if (!balance) return ops;
  for (const [x, y] of [
    [i, j],
    [j, i],
  ]) {
    if (snapshot.elements[y] === 1) continue;
    const kept = plannedNeighbours(snapshot, refAt, x).filter((n) => n.index !== y);
    ops.push(...rebalance(snapshot, refAt, x, kept));
  }
  return ops;
}

/** A deletion planned by `deleteAtomsEdit`. */
export interface DeleteEdit {
  ops: EditOp[];
  /** History label: "Delete O #5 (+2 H)". */
  label: string;
  /** Hydrogens deleted along with the chosen atoms. */
  extraHydrogens: number;
}

/**
 * Delete rendered atoms `indices`. While hydrogens are balanced
 * (`balancesHydrogens(mode, snapshot)`), the H atoms bonded only to deleted
 * atoms go with them, and every surviving heavy atom that lost a heavy
 * neighbour is rebalanced (a carbonyl C whose O is deleted becomes CH2). One
 * list of ops, for one Undo step; empty when no index is valid.
 */
export function deleteAtomsEdit(
  snapshot: Snapshot,
  refAt: RefAt,
  indices: number[],
  mode: HydrogenMode,
): DeleteEdit {
  const chosen = [...new Set(indices)].filter((i) => i >= 0 && i < snapshot.nAtoms);
  if (chosen.length === 0) return { ops: [], label: "Delete nothing", extraHydrogens: 0 };
  const gone = new Set(chosen);
  const extra: number[] = [];
  const balance = balancesHydrogens(mode, snapshot);
  // Built once: a deletion can take thousands of atoms.
  const table = balance ? neighbourTable(snapshot) : [];
  const neighbours = (i: number) => table[i].map((n) => n.index);
  if (balance) {
    const seen = new Set<number>();
    for (const i of chosen) {
      for (const h of neighbours(i)) {
        if (gone.has(h) || seen.has(h) || snapshot.elements[h] !== 1) continue;
        seen.add(h);
        if (neighbours(h).every((k) => gone.has(k))) extra.push(h);
      }
    }
    extra.forEach((h) => gone.add(h));
  }
  const ops: EditOp[] = [{ op: "delete_atoms", atoms: [...chosen, ...extra].map(refAt) }];
  if (balance) {
    const touched = new Set<number>();
    for (const i of chosen) {
      if (snapshot.elements[i] === 1) continue;
      for (const x of neighbours(i)) if (!gone.has(x)) touched.add(x);
    }
    for (const x of [...touched].sort((a, b) => a - b)) {
      const keep = plannedNeighbours(snapshot, refAt, x, undefined, table[x]).filter(
        (n) => !gone.has(n.index!),
      );
      ops.push(...rebalance(snapshot, refAt, x, keep));
    }
  }
  const what = chosen.length === 1 ? atomName(snapshot, chosen[0]) : `${chosen.length} atoms`;
  return {
    ops,
    label: `Delete ${what}${extra.length > 0 ? ` (+${extra.length} H)` : ""}`,
    extraHydrogens: extra.length,
  };
}

/** The ops of `deleteAtomsEdit`: what every delete path (tool, key, menu, Inspector) pushes. */
export function deleteAtomsOps(
  snapshot: Snapshot,
  refAt: RefAt,
  indices: number[],
  mode: HydrogenMode,
): EditOp[] {
  return deleteAtomsEdit(snapshot, refAt, indices, mode).ops;
}
