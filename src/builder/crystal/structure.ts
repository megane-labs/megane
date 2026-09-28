/**
 * What the Structure menu and the symmetry offer need to know about the
 * open document: whether it has a cell, and whether the file's symmetry
 * operations can still be expanded. Pure, so the menu, the offer and the
 * forms agree on it.
 */

import type { EditOp } from "../../pipeline/types";
import type { Snapshot } from "../../types";
import { det3 } from "../../crystal/cell";

/** Whether `box` is a real cell (three non-coplanar vectors). */
export function hasCellBox(box: Float32Array | null | undefined): boolean {
  return !!box && Math.abs(det3(box)) > 1e-9;
}

/**
 * How many space-group operations of the source can still be applied, or 0.
 * A CIF's operations apply once: expanding them, or any edit that rebuilds
 * the cell (supercell, slab, a new cell, centring with vacuum), consumes them.
 */
export function symmetryOpsAvailable(source: Snapshot | null, edits: EditOp[]): number {
  const n = source?.symmetryOps?.length ?? 0;
  if (n === 0) return 0;
  const consumed = edits.some(
    (op) =>
      op.op === "expand_symmetry" ||
      op.op === "supercell" ||
      op.op === "slab" ||
      op.op === "set_cell" ||
      (op.op === "center" && op.vacuum !== null && op.vacuum !== undefined),
  );
  return consumed ? 0 : n;
}
