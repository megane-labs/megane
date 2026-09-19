import { describe, it, expect, beforeEach } from "vitest";
import {
  useBuilderStore,
  createBuilderStore,
  emptyCellSnapshot,
  shownSnapshot,
  canEdit,
  UNTITLED,
} from "@/builder/store";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const s = () => useBuilderStore.getState();

describe("useBuilderStore — document", () => {
  beforeEach(() => {
    useBuilderStore.setState({
      source: null,
      sourceLabels: null,
      fileName: null,
      edits: [],
      redoStack: [],
      showOriginal: false,
      result: null,
      revision: 0,
      tool: "select",
      element: 6,
      bondOrder: 1,
      selected: [],
      pendingBondAtom: null,
    });
  });

  it("starts empty: nothing shown, nothing editable", () => {
    expect(shownSnapshot(s())).toBeNull();
    expect(canEdit(s())).toBe(false);
    expect(s().undo()).toBeNull();
    expect(s().redo()).toBeNull();
  });

  it("opens a structure as the source with a fresh history", () => {
    s().pushOp({ op: "delete_atoms", atoms: [0] }); // no source: ignored by canEdit, but harmless
    s().openStructure(water(), ["HOH", "HOH", "HOH"], "water.pdb");
    expect(s().fileName).toBe("water.pdb");
    expect(s().sourceLabels).toEqual(["HOH", "HOH", "HOH"]);
    expect(s().edits).toEqual([]);
    expect(s().redoStack).toEqual([]);
    expect(s().result!.snapshot.nAtoms).toBe(3);
    expect(shownSnapshot(s())!.nAtoms).toBe(3);
    expect(canEdit(s())).toBe(true);
  });

  it("newCell starts from an atom-less cubic cell named untitled", () => {
    s().newCell(12);
    expect(s().fileName).toBe(UNTITLED);
    expect(s().source!.nAtoms).toBe(0);
    expect(Array.from(s().source!.box!)).toEqual([12, 0, 0, 0, 12, 0, 0, 0, 12]);
    expect(shownSnapshot(s())!.nAtoms).toBe(0);
  });

  it("pushOp replays the history on the source, bumps the revision and clears redo", () => {
    s().openStructure(water(), null, "w.xyz");
    const rev = s().revision;
    s().pushOp({ op: "delete_atoms", atoms: [1] });
    expect(shownSnapshot(s())!.nAtoms).toBe(2);
    expect(s().source!.nAtoms).toBe(3); // the source is never mutated
    expect(s().revision).toBe(rev + 1);
    s().undo();
    expect(s().redoStack).toHaveLength(1);
    s().pushOp({ op: "add_atom", id: "c", element: 6, position: [5, 5, 5] });
    expect(s().redoStack).toEqual([]);
    expect(shownSnapshot(s())!.nAtoms).toBe(4);
  });

  it("undo / redo move ops between the two stacks and reapply", () => {
    s().openStructure(water(), null, "w.xyz");
    s().pushOp({ op: "delete_atoms", atoms: [1] });
    s().pushOp({ op: "set_element", atoms: [0], element: 7 });
    s().setSelected([0]);
    expect(s().undo()).toEqual({ op: "set_element", atoms: [0], element: 7 });
    expect(s().selected).toEqual([]);
    expect(s().edits).toHaveLength(1);
    expect(shownSnapshot(s())!.elements[0]).toBe(8);
    expect(s().redo()).toEqual({ op: "set_element", atoms: [0], element: 7 });
    expect(shownSnapshot(s())!.elements[0]).toBe(7);
    expect(s().redoStack).toEqual([]);
    expect(s().redo()).toBeNull();
  });

  it("replaceLastOp rewrites the tail (a drag in progress) and is a no-op on an empty history", () => {
    s().openStructure(water(), null, "w.xyz");
    const rev = s().revision;
    s().replaceLastOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    expect(s().edits).toEqual([]);
    expect(s().revision).toBe(rev);
    s().pushOp({ op: "move_atoms", atoms: [0], delta: [0, 0, 0] });
    s().replaceLastOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    expect(s().edits).toHaveLength(1);
    expect(shownSnapshot(s())!.positions[0]).toBeCloseTo(1);
  });

  it("clearOps drops the whole history and the redo stack", () => {
    s().openStructure(water(), null, "w.xyz");
    s().pushOp({ op: "delete_atoms", atoms: [1] });
    s().undo();
    s().pushOp({ op: "delete_atoms", atoms: [2] });
    s().clearOps();
    expect(s().edits).toEqual([]);
    expect(s().redoStack).toEqual([]);
    expect(shownSnapshot(s())!.nAtoms).toBe(3);
    const rev = s().revision;
    s().clearOps();
    expect(s().revision).toBe(rev);
  });

  it("Show original previews the source and pauses editing", () => {
    s().openStructure(water(), null, "w.xyz");
    s().pushOp({ op: "delete_atoms", atoms: [1] });
    s().setShowOriginal(true);
    expect(shownSnapshot(s())!.nAtoms).toBe(3);
    expect(canEdit(s())).toBe(false);
    expect(s().edits).toHaveLength(1);
    const rev = s().revision;
    s().setShowOriginal(true);
    expect(s().revision).toBe(rev);
    s().setShowOriginal(false);
    expect(shownSnapshot(s())!.nAtoms).toBe(2);
    expect(canEdit(s())).toBe(true);
  });

  it("reports ops that could not be applied as warnings", () => {
    s().openStructure(water(), null, "w.xyz");
    s().pushOp({ op: "delete_atoms", atoms: [99] });
    expect(s().result!.warnings[0]).toContain("unknown atom 99");
    expect(shownSnapshot(s())!.nAtoms).toBe(3);
  });
});

