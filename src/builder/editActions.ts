/**
 * The Builder's atom and bond edits as user actions, one per thing a user can
 * do (delete atoms, remove a bond, bond two atoms, change elements, add an
 * atom), shared by every place that offers it — the tools in the view, the
 * keyboard, the atom menu and the Inspector — so hydrogens are handled the
 * same way whichever one the user picks. Each plans its ops with
 * `hydrogens.ts` under the document's `HydrogenMode`, pushes them as one Undo
 * step, and labels the step with what the user did ("Delete O #5 (+2 H)").
 *
 * Atoms are rendered indices; each action returns whether it wrote anything.
 */

import { getElementSymbol } from "../constants";
import type { Snapshot } from "../types";
import { canEdit, type BuilderStore } from "./store";
import {
  addFreeAtomOps,
  addOnAtomOps,
  balancesHydrogens,
  bondOps,
  bondOrderBetween,
  deleteAtomsEdit,
  removeBondOps,
  setElementsOps,
} from "./hydrogens";
import { atomName } from "./placement";

type State = BuilderStore;

/** "single", "double", "triple", "aromatic", for bond order 1–4. */
export function bondOrderName(order: number): string {
  return ["", "single", "double", "triple", "aromatic"][order] ?? `order ${order}`;
}

/** The edited structure when clicks may write ops, else null. */
function editable(s: State): Snapshot | null {
  return canEdit(s) ? s.result!.snapshot : null;
}

function valid(snapshot: Snapshot, i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < snapshot.nAtoms;
}

/**
 * Delete atoms `indices`, with the hydrogens that hung only on them and the
 * surviving neighbours rebalanced while hydrogens are kept balanced.
 */
export function deleteAtoms(s: State, indices: number[]): boolean {
  const snapshot = editable(s);
  if (!snapshot) return false;
  const edit = deleteAtomsEdit(snapshot, s.result!.refAt, indices, s.hydrogenMode);
  if (edit.ops.length === 0) return false;
  s.pushOps(edit.ops, edit.label);
  return true;
}

/** Remove the bond between atoms `i` and `j` (rebalancing both). False when they are not bonded. */
export function removeBond(s: State, i: number, j: number): boolean {
  const snapshot = editable(s);
  if (!snapshot || !valid(snapshot, i) || !valid(snapshot, j)) return false;
  if (bondOrderBetween(snapshot, i, j) === 0) return false;
  const balance = balancesHydrogens(s.hydrogenMode, snapshot);
  s.pushOps(
    removeBondOps(snapshot, s.result!.refAt, i, j, balance),
    `Remove bond ${atomName(snapshot, i)} – ${atomName(snapshot, j)}`,
  );
  return true;
}

/**
 * Bond atoms `i` and `j` with `order`, or change an existing bond to it. A
 * bond that already has that order is written as asked (its step changes
 * nothing) and the notice says so.
 */
export function bondAtoms(s: State, i: number, j: number, order: number): boolean {
  const snapshot = editable(s);
  if (!snapshot || i === j || !valid(snapshot, i) || !valid(snapshot, j)) return false;
  const a = atomName(snapshot, i);
  const b = atomName(snapshot, j);
  const current = bondOrderBetween(snapshot, i, j);
  const balance = balancesHydrogens(s.hydrogenMode, snapshot);
  s.pushOps(
    bondOps(snapshot, s.result!.refAt, i, j, order, balance),
    current === 0
      ? `Bond ${a} – ${b}${order !== 1 ? ` (${bondOrderName(order)})` : ""}`
      : `Make ${a} – ${b} ${bondOrderName(order)}`,
  );
  if (current === order) {
    s.reportInfo(`${a} and ${b} already share a ${bondOrderName(order)} bond: nothing changed.`);
  }
  return true;
}

/** Set atoms `indices` to element `z`, rebalancing their hydrogens. */
export function setElements(s: State, indices: number[], z: number): boolean {
  const snapshot = editable(s);
  if (!snapshot) return false;
  const atoms = [...new Set(indices)].filter((i) => valid(snapshot, i));
  if (atoms.length === 0) return false;
  const balance = balancesHydrogens(s.hydrogenMode, snapshot);
  const ops = setElementsOps(snapshot, s.result!.refAt, atoms, z, balance);
  const what = atoms.length === 1 ? atomName(snapshot, atoms[0]) : `${atoms.length} atoms`;
  s.pushOps(ops, `Set ${what} to ${getElementSymbol(z)}`);
  return true;
}

/** The Add tool on atom `i`: a new atom of element `z` bonded to it with `order`. */
export function addOnAtom(s: State, i: number, z: number, order: number): boolean {
  const snapshot = editable(s);
  if (!snapshot || !valid(snapshot, i)) return false;
  const balance = balancesHydrogens(s.hydrogenMode, snapshot);
  const ops = addOnAtomOps(snapshot, s.result!.refAt, i, z, order, balance);
  const sym = getElementSymbol(z);
  const replaces = balance && z !== 1 && snapshot.elements[i] === 1;
  s.pushOps(
    ops,
    replaces
      ? `Replace ${atomName(snapshot, i)} with ${sym}`
      : `Add ${sym} on ${atomName(snapshot, i)}`,
  );
  return true;
}

/** The Add tool on empty space: a free atom of element `z` at `at` (with its hydrogens when balanced). */
export function addFreeAtom(s: State, at: [number, number, number], z: number): boolean {
  const snapshot = editable(s);
  if (!snapshot) return false;
  const balance = balancesHydrogens(s.hydrogenMode, snapshot);
  const ops = addFreeAtomOps(z, at, balance);
  const sym = getElementSymbol(z);
  const h = ops.length - 1;
  s.pushOps(ops, `Add ${sym}${h > 0 ? ` (+${h} H)` : ""}`);
  return true;
}
