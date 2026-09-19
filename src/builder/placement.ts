/**
 * Geometry and wording helpers for the Builder: where a new atom goes, what
 * id it gets, and how an op reads in the history list.
 */

import { getCovalentRadius, getElementSymbol } from "../constants";
import type { EditAtomRef, EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";

let nextAtomSerial = 1;

/** Fresh id for an atom created in the Builder. Unique within the page. */
export function newAtomId(): string {
  return `a${Date.now().toString(36)}-${nextAtomSerial++}`;
}

/**
 * Position for a new atom bonded to `anchor` (rendered index): one bond length
 * (sum of covalent radii) away, pointing away from the anchor's existing
 * neighbours so the new atom does not land on top of one. With no neighbours
 * it goes along +x.
 */
export function placeBondedAtom(
  snapshot: Snapshot,
  anchor: number,
  newElement: number,
): [number, number, number] {
  const ax = snapshot.positions[anchor * 3];
  const ay = snapshot.positions[anchor * 3 + 1];
  const az = snapshot.positions[anchor * 3 + 2];
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let n = 0;
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = snapshot.bonds[b * 2];
    const j = snapshot.bonds[b * 2 + 1];
    const other = i === anchor ? j : j === anchor ? i : -1;
    if (other < 0) continue;
    dx += snapshot.positions[other * 3] - ax;
    dy += snapshot.positions[other * 3 + 1] - ay;
    dz += snapshot.positions[other * 3 + 2] - az;
    n++;
  }
  let ux: number;
  let uy: number;
  let uz: number;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (n === 0 || len < 1e-6) {
    // No (or perfectly balanced) neighbours: pick +x, or +y when +x is taken.
    ux = 1;
    uy = 0;
    uz = 0;
    if (n > 0) {
      ux = 0;
      uy = 1;
    }
  } else {
    ux = -dx / len;
    uy = -dy / len;
    uz = -dz / len;
  }
  const length = getCovalentRadius(snapshot.elements[anchor]) + getCovalentRadius(newElement);
  return [ax + ux * length, ay + uy * length, az + uz * length];
}

/** One-line description of an op for the history list. */
export function describeOp(op: EditOp): string {
  const ref = (r: EditAtomRef) => (typeof r === "number" ? `#${r}` : r);
  switch (op.op) {
    case "add_atom":
      return `Add ${getElementSymbol(op.element)}${op.bondTo !== undefined ? ` bonded to ${ref(op.bondTo)}` : ""}`;
    case "delete_atoms":
      return `Delete ${op.atoms.length} atom${op.atoms.length === 1 ? "" : "s"}`;
    case "move_atoms":
      return `Move ${op.atoms.length} atom${op.atoms.length === 1 ? "" : "s"} by (${op.delta.map((d) => d.toFixed(2)).join(", ")}) Å`;
    case "set_element":
      return `Set ${op.atoms.length} atom${op.atoms.length === 1 ? "" : "s"} to ${getElementSymbol(op.element)}`;
    case "add_bond":
      return `Bond ${ref(op.a)} – ${ref(op.b)}${op.order && op.order !== 1 ? ` (order ${op.order})` : ""}`;
    case "delete_bond":
      return `Remove bond ${ref(op.a)} – ${ref(op.b)}`;
    case "add_fragment":
      return `Add fragment "${op.id}" (${op.elements.length} atoms)`;
    case "set_cell":
      return op.box ? "Set cell" : "Remove cell";
    default:
      return String((op as { op: unknown }).op);
  }
}