describe("useBuilderStore — tools", () => {
  beforeEach(() => {
    useBuilderStore.setState({
      tool: "select",
      element: 6,
      bondOrder: 1,
      selected: [],
      pendingBondAtom: null,
      handlers: null,
    });
  });

  it("switching tools clears a half-finished bond", () => {
    s().setPendingBondAtom(4);
    s().setTool("add");
    expect(s().tool).toBe("add");
    expect(s().pendingBondAtom).toBeNull();
  });

  it("manages the selection as a set", () => {
    s().setSelected([1, 1, 2]);
    expect(s().selected).toEqual([1, 2]);
    s().toggleSelected(2);
    expect(s().selected).toEqual([1]);
    s().toggleSelected(5);
    expect(s().selected).toEqual([1, 5]);
    s().setPendingBondAtom(1);
    s().clearSelected();
    expect(s().selected).toEqual([]);
    expect(s().pendingBondAtom).toBeNull();
  });

  it("sets element, bond order and handlers", () => {
    s().setElement(8);
    s().setBondOrder(2);
    const handlers = { pick() {}, dragStart: () => false, dragMove() {}, dragEnd() {} };
    s().setHandlers(handlers);
    expect(s().element).toBe(8);
    expect(s().bondOrder).toBe(2);
    expect(s().handlers).toBe(handlers);
  });
});

describe("createBuilderStore / emptyCellSnapshot", () => {
  it("makes an independent store", () => {
    const a = createBuilderStore();
    a.getState().newCell(8);
    expect(a.getState().source!.box![0]).toBe(8);
    expect(useBuilderStore.getState().source?.box?.[0]).not.toBe(8);
  });

  it("never produces a degenerate cell", () => {
    expect(emptyCellSnapshot(0).box![0]).toBeGreaterThan(0);
    expect(emptyCellSnapshot(-5).box![4]).toBeGreaterThan(0);
  });
});

describe("useBuilderStore — library placement", () => {
  const molecule = {
    id: "preset:test",
    name: "Test mol",
    formula: "C2",
    origin: "preset" as const,
    elements: [6, 6],
    positions: [-0.7, 0, 0, 0.7, 0, 0],
    bonds: [[0, 1]] as [number, number][],
    bondOrders: [3],
  };

  beforeEach(() => {
    useBuilderStore.setState({
      source: null,
      result: null,
      edits: [],
      redoStack: [],
      showOriginal: false,
      tool: "select",
      selected: [],
      pendingBondAtom: null,
      placeSource: null,
    });
  });

  it("choosing a place source switches to the Place tool; clearing it falls back to Select", () => {
    s().setPendingBondAtom(2);
    s().setPlaceSource(molecule);
    expect(s().tool).toBe("place");
    expect(s().placeSource).toBe(molecule);
    expect(s().pendingBondAtom).toBeNull();
    s().setPlaceSource(null);
    expect(s().tool).toBe("select");
    expect(s().placeSource).toBeNull();
    s().setTool("add");
    s().setPlaceSource(molecule);
    s().setTool("bond");
    s().setPlaceSource(null);
    expect(s().tool).toBe("bond");
  });

  it("addFragment appends one add_fragment op with the centroid at the point and selects the new atoms", () => {
    expect(s().addFragment(molecule, [1, 2, 3])).toBeNull();
    s().openStructure(water(), null, "w.xyz");
    const id = s().addFragment(molecule, [10, 0, 0]);
    expect(id).toMatch(/^test-mol-\d+$/);
    expect(s().edits).toHaveLength(1);
    expect(s().edits[0]).toMatchObject({
      op: "add_fragment",
      id,
      elements: [6, 6],
      bonds: [[0, 1]],
      bondOrders: [3],
      translate: [10, 0, 0],
    });
    const shown = shownSnapshot(s())!;
    expect(shown.nAtoms).toBe(5);
    expect(shown.nBonds).toBe(3);
    expect(shown.positions[9]).toBeCloseTo(9.3);
    expect(shown.positions[12]).toBeCloseTo(10.7);
    expect(s().selected).toEqual([3, 4]);
    // Not editable under the preview.
    s().setShowOriginal(true);
    expect(s().addFragment(molecule, [0, 0, 0])).toBeNull();
    expect(s().edits).toHaveLength(1);
  });
});
