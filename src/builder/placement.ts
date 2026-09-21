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

/**
 * Where an adsorbate's centroid goes for a click on surface atom `site`:
 * `height` Å above it along the cell's c axis (the slab normal), or along +z
 * when there is no cell.
 */
export function adsorptionSite(
  snapshot: Snapshot,
  site: number,
  height: number,
): [number, number, number] {
  let nx = 0;
  let ny = 0;
  let nz = 1;
  const b = snapshot.box;
  if (b) {
    const len = Math.hypot(b[6], b[7], b[8]);
    if (len > 1e-6) {
      nx = b[6] / len;
      ny = b[7] / len;
      nz = b[8] / len;
    }
  }
  return [
    snapshot.positions[site * 3] + nx * height,
    snapshot.positions[site * 3 + 1] + ny * height,
    snapshot.positions[site * 3 + 2] + nz * height,
  ];
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
      return `Add ${op.id} (${op.elements.length} atom${op.elements.length === 1 ? "" : "s"})`;
    case "set_cell":
      return op.box ? (op.scaleAtoms ? "Set cell (atoms scaled)" : "Set cell") : "Remove cell";
    case "supercell": {
      const m = op.matrix;
      const diagonal = m.length === 9 && [1, 2, 3, 5, 6, 7].every((k) => m[k] === 0);
      return diagonal ? `Supercell ${m[0]}×${m[4]}×${m[8]}` : `Supercell [${m.join(" ")}]`;
    }
    case "slab":
      return `Slab (${op.miller.join(" ")}), ${op.layers} layer${op.layers === 1 ? "" : "s"}, ${op.vacuum} Å vacuum${op.shift ? `, shift ${op.shift}` : ""}`;
    case "expand_symmetry":
      return "Expand symmetry";
    case "wrap":
      return "Wrap atoms into cell";
    case "center": {
      const axes = (op.axes ?? [0, 1, 2]).map((a) => "abc"[a] ?? "?").join("");
      return `Center along ${axes}${op.vacuum !== null && op.vacuum !== undefined ? ` with ${op.vacuum} Å vacuum` : ""}`;
    }
    default:
      return String((op as { op: unknown }).op);
  }
}
