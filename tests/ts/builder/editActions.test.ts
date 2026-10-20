/**
 * The atom and bond edits as user actions (`editActions.ts`): each follows the
 * hydrogen mode, pushes one labelled Undo step, and does nothing while the
 * document is not editable.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createBuilderStore, editSteps, type BuilderStore } from "@/builder/store";
import { describeStep } from "@/builder/placement";
import {
  addFreeAtom,
  addOnAtom,
  bondAtoms,
  bondOrderName,
  deleteAtoms,
  removeBond,
  setElements,
} from "@/builder/editActions";
import type { StoreApi } from "zustand";
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

let api: StoreApi<BuilderStore>;
const s = () => api.getState();
const labels = () => editSteps(s().edits).map(describeStep);
const count = (z: number) =>
  Array.from(s().result!.snapshot.elements).filter((e) => e === z).length;

beforeEach(() => {
  api = createBuilderStore();
  s().openStructure(ethane(), null, "ethane.xyz");
});

describe("editActions", () => {
  it("deleteAtoms takes the hydrogens along and refills the neighbour", () => {
    s().setSelected([1, 0]);
    expect(deleteAtoms(s(), [1])).toBe(true);
    expect(labels()).toEqual(["Delete C #1 (+3 H)"]);
    expect(s().result!.snapshot.nAtoms).toBe(5); // methane
    expect(editSteps(s().edits)).toHaveLength(1);
    // The surviving C stays selected, under its new index.
    expect(s().selected).toEqual([0]);
    expect(deleteAtoms(s(), [99])).toBe(false);
  });

  it("removeBond rebalances both carbons and names the atoms", () => {
    expect(removeBond(s(), 0, 1)).toBe(true);
    expect(labels()).toEqual(["Remove bond C #0 – C #1"]);
    expect(count(1)).toBe(8);
    expect(removeBond(s(), 0, 1)).toBe(false); // not bonded any more
    expect(removeBond(s(), 0, 99)).toBe(false);
  });

  it("bondAtoms writes a new bond or a new order, and says when nothing changes", () => {
    expect(bondAtoms(s(), 0, 1, 2)).toBe(true);
    expect(labels()).toEqual(["Make C #0 – C #1 double"]);
    expect(count(1)).toBe(4); // ethene
    s().undo();
    expect(bondAtoms(s(), 0, 1, 1)).toBe(true);
    expect(s().notice?.text).toContain("already share a single bond");
    s().setHydrogenMode("off");
    expect(bondAtoms(s(), 2, 5, 1)).toBe(true);
    expect(labels().at(-1)).toBe("Bond H #2 – H #5");
    expect(bondAtoms(s(), 3, 6, 3)).toBe(true);
    expect(labels().at(-1)).toBe("Bond H #3 – H #6 (triple)");
    expect(bondAtoms(s(), 0, 0, 1)).toBe(false);
  });

  it("setElements follows the hydrogen mode", () => {
    expect(setElements(s(), [0], 8)).toBe(true);
    expect(labels()).toEqual(["Set C #0 to O"]);
    expect(count(1)).toBe(4); // CH3–OH
    s().setHydrogenMode("off");
    expect(setElements(s(), [0, 1], 7)).toBe(true);
    expect(labels().at(-1)).toBe("Set 2 atoms to N");
    expect(count(1)).toBe(4);
    expect(setElements(s(), [-1], 7)).toBe(false);
  });

  it("addOnAtom adds or replaces an H; addFreeAtom adds the atom's hydrogens when balanced", () => {
    expect(addOnAtom(s(), 2, 8, 1)).toBe(true);
    expect(labels()).toEqual(["Replace H #2 with O"]);
    expect(addOnAtom(s(), 0, 1, 1)).toBe(true);
    expect(labels().at(-1)).toBe("Add H on C #0");
    expect(addOnAtom(s(), 99, 6, 1)).toBe(false);
    expect(addFreeAtom(s(), [9, 9, 9], 6)).toBe(true);
    expect(labels().at(-1)).toBe("Add C (+4 H)");
    s().setHydrogenMode("off");
    expect(addFreeAtom(s(), [5, 5, 5], 6)).toBe(true);
    expect(labels().at(-1)).toBe("Add C");
  });

  it("does nothing while editing is paused", () => {
    s().pushOp({ op: "wrap" });
    s().setShowOriginal(true);
    const n = s().edits.length;
    expect(deleteAtoms(s(), [0])).toBe(false);
    expect(removeBond(s(), 0, 1)).toBe(false);
    expect(bondAtoms(s(), 0, 2, 1)).toBe(false);
    expect(setElements(s(), [0], 7)).toBe(false);
    expect(addOnAtom(s(), 0, 6, 1)).toBe(false);
    expect(addFreeAtom(s(), [0, 0, 0], 6)).toBe(false);
    expect(s().edits).toHaveLength(n);
  });

  it("names bond orders", () => {
    expect([1, 2, 3, 4].map(bondOrderName)).toEqual(["single", "double", "triple", "aromatic"]);
    expect(bondOrderName(7)).toBe("order 7");
  });
});
