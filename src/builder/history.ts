/**
 * The history as the History panel and the Undo / Redo controls see it:
 * whether Undo and Redo may run now (`historyLock`), the steps Redo would
 * bring back (`undoneSteps`), and a jump to any step of the list
 * (`jumpToStep`), done with the store's own Undo and Redo so each step moves
 * exactly as it would one press at a time.
 */

import type { StoreApi } from "zustand";
import type { EditOp } from "../pipeline/types";
import { editSteps, type BuilderStore } from "./store";

/**
 * Why Undo and Redo are paused, or null when they are not: while the
 * original is shown the edits are out of sight, and while a Structure dialog
 * previews an op an Undo would silently drop the preview.
 */
export function historyLock(s: Pick<BuilderStore, "preview" | "showOriginal">): string | null {
  if (s.showOriginal) return "Paused while Show original is on: turn it off to undo or redo";
  if (s.preview) return "Paused while a preview is open: Apply or Cancel it first";
  return null;
}

/** The undone steps, in the order Redo brings them back. */
export function undoneSteps(redoStack: EditOp[]): EditOp[][] {
  return editSteps(redoStack.slice().reverse());
}

/**
 * Undo or redo until `target` steps are applied (0 is the structure as
 * opened; the list's last undone step is the most). Returns whether the
 * history moved; nothing moves while `historyLock` holds.
 */
export function jumpToStep(api: StoreApi<BuilderStore>, target: number): boolean {
  const s = api.getState();
  if (historyLock(s)) return false;
  let applied = editSteps(s.edits).length;
  const goal = Math.max(0, Math.min(target, applied + undoneSteps(s.redoStack).length));
  const start = applied;
  while (applied > goal && api.getState().undo() !== null) applied--;
  while (applied < goal && api.getState().redo() !== null) applied++;
  return applied !== start;
}
