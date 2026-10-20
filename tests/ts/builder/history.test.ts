/** The history helpers: when Undo / Redo pause, the undone steps, and a jump to any step. */

import { describe, it, expect } from "vitest";
import { historyLock, jumpToStep, undoneSteps } from "@/builder/history";
import { createBuilderStore, editSteps } from "@/builder/store";
import type { EditOp } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const move = (atom: number): EditOp => ({ op: "move_atoms", atoms: [atom], delta: [1, 0, 0] });

/** Three steps: one move, a pair of moves, one move. */
function store() {
  const api = createBuilderStore();
  api.getState().openStructure(water(), null, "w.xyz");
  api.getState().pushOp(move(0));
  api.getState().pushOps([move(1), move(2)]);
  api.getState().pushOp(move(0));
  return api;
}

const applied = (api: ReturnType<typeof store>) => editSteps(api.getState().edits).length;

describe("historyLock", () => {
  it("pauses while the original is shown or a preview is open", () => {
    expect(historyLock({ preview: null, showOriginal: false })).toBeNull();
    expect(historyLock({ preview: null, showOriginal: true })).toContain("Show original");
    const api = store();
    api.getState().setPreview({ op: "wrap" });
    expect(historyLock(api.getState())).toContain("preview");
  });
});

describe("undoneSteps", () => {
  it("lists what Redo brings back, in order, grouped by step", () => {
    const api = store();
    expect(undoneSteps(api.getState().redoStack)).toEqual([]);
    api.getState().undo();
    api.getState().undo();
    expect(undoneSteps(api.getState().redoStack)).toEqual([[move(1), move(2)], [move(0)]]);
  });
});

describe("jumpToStep", () => {
  it("undoes and redoes whole steps until the history is at the one asked for", () => {
    const api = store();
    expect(jumpToStep(api, 1)).toBe(true);
    expect(applied(api)).toBe(1);
    expect(undoneSteps(api.getState().redoStack)).toHaveLength(2);
    expect(jumpToStep(api, 3)).toBe(true);
    expect(applied(api)).toBe(3);
    // Out of range is clamped; staying put is no move.
    expect(jumpToStep(api, 99)).toBe(false);
    expect(jumpToStep(api, -5)).toBe(true);
    expect(applied(api)).toBe(0);
    expect(jumpToStep(api, 2)).toBe(true);
    expect(api.getState().edits).toEqual([move(0), move(1), move(2)]);
  });

  it("does nothing while the history is paused", () => {
    const api = store();
    api.getState().setShowOriginal(true);
    expect(jumpToStep(api, 0)).toBe(false);
    expect(applied(api)).toBe(3);
  });
});
