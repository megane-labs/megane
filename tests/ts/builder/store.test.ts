import { describe, it, expect, beforeEach } from "vitest";
import {
  useBuilderStore,
  createBuilderStore,
  emptyCellSnapshot,
  shownSnapshot,
  viewSnapshot,
  canEdit,
  confirmDiscard,
  editedLabels,
  isDirty,
  UNTITLED,
  editSteps,
  remapSelection,
  applyMoves,
} from "@/builder/store";
import { describeStep } from "@/builder/placement";
import { applyEditOps } from "@/pipeline/executors/edit";
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
      preview: null,
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
    // The selection follows its atoms through the history.
    expect(s().selected).toEqual([0]);
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

  it("clearOps undoes every step, and Redo brings them back one by one", () => {
    s().openStructure(water(), null, "w.xyz");
    s().pushOp({ op: "delete_atoms", atoms: [1] });
    s().pushOps([
      { op: "set_element", atoms: [0], element: 16 },
      { op: "set_element", atoms: [2], element: 9 },
    ]);
    s().clearOps();
    expect(s().edits).toEqual([]);
    expect(s().redoStack).toHaveLength(3);
    expect(shownSnapshot(s())!.nAtoms).toBe(3);
    const rev = s().revision;
    s().clearOps();
    expect(s().revision).toBe(rev);
    // The first step comes back first, the two-op group as one step.
    s().redo();
    expect(s().edits).toEqual([{ op: "delete_atoms", atoms: [1] }]);
    s().redo();
    expect(s().edits).toHaveLength(3);
    expect(s().redoStack).toEqual([]);
  });

  it("undo, redo and clear leave the edits alone while the original is shown", () => {
    s().openStructure(water(), null, "w.xyz");
    s().pushOp({ op: "delete_atoms", atoms: [1] });
    s().pushOp({ op: "delete_atoms", atoms: [0] });
    s().undo();
    s().setShowOriginal(true);
    expect(s().undo()).toBeNull();
    expect(s().redo()).toBeNull();
    s().clearOps();
    expect(s().edits).toHaveLength(1);
    expect(s().redoStack).toHaveLength(1);
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

describe("useBuilderStore — preview", () => {
  const cell = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);
  const supercell = { op: "supercell" as const, id: "p", matrix: [2, 0, 0, 0, 1, 0, 0, 0, 1] };

  beforeEach(() => {
    useBuilderStore.setState(useBuilderStore.getInitialState(), true);
    s().openStructure({ ...water(), box: cell }, null, "w.xyz");
  });

  it("shows an op applied without committing it, and pauses editing", () => {
    const rev = s().revision;
    s().setSelected([1]);
    s().setPreview(supercell);
    expect(s().preview!.snapshot.nAtoms).toBe(6);
    expect(viewSnapshot(s())!.nAtoms).toBe(6);
    // The document is untouched; the view keeps its camera; the selection goes.
    expect(shownSnapshot(s())!.nAtoms).toBe(3);
    expect(s().edits).toEqual([]);
    expect(s().revision).toBe(rev + 1);
    expect(s().selected).toEqual([]);
    expect(canEdit(s())).toBe(false);
    s().setPreview(null);
    expect(s().preview).toBeNull();
    expect(viewSnapshot(s())!.nAtoms).toBe(3);
    expect(canEdit(s())).toBe(true);
    // Clearing an absent preview changes nothing.
    const again = s().revision;
    s().setPreview(null);
    expect(s().revision).toBe(again);
  });

  it("any change to the document drops the preview", () => {
    const drops: [string, () => void][] = [
      ["pushOp", () => s().pushOp({ op: "wrap" })],
      ["pushOps", () => s().pushOps([{ op: "wrap" }])],
      ["undo", () => s().undo()],
      ["redo", () => s().redo()],
      ["replaceLastOp", () => s().replaceLastOp({ op: "wrap" })],
      ["clearOps", () => s().clearOps()],
      ["setShowOriginal", () => s().setShowOriginal(true)],
      ["openStructure", () => s().openStructure(water(), null, "x.xyz")],
    ];
    for (const [name, change] of drops) {
      useBuilderStore.setState(useBuilderStore.getInitialState(), true);
      s().openStructure({ ...water(), box: cell }, null, "w.xyz");
      s().pushOp({ op: "wrap" });
      s().undo(); // one op on each stack, so undo, redo and clear all act
      s().pushOp({ op: "wrap" });
      s().pushOp({ op: "wrap" });
      s().undo();
      s().setPreview(supercell);
      expect(s().preview, name).not.toBeNull();
      change();
      expect(s().preview, name).toBeNull();
    }
  });

  it("shows nothing without a document, while the original is shown, or for an op that throws", () => {
    s().setShowOriginal(true);
    s().setPreview(supercell);
    expect(s().preview).toBeNull();
    s().setShowOriginal(false);
    // A preview left over while the original is shown is not what the view draws.
    s().setPreview(supercell);
    useBuilderStore.setState({ showOriginal: true });
    expect(viewSnapshot(s())!.nAtoms).toBe(3);
    useBuilderStore.setState(useBuilderStore.getInitialState(), true);
    s().setPreview(supercell);
    expect(s().preview).toBeNull();
    s().openStructure({ ...water(), box: cell }, null, "w.xyz");
    s().setPreview({ op: "slab" } as never);
    expect(s().preview).toBeNull();
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

  it("newBulk starts a bulk crystal document named after it; a bad spec throws and keeps the document", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 3.61, cubic: true });
    expect(s().fileName).toBe("Cu-fcc");
    expect(s().result!.snapshot.nAtoms).toBe(4);
    expect(s().edits).toEqual([]);
    expect(() => s().newBulk({ structure: "fcc", elements: [29], a: -1 })).toThrow();
    expect(s().fileName).toBe("Cu-fcc");
  });

  it("setAdsorbHeight keeps only finite heights", () => {
    s().setAdsorbHeight(2.5);
    expect(s().adsorbHeight).toBe(2.5);
    s().setAdsorbHeight(Number.NaN);
    expect(s().adsorbHeight).toBeNull();
    s().setAdsorbHeight(1);
    s().setAdsorbHeight(null);
    expect(s().adsorbHeight).toBeNull();
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

  it("addFragment with nothing open starts an untitled document without a cell", () => {
    expect(s().source).toBeNull();
    expect(s().addFragment(molecule, [1, 2, 3])).toMatch(/^test-mol-\d+$/);
    expect(s().fileName).toBe("untitled");
    expect(s().source!.box).toBeNull();
    expect(shownSnapshot(s())!.nAtoms).toBe(2);
    expect(s().edits).toHaveLength(1);
  });
});

describe("useBuilderStore — unsaved edits and confirmation", () => {
  it("is dirty from the first edit until saved or replaced", () => {
    const api = createBuilderStore();
    const g = () => api.getState();
    expect(isDirty(g())).toBe(false);
    g().openStructure(water(), null, "w.xyz");
    expect(isDirty(g())).toBe(false);
    g().pushOp({ op: "delete_atoms", atoms: [1] });
    expect(isDirty(g())).toBe(true);
    g().markSaved();
    expect(isDirty(g())).toBe(false);
    g().undo();
    expect(isDirty(g())).toBe(true);
    g().redo();
    g().replaceLastOp({ op: "delete_atoms", atoms: [2] });
    g().setDragOps(1, []);
    g().clearOps();
    expect(isDirty(g())).toBe(true);
    g().openStructure(water(), null, "x.xyz");
    expect(isDirty(g())).toBe(false);
    g().pushOp({ op: "delete_atoms", atoms: [1] });
    g().closeDocument();
    expect(isDirty(g())).toBe(false);
  });

  it("confirmDiscard goes ahead at once with nothing unsaved", async () => {
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "w.xyz");
    await expect(confirmDiscard(api, "Open b.pdb")).resolves.toBe(true);
    expect(api.getState().confirm).toBeNull();
  });

  it("confirmDiscard asks, naming the action, the file and the edits", async () => {
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "w.xyz");
    api.getState().pushOp({ op: "delete_atoms", atoms: [1] });
    const answer = confirmDiscard(api, "Open b.pdb");
    const asked = api.getState().confirm!;
    expect(asked.message).toContain("Open b.pdb");
    expect(asked.message).toContain("w.xyz");
    expect(asked.message).toContain("1 edit");
    expect(asked.danger).toBe(true);
    api.getState().resolveConfirm(false);
    await expect(answer).resolves.toBe(false);
    expect(api.getState().confirm).toBeNull();

    api.getState().pushOp({ op: "delete_atoms", atoms: [1] });
    const again = confirmDiscard(api, "New empty cell");
    expect(api.getState().confirm!.message).toContain("2 edits");
    api.getState().resolveConfirm(true);
    await expect(again).resolves.toBe(true);
  });

  it("a second question answers the first one no", async () => {
    const api = createBuilderStore();
    const first = api.getState().requestConfirm({ title: "A", message: "a", confirmLabel: "Go" });
    const second = api.getState().requestConfirm({ title: "B", message: "b", confirmLabel: "Go" });
    await expect(first).resolves.toBe(false);
    expect(api.getState().confirm!.title).toBe("B");
    api.getState().resolveConfirm(true);
    await expect(second).resolves.toBe(true);
    // Answering with nothing open is harmless.
    api.getState().resolveConfirm(true);
  });

  it("a new edit clears an error notice but keeps an info one", () => {
    const api = createBuilderStore();
    const g = () => api.getState();
    g().openStructure(water(), null, "w.xyz");
    g().reportError("A distance must be a positive number of Å.");
    g().pushOp({ op: "delete_atoms", atoms: [1] });
    expect(g().notice).toBeNull();
    g().reportInfo("Saved w.xyz");
    g().pushOps([{ op: "delete_atoms", atoms: [0] }]);
    expect(g().notice?.level).toBe("info");
    g().reportError("bad");
    g().setDragOps(g().edits.length, [{ op: "delete_atoms", atoms: [0] }]);
    expect(g().notice).toBeNull();
  });

  it("keeps the hydrogen mode the user picks", () => {
    const api = createBuilderStore();
    expect(api.getState().hydrogenMode).toBe("auto");
    api.getState().setHydrogenMode("off");
    expect(api.getState().hydrogenMode).toBe("off");
  });
});

