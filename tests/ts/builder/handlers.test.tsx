/**
 * The 3D view's click / drag / key semantics (`useBuilderHandlers`) that the
 * app-level tests do not reach: the Bond tool's cancel and Shift-remove, the
 * edit tools' hydrogen handling, an axis key without a cell, and the atom menu
 * from the keyboard.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StoreApi } from "zustand";
import { useBuilderHandlers, isMenuKey } from "@/builder/useBuilderHandlers";
import { createBuilderStore, editSteps, type BuilderStore } from "@/builder/store";
import { describeStep } from "@/builder/placement";
import type { BuildDragGesture, BuildHandlers } from "@/builder/types";
import type { Snapshot } from "@/types";

/** Ethane with explicit hydrogens: C0–C1, H 2–4 on C0, H 5–7 on C1. */
function ethane(): Snapshot {
  return {
    nAtoms: 8,
    nBonds: 7,
    nFileBonds: 7,
    positions: new Float32Array([
      0, 0, 0, 1.54, 0, 0, -0.36, 1.03, 0, -0.36, -0.51, 0.89, -0.36, -0.51, -0.89, 1.9, -1.03, 0,
      1.9, 0.51, 0.89, 1.9, 0.51, -0.89,
    ]),
    elements: new Uint8Array([6, 6, 1, 1, 1, 1, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4, 1, 5, 1, 6, 1, 7]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

const NO_MODS = { shiftKey: false, mod: false, altKey: false };

function gesture(dx: number): BuildDragGesture {
  return {
    from: [100, 100],
    to: [100 + dx, 100],
    right: [1, 0, 0],
    up: [0, 1, 0],
    toCamera: [0, 0, 1],
    worldPerPixel: 0.1,
    project: (p) => [100 + p[0] * 10, 100 - p[1] * 10],
  };
}

let api: StoreApi<BuilderStore>;
const s = () => api.getState();
const steps = () => editSteps(s().edits).map(describeStep);

function mount(options?: Parameters<typeof useBuilderHandlers>[1]): BuildHandlers {
  return renderHook(() => useBuilderHandlers(api, options)).result.current;
}

function pick(h: BuildHandlers, atomIndex: number | null, shiftKey = false) {
  act(() => h.pick({ atomIndex, world: atomIndex === null ? [5, 5, 5] : null, shiftKey }));
}

beforeEach(() => {
  api = createBuilderStore();
  s().openStructure(ethane(), null, "ethane.xyz");
});

describe("Bond tool", () => {
  it("empty space lets go of the first atom", () => {
    const h = mount();
    s().setTool("bond");
    pick(h, 0);
    expect(s().pendingBondAtom).toBe(0);
    pick(h, null);
    expect(s().pendingBondAtom).toBeNull();
    pick(h, null); // nothing pending: nothing to do
    expect(s().edits).toHaveLength(0);
  });

  it("Shift on the second atom removes their bond; a plain click bonds", () => {
    const h = mount();
    s().setTool("bond");
    pick(h, 0);
    pick(h, 1, true);
    expect(s().edits[0]).toEqual({ op: "delete_bond", a: 0, b: 1 });
    expect(steps()).toEqual(["Remove bond C #0 – C #1"]);
    // Not bonded any more: Shift says so and writes nothing.
    pick(h, 0);
    pick(h, 1, true);
    expect(s().notice?.text).toBe("C #0 and C #1 are not bonded: nothing to remove.");
    expect(steps()).toHaveLength(1);
    pick(h, 0);
    pick(h, 1);
    expect(steps().at(-1)).toBe("Bond C #0 – C #1");
    // A double bond trims one H from each carbon.
    s().setBondOrder(2);
    pick(h, 0);
    pick(h, 1);
    expect(steps().at(-1)).toBe("Make C #0 – C #1 double");
    // A stale first atom writes nothing.
    const n = s().edits.length;
    s().setPendingBondAtom(99);
    pick(h, 0);
    expect(s().edits).toHaveLength(n);
  });
});

describe("Delete, Element and Add tools", () => {
  it("Delete takes the atom's hydrogens and refills its neighbour", () => {
    const h = mount();
    s().setTool("delete");
    pick(h, 1);
    expect(steps()).toEqual(["Delete C #1 (+3 H)"]);
    expect(s().result!.snapshot.nAtoms).toBe(5);
    pick(h, null);
    pick(h, 99);
    expect(steps()).toHaveLength(1);
  });

  it("Element rebalances; Add follows the hydrogen mode on atoms and in space", () => {
    const h = mount();
    s().setTool("element");
    s().setElement(8);
    pick(h, 0);
    expect(steps()).toEqual(["Set C #0 to O"]);
    pick(h, null);
    pick(h, 99);
    expect(steps()).toHaveLength(1);
    s().setTool("add");
    s().setElement(6);
    pick(h, 5);
    expect(steps().at(-1)).toBe("Replace H #5 with C");
    pick(h, null);
    expect(steps().at(-1)).toBe("Add C (+4 H)");
    s().setHydrogenMode("off");
    pick(h, null);
    expect(steps().at(-1)).toBe("Add C");
    pick(h, 99);
    expect(steps()).toHaveLength(4);
  });
});

describe("drag keys", () => {
  it("an a / b / c lock without a cell says why instead of doing nothing", () => {
    const h = mount();
    s().setTool("move");
    act(() => {
      h.dragStart(0, NO_MODS);
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    });
    expect(s().notice?.text).toContain("No cell: A B C need a unit cell");
    expect(s().drag?.axis).toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    });
    expect(s().drag?.axis).toBe("x");
    act(() => h.dragMove(gesture(10)));
    act(() => h.dragEnd());
    expect(s().result!.snapshot.positions[0]).toBeCloseTo(1);
  });
});

describe("headset drags", () => {
  it("move the atom rigidly with the hand, as one step, and ignore axis keys", () => {
    const h = mount();
    s().setTool("move");
    act(() => {
      h.dragStart(1, NO_MODS);
    });
    // The hand has six degrees of freedom: an axis key locks nothing.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    });
    act(() =>
      h.dragRigid({ pivot: [1.54, 0, 0], rotation: [0, 0, 0, 1], translation: [0, 0.5, 0] }),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
    });
    expect(s().drag?.axis).toBeNull();
    act(() => h.dragRigid({ pivot: [1.54, 0, 0], rotation: [0, 0, 0, 1], translation: [0, 1, 0] }));
    expect(s().drag?.readout).toMatchObject({ kind: "move", value: 1 });
    act(() => h.dragEnd());
    expect(s().result!.snapshot.positions[4]).toBeCloseTo(1, 6);
    expect(s().result!.snapshot.positions[3]).toBeCloseTo(1.54, 6);
    expect(editSteps(s().edits)).toHaveLength(1);
    // Without a drag, a hand's motion does nothing.
    act(() => h.dragRigid({ pivot: [0, 0, 0], rotation: [0, 0, 0, 1], translation: [1, 0, 0] }));
    expect(editSteps(s().edits)).toHaveLength(1);
  });
});

