import { describe, it, expect, beforeEach } from "vitest";
import { useBuildStore, createBuildStore } from "@/stores/useBuildStore";
import { createMeganeStores, globalMeganeStores } from "@/stores/meganeStores";

describe("useBuildStore", () => {
  beforeEach(() => {
    useBuildStore.setState({
      tool: "select",
      element: 6,
      bondOrder: 1,
      selected: [],
      pendingBondAtom: null,
      redoStack: [],
    });
  });

  it("starts with the select tool and carbon", () => {
    const s = useBuildStore.getState();
    expect(s.tool).toBe("select");
    expect(s.element).toBe(6);
    expect(s.bondOrder).toBe(1);
  });

  it("switching tools clears a half-finished bond", () => {
    const s = useBuildStore.getState();
    s.setPendingBondAtom(4);
    expect(useBuildStore.getState().pendingBondAtom).toBe(4);
    s.setTool("add");
    expect(useBuildStore.getState().tool).toBe("add");
    expect(useBuildStore.getState().pendingBondAtom).toBeNull();
  });

  it("manages the selection as a set", () => {
    const s = useBuildStore.getState();
    s.setSelected([1, 1, 2]);
    expect(useBuildStore.getState().selected).toEqual([1, 2]);
    s.toggleSelected(2);
    expect(useBuildStore.getState().selected).toEqual([1]);
    s.toggleSelected(5);
    expect(useBuildStore.getState().selected).toEqual([1, 5]);
    s.setPendingBondAtom(1);
    s.clearSelected();
    expect(useBuildStore.getState().selected).toEqual([]);
    expect(useBuildStore.getState().pendingBondAtom).toBeNull();
  });

  it("sets element and bond order", () => {
    const s = useBuildStore.getState();
    s.setElement(8);
    s.setBondOrder(2);
    expect(useBuildStore.getState().element).toBe(8);
    expect(useBuildStore.getState().bondOrder).toBe(2);
  });

  it("keeps a LIFO redo stack", () => {
    const s = useBuildStore.getState();
    expect(s.popRedo()).toBeNull();
    s.pushRedo({ op: "delete_atoms", atoms: [0] });
    s.pushRedo({ op: "delete_atoms", atoms: [1] });
    expect(useBuildStore.getState().popRedo()).toEqual({ op: "delete_atoms", atoms: [1] });
    expect(useBuildStore.getState().redoStack).toHaveLength(1);
    useBuildStore.getState().clearRedo();
    expect(useBuildStore.getState().redoStack).toHaveLength(0);
  });

  it("is part of every store bundle", () => {
    const a = createMeganeStores();
    const b = createMeganeStores();
    expect(a.build).not.toBe(b.build);
    expect(globalMeganeStores.build).toBe(useBuildStore);
    const own = createBuildStore();
    own.getState().setTool("move");
    expect(own.getState().tool).toBe("move");
    expect(useBuildStore.getState().tool).toBe("select");
  });
});