describe("editedLabels", () => {
  it("follows each atom's label through deletions and leaves added atoms unlabelled", () => {
    const api = createBuilderStore();
    const g = () => api.getState();
    expect(editedLabels(g())).toBeNull();
    g().openStructure(water(), ["HOH1", "HOH2", "HOH3"], "w.pdb");
    expect(editedLabels(g())).toEqual(["HOH1", "HOH2", "HOH3"]);
    g().pushOp({ op: "delete_atoms", atoms: [1] });
    g().pushOp({ op: "add_atom", id: "n1", element: 6, position: [1, 1, 1] });
    expect(editedLabels(g())).toEqual(["HOH1", "HOH3", ""]);
  });

  it("is null without source labels", () => {
    const api = createBuilderStore();
    api.getState().openStructure(water(), null, "w.xyz");
    expect(editedLabels(api.getState())).toBeNull();
  });
});

describe("useBuilderStore — the selection follows its atoms", () => {
  const api = () => {
    const store = createBuilderStore();
    store.getState().openStructure(water(), null, "w.xyz");
    return store;
  };

  it("shifts past a deletion, drops deleted atoms, and keeps the picking order", () => {
    const store = api();
    const g = () => store.getState();
    g().setSelected([2, 0, 1]);
    g().setPendingBondAtom(2);
    g().pushOp({ op: "delete_atoms", atoms: [1] });
    expect(g().selected).toEqual([1, 0]);
    expect(g().pendingBondAtom).toBe(1);
    // Undo brings the atom back; it was dropped from the selection, the rest move back.
    g().undo();
    expect(g().selected).toEqual([2, 0]);
    g().redo();
    expect(g().selected).toEqual([1, 0]);
    g().pushOps([{ op: "delete_atoms", atoms: [2] }]);
    expect(g().selected).toEqual([0]);
    expect(g().pendingBondAtom).toBeNull();
  });

  it("an added atom stays selected through redo, and leaves with clear all", () => {
    const store = api();
    const g = () => store.getState();
    g().pushOp({ op: "add_atom", id: "n", element: 6, position: [3, 0, 0] });
    g().setSelected([3, 0]);
    g().undo();
    expect(g().selected).toEqual([0]);
    g().redo();
    g().setSelected([3, 0]);
    g().replaceLastOp({ op: "add_atom", id: "m", element: 6, position: [3, 0, 0] });
    // A different atom now: "n" is gone.
    expect(g().selected).toEqual([0]);
    g().setSelected([3]);
    g().clearOps();
    expect(g().selected).toEqual([]);
  });

  it("remapSelection handles no change, no document and stale indices", () => {
    const r = applyEditOps(water(), []);
    const sel = { selected: [0], pendingBondAtom: null };
    expect(remapSelection(r, r, sel)).toEqual(sel);
    expect(remapSelection(r, null, sel)).toEqual({ selected: [], pendingBondAtom: null });
    const after = applyEditOps(water(), [{ op: "delete_atoms", atoms: [0] }]);
    expect(remapSelection(r, after, { selected: [9, 1], pendingBondAtom: 9 })).toEqual({
      selected: [0],
      pendingBondAtom: null,
    });
    expect(remapSelection(r, after, { selected: [], pendingBondAtom: null })).toEqual({
      selected: [],
      pendingBondAtom: null,
    });
  });
});

