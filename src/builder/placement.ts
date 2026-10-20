/**
 * Geometry and wording helpers for the Builder: where a new atom goes, what
 * id it gets, and how an op reads in the history list.
 */

import { getCovalentRadius, getElementSymbol } from "../constants";
import type { EditAtomRef, EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";
import { bondDirections } from "./geometry";

type Vec3 = [number, number, number];

let nextAtomSerial = 1;

/** Fresh id for an atom created in the Builder. Unique within the page. */
export function newAtomId(): string {
  return `a${Date.now().toString(36)}-${nextAtomSerial++}`;
}

/** What a bond of order `order` counts for in valence sums: aromatic (4) is 1.5. */
export function bondValence(order: number): number {
  return order === 4 ? 1.5 : order;
}

/** Room (Å) around a new atom past which no other atom is in its way. */
const CLEAR = 3.2;

/** Smallest angle (as a cosine) a new bond may make with an existing one: 60°. */
const MAX_COS_TO_EXISTING = 0.5;

/**
 * Position for a new atom bonded to `anchor` (rendered index) with a bond of
 * order `order`: one bond length (sum of covalent radii) away, in a free
 * direction of the anchor's ideal geometry (tetrahedral, trigonal or linear,
 * from the multiple bonds it will carry, see `bondDirections`). Of the free
 * directions, the one whose atom would sit farthest from every other atom is
 * taken, so the new atom does not land on a non-bonded neighbour either.
 * With no neighbours it goes along +x.
 */
export function placeBondedAtom(
  snapshot: Snapshot,
  anchor: number,
  newElement: number,
  order = 1,
): [number, number, number] {
  const ax = snapshot.positions[anchor * 3];
  const ay = snapshot.positions[anchor * 3 + 1];
  const az = snapshot.positions[anchor * 3 + 2];
  const existing: Vec3[] = [];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let multiple = Math.max(0, bondValence(order) - 1);
  for (let b = 0; b < snapshot.nBonds; b++) {
    const i = snapshot.bonds[b * 2];
    const j = snapshot.bonds[b * 2 + 1];
    const other = i === anchor ? j : j === anchor ? i : -1;
    if (other < 0) continue;
    const d: Vec3 = [
      snapshot.positions[other * 3] - ax,
      snapshot.positions[other * 3 + 1] - ay,
      snapshot.positions[other * 3 + 2] - az,
    ];
    sx += d[0];
    sy += d[1];
    sz += d[2];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len > 1e-6) existing.push([d[0] / len, d[1] / len, d[2] / len]);
    const bo = snapshot.bondOrders ? snapshot.bondOrders[b] || 1 : 1;
    multiple += Math.max(0, bondValence(bo) - 1);
  }
  // The ideal directions that are free, and not crowding an existing bond.
  const candidates = bondDirections(existing, Math.round(4 - multiple), 4).filter((c) =>
    existing.every((e) => c[0] * e[0] + c[1] * e[1] + c[2] * e[2] < MAX_COS_TO_EXISTING),
  );
  if (candidates.length === 0) {
    // A full (or odd) shell: away from the neighbours if that is a direction,
    // else whichever axis has the most room.
    const len = Math.hypot(sx, sy, sz);
    if (len > 1e-6) candidates.push([-sx / len, -sy / len, -sz / len]);
    else candidates.push([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]);
  }
  const length = getCovalentRadius(snapshot.elements[anchor]) + getCovalentRadius(newElement);
  let best: [number, number, number] | null = null;
  let bestRoom = -Infinity;
  for (const c of candidates) {
    const p: [number, number, number] = [
      ax + c[0] * length,
      ay + c[1] * length,
      az + c[2] * length,
    ];
    let room = Infinity;
    for (let k = 0; k < snapshot.nAtoms; k++) {
      if (k === anchor) continue;
      const dx = snapshot.positions[k * 3] - p[0];
      const dy = snapshot.positions[k * 3 + 1] - p[1];
      const dz = snapshot.positions[k * 3 + 2] - p[2];
      room = Math.min(room, dx * dx + dy * dy + dz * dz);
    }
    // Past `CLEAR` Å every direction is as good: the first (the polyhedron's
    // own order) wins unless another one has more room below that.
    room = Math.min(room, CLEAR * CLEAR);
    if (room > bestRoom + 1e-6) {
      best = p;
      bestRoom = room;
    }
  }
  return best!;
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

/** `El #i`: how an atom is named everywhere (the Inspector, the atom menu, the history). */
export function atomName(snapshot: Snapshot, i: number): string {
  return `${getElementSymbol(snapshot.elements[i])} #${i}`;
}

/**
 * What the user did, per Undo step, keyed by the step's first op: "Add C on
 * C #3" rather than the raw op. Keyed by op identity, so a label follows its
 * step through undo and redo and the op list itself stays plain `EditOp`s.
 */
const stepLabels = new WeakMap<EditOp, string>();

/** Record `label` as the description of the step that starts with `ops[0]`. */
export function labelStep(ops: readonly EditOp[], label: string | undefined): void {
  if (ops.length > 0 && label) stepLabels.set(ops[0], label);
}

/** The label recorded for the step starting with `op`, if any. */
export function stepLabelOf(op: EditOp): string | undefined {
  return stepLabels.get(op);
}

/**
 * One-line description of an Undo step (`editSteps`) for the history list:
 * the label the action that wrote it recorded (`labelStep`), else the op
 * itself, "Move N atoms" for a group of moves, or the first op and how many
 * came with it.
 */
export function describeStep(step: EditOp[]): string {
  const label = step.length > 0 ? stepLabels.get(step[0]) : undefined;
  if (label) return label;
  if (step.length === 1) return describeOp(step[0]);
  if (step.every((op) => op.op === "move_atoms")) {
    const n = step.reduce((sum, op) => sum + (op.op === "move_atoms" ? op.atoms.length : 0), 0);
    return `Move ${n} atom${n === 1 ? "" : "s"}`;
  }
  return `${describeOp(step[0])} + ${step.length - 1} more`;
}

/** One-line description of an op for the history list. */
export function describeOp(op: EditOp): string {
  // An atom the edits created is named by an internal id; never show it.
  const ref = (r: EditAtomRef) => (typeof r === "number" ? `#${r}` : "an added atom");
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