describe("atom menu from the keyboard", () => {
  it("is a Menu key or Shift + F10, without other modifiers", () => {
    const k = {
      key: "ContextMenu",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    };
    expect(isMenuKey(k)).toBe(true);
    expect(isMenuKey({ ...k, key: "F10", shiftKey: true })).toBe(true);
    expect(isMenuKey({ ...k, key: "F10" })).toBe(false);
    expect(isMenuKey({ ...k, ctrlKey: true })).toBe(false);
  });

  it("opens the menu for the one selected atom only", () => {
    const openAtomMenu = vi.fn();
    mount({ openAtomMenu });
    const press = (init: KeyboardEventInit, target: EventTarget = window) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
        );
      });
    press({ key: "ContextMenu" });
    expect(openAtomMenu).not.toHaveBeenCalled();
    s().setSelected([3]);
    press({ key: "F10", shiftKey: true });
    expect(openAtomMenu).toHaveBeenCalledWith(3);
    // Not while typing, not for two atoms, not for another key.
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "ContextMenu" }, input);
    s().setSelected([3, 4]);
    press({ key: "ContextMenu" });
    press({ key: "Enter" });
    expect(openAtomMenu).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("listens only inside its scope, when given one", () => {
    const openAtomMenu = vi.fn();
    const inside = document.createElement("div");
    document.body.appendChild(inside);
    mount({ openAtomMenu, scope: { current: inside } });
    s().setSelected([0]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu" }));
    });
    expect(openAtomMenu).not.toHaveBeenCalled();
    act(() => {
      inside.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true }));
    });
    expect(openAtomMenu).toHaveBeenCalledWith(0);
    inside.remove();
  });
});