describe("useBuilderStore — history labels", () => {
  it("lists a labelled step by its label, through undo and redo", () => {
    const store = createBuilderStore();
    const g = () => store.getState();
    g().openStructure(water(), null, "w.xyz");
    g().pushOps(
      [
        { op: "set_element", atoms: [0], element: 7 },
        { op: "add_atom", id: "h", element: 1, position: [0, 0, 1], bondTo: 0 },
      ],
      "Set O #0 to N",
    );
    g().pushOp({ op: "delete_atoms", atoms: [1] }, "Delete H #1");
    g().pushOp({ op: "wrap" });
    const labels = () => editSteps(g().edits).map(describeStep);
    expect(labels()).toEqual(["Set O #0 to N", "Delete H #1", "Wrap atoms into cell"]);
    g().undo();
    g().undo();
    g().redo();
    expect(labels()).toEqual(["Set O #0 to N", "Delete H #1"]);
    g().moveAtoms(new Map([[0, [1, 0, 0]]]), "Move N #0 by (1.00, 0.00, 0.00) Å");
    expect(labels().at(-1)).toBe("Move N #0 by (1.00, 0.00, 0.00) Å");
  });
});

describe("useBuilderStore — a drag replays the history once", () => {
  function setup() {
    const store = createBuilderStore();
    const g = () => store.getState();
    g().openStructure(water(), null, "w.xyz");
    g().pushOp({ op: "add_atom", id: "n", element: 6, position: [3, 0, 0], bondTo: 0 });
    return { store, g };
  }

  it("shifts only the moved atoms of the cached base, matching a full replay", () => {
    const { g } = setup();
    const base = g().edits.length;
    const atStart = g().result!;
    g().setSelected([3, 1]);
    g().setDragOps(base, [{ op: "move_atoms", atoms: ["n", 1], delta: [1, 0, 0] }]);
    g().setDragOps(base, [{ op: "move_atoms", atoms: ["n", 1], delta: [2, 0.5, 0] }]);
    const fast = g().result!;
    const full = applyEditOps(g().source!, g().edits);
    expect(Array.from(fast.snapshot.positions)).toEqual(
      Array.from(full.snapshot.positions).map((v) => expect.closeTo(v, 5)),
    );
    expect(fast.snapshot.bonds).toBe(atStart.snapshot.bonds);
    expect(fast.refAt(3)).toBe("n");
    expect(fast.outputRefs).toEqual(full.outputRefs);
    expect(fast.warnings).toEqual([]);
    expect(g().selected).toEqual([3, 1]);
    // Letting go writes nothing and shows the base again, without a replay.
    g().setDragOps(base, []);
    expect(g().result).toBe(atStart);
  });

  it("replays in full for any other op, a changed history, or an unknown atom", () => {
    const { g } = setup();
    const base = g().edits.length;
    g().setDragOps(base, [{ op: "move_atoms", atoms: [0], delta: [1, 0, 0] }]);
    g().setDragOps(base, [{ op: "set_element", atoms: [0], element: 7 }]);
    expect(g().result!.snapshot.elements[0]).toBe(7);
    g().setDragOps(base, [{ op: "move_atoms", atoms: ["nope"], delta: [1, 0, 0] }]);
    expect(g().result!.warnings).toHaveLength(1);
    // A drag from an earlier point of the history.
    g().setDragOps(0, [{ op: "move_atoms", atoms: [0], delta: [1, 0, 0] }]);
    expect(g().result!.snapshot.nAtoms).toBe(3);
    expect(g().result!.snapshot.positions[0]).toBeCloseTo(1);
  });

  it("applyMoves refuses ops other than moves of known atoms", () => {
    const r = applyEditOps(water(), []);
    const index = (ref: string | number) => (ref === 0 ? 0 : undefined);
    expect(applyMoves(r, [{ op: "wrap" }], index)).toBeNull();
    expect(applyMoves(r, [{ op: "move_atoms", atoms: [5], delta: [1, 0, 0] }], index)).toBeNull();
    const moved = applyMoves(r, [{ op: "move_atoms", atoms: [0], delta: [1, 0, 0] }], index)!;
    expect(moved.snapshot.positions[0]).toBe(1);
    expect(r.snapshot.positions[0]).toBe(0);
  });
});
