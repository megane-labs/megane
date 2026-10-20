import { describe, it, expect } from "vitest";
import {
  addFreeAtomOps,
  addOnAtomOps,
  balanceHydrogens,
  bondOps,
  bondOrderBetween,
  deleteAtomsEdit,
  deleteAtomsOps,
  removeBondOps,
  setElementsOps,
  bondDirections,
  hasHydrogens,
  neighboursOf,
  setElementOps,
  typicalValence,
  balancesHydrogens,
} from "@/builder/hydrogens";
import { createBuilderStore } from "@/builder/store";
import { applyEditOps, type EditResult } from "@/pipeline/executors/edit";
import { getCovalentRadius } from "@/constants";
import type { EditOp } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function snapshot(elements: number[], positions: number[], bonds: number[][]): Snapshot {
  return {
    nAtoms: elements.length,
    nBonds: bonds.length,
    nFileBonds: bonds.length,
    positions: new Float32Array(positions),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(bonds.flat()),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function methane(): Snapshot {
  const d = 1.09 / Math.sqrt(3);
  return snapshot(
    [6, 1, 1, 1, 1],
    [0, 0, 0, d, d, d, -d, -d, d, -d, d, -d, d, -d, -d],
    [
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ],
  );
}

/** A tiny editing session: the source plus the ops pushed so far. */
class Doc {
  ops: EditOp[] = [];
  result: EditResult;
  constructor(private source: Snapshot) {
    this.result = applyEditOps(source, []);
  }
  get snap() {
    return this.result.snapshot;
  }
  push(ops: EditOp[]) {
    this.ops.push(...ops);
    this.result = applyEditOps(this.source, this.ops);
    expect(this.result.warnings).toEqual([]);
  }
  add(i: number, z: number, order = 1) {
    this.push(addOnAtomOps(this.snap, this.result.refAt, i, z, order));
  }
  setElement(i: number, z: number) {
    this.push(setElementOps(this.snap, this.result.refAt, i, z));
  }
  /** Index of the first atom of element `z`, skipping `skip` of them. */
  find(z: number, skip = 0) {
    for (let i = 0; i < this.snap.nAtoms; i++)
      if (this.snap.elements[i] === z && skip-- === 0) return i;
    throw new Error(`no element ${z}`);
  }
  /** First H bonded to atom `i`. */
  hydrogenOf(i: number) {
    const h = neighboursOf(this.snap, i).find((n) => this.snap.elements[n.index] === 1);
    if (!h) throw new Error(`atom ${i} has no H`);
    return h.index;
  }
  formula() {
    const counts = new Map<number, number>();
    for (const z of this.snap.elements) counts.set(z, (counts.get(z) ?? 0) + 1);
    return Object.fromEntries(counts);
  }
  /** For each heavy atom: [element, H count, heavy-neighbour count]. */
  heavyAtoms() {
    const out: [number, number, number][] = [];
    for (let i = 0; i < this.snap.nAtoms; i++) {
      if (this.snap.elements[i] === 1) continue;
      const nb = neighboursOf(this.snap, i);
      const h = nb.filter((n) => this.snap.elements[n.index] === 1).length;
      out.push([this.snap.elements[i], h, nb.length - h]);
    }
    return out.sort();
  }
  distance(i: number, j: number) {
    const p = this.snap.positions;
    return Math.hypot(
      p[i * 3] - p[j * 3],
      p[i * 3 + 1] - p[j * 3 + 1],
      p[i * 3 + 2] - p[j * 3 + 2],
    );
  }
  /** Shortest distance between any two atoms (no H lands on top of another atom). */
  closestPair() {
    let best = Infinity;
    for (let i = 0; i < this.snap.nAtoms; i++)
      for (let j = i + 1; j < this.snap.nAtoms; j++) best = Math.min(best, this.distance(i, j));
    return best;
  }
}

describe("Add on a hydrogen replaces it", () => {
  it("methane + C on an H gives ethane (C–C, not C–H–C)", () => {
    const doc = new Doc(methane());
    doc.add(1, 6);
    expect(doc.formula()).toEqual({ 6: 2, 1: 6 });
    expect(doc.heavyAtoms()).toEqual([
      [6, 3, 1],
      [6, 3, 1],
    ]);
    const c2 = doc.find(6, 1);
    expect(doc.distance(0, c2)).toBeCloseTo(2 * getCovalentRadius(6), 4);
    expect(doc.closestPair()).toBeGreaterThan(0.9);
  });

  it("builds an ether by clicking H's: ethane → ethanol → CH3–CH2–O–CH3", () => {
    const doc = new Doc(methane());
    doc.add(1, 6);
    doc.add(doc.hydrogenOf(doc.find(6, 1)), 8);
    expect(doc.formula()).toEqual({ 6: 2, 8: 1, 1: 6 });
    const o = doc.find(8);
    expect(neighboursOf(doc.snap, o)).toHaveLength(2); // C–O–H
    doc.add(doc.hydrogenOf(o), 6);
    expect(doc.formula()).toEqual({ 6: 3, 8: 1, 1: 8 });
    // The O carries no H: C–O–CH3.
    expect(doc.heavyAtoms()).toContainEqual([8, 0, 2]);
    expect(doc.closestPair()).toBeGreaterThan(0.9);
  });

  it("a double bond trims the parent's surplus hydrogen (ethene)", () => {
    const doc = new Doc(methane());
    doc.add(1, 6, 2);
    expect(doc.heavyAtoms()).toEqual([
      [6, 2, 1],
      [6, 2, 1],
    ]);
  });

  it("an isolated H just changes element and gets its hydrogens", () => {
    const doc = new Doc(snapshot([1], [0, 0, 0], []));
    doc.add(0, 8);
    expect(doc.formula()).toEqual({ 8: 1, 1: 2 });
  });
});

describe("Add on a heavy atom with explicit hydrogens", () => {
  it("replaces one H of a saturated atom", () => {
    const doc = new Doc(methane());
    doc.add(0, 8);
    expect(doc.formula()).toEqual({ 6: 1, 8: 1, 1: 4 }); // methanol
  });

  it("adds alongside an unsaturated atom and fills the new atom", () => {
    // A bare C next to an H elsewhere: explicit-H mode, C has room.
    const doc = new Doc(snapshot([6, 1], [0, 0, 0, 5, 5, 5], []));
    doc.add(0, 7);
    expect(doc.heavyAtoms()).toEqual([
      [6, 0, 1],
      [7, 2, 1],
    ]);
  });

  it("keeps the plain add for hydrogens and for skeletons", () => {
    const doc = new Doc(methane());
    const ops = addOnAtomOps(doc.snap, doc.result.refAt, 0, 1, 1);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "add_atom", element: 1, bondTo: 0 });
    const bare = new Doc(snapshot([6, 6], [0, 0, 0, 1.5, 0, 0], [[0, 1]]));
    bare.add(0, 8);
    expect(bare.formula()).toEqual({ 6: 2, 8: 1 });
  });
});

describe("Element rebalances hydrogens", () => {
  it("propane's middle C set to O gives CH3–O–CH3", () => {
    const doc = new Doc(methane());
    doc.add(1, 6);
    doc.add(doc.hydrogenOf(doc.find(6, 1)), 6);
    expect(doc.formula()).toEqual({ 6: 3, 1: 8 });
    const carbons = [0, 1, 2].map((k) => doc.find(6, k));
    const middle = carbons.find(
      (i) =>
        neighboursOf(doc.snap, i).length === 4 &&
        neighboursOf(doc.snap, i).filter((n) => doc.snap.elements[n.index] === 6).length === 2,
    )!;
    doc.setElement(middle, 8);
    expect(doc.formula()).toEqual({ 6: 2, 8: 1, 1: 6 });
    expect(doc.heavyAtoms()).toEqual([
      [6, 3, 1],
      [6, 3, 1],
      [8, 0, 2],
    ]);
  });

  it("an H set to O becomes a hydroxyl; methane's C set to H leaves H2", () => {
    const doc = new Doc(methane());
    doc.setElement(1, 8);
    expect(doc.formula()).toEqual({ 6: 1, 8: 1, 1: 4 });
    const again = new Doc(methane());
    again.setElement(0, 1);
    expect(again.formula()).toEqual({ 1: 2 }); // H–H
  });

  it("an O set to N gains an H; C set to C, Fe, or a skeleton edit is just set_element", () => {
    const water = snapshot(
      [8, 1, 1],
      [0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0],
      [
        [0, 1],
        [0, 2],
      ],
    );
    const doc = new Doc(water);
    doc.setElement(0, 7);
    expect(doc.formula()).toEqual({ 7: 1, 1: 3 });
    const m = new Doc(methane());
    expect(setElementOps(m.snap, m.result.refAt, 0, 6)).toHaveLength(1);
    expect(setElementOps(m.snap, m.result.refAt, 0, 26)).toHaveLength(1);
    const bare = new Doc(snapshot([6], [0, 0, 0], []));
    expect(setElementOps(bare.snap, bare.result.refAt, 0, 8)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("typicalValence / hasHydrogens", () => {
    expect(typicalValence(6)).toBe(4);
    expect(typicalValence(8)).toBe(2);
    expect(typicalValence(26)).toBeNull();
    expect(hasHydrogens(methane())).toBe(true);
    expect(hasHydrogens(snapshot([6], [0, 0, 0], []))).toBe(false);
  });

  it("neighboursOf reads bond orders", () => {
    const s = snapshot([6, 8], [0, 0, 0, 1.2, 0, 0], [[0, 1]]);
    s.bondOrders = new Uint8Array([2]);
    expect(neighboursOf(s, 0)).toEqual([{ index: 1, order: 2 }]);
  });

  it("bondDirections gives ideal tetrahedral / trigonal / linear angles", () => {
    const angle = (a: number[], b: number[]) =>
      (Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI;
    const tet = bondDirections([], 4, 4);
    expect(tet).toHaveLength(4);
    expect(angle(tet[0], tet[1])).toBeCloseTo(109.47, 1);
    expect(angle(tet[2], tet[3])).toBeCloseTo(109.47, 1);
    const tri = bondDirections([[0, 0, 1]], 3, 2);
    expect(angle(tri[0], [0, 0, 1])).toBeCloseTo(120, 1);
    expect(angle(tri[0], tri[1])).toBeCloseTo(120, 1);
    const lin = bondDirections([[0, 1, 0]], 2, 1);
    expect(lin[0][1]).toBeCloseTo(-1);
    // Aligned to a second existing bond, and nothing left when full.
    const two = bondDirections(
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      4,
      2,
    );
    expect(two).toHaveLength(2);
    expect(bondDirections([[1, 0, 0]], 2, 3)).toHaveLength(1);
    expect(bondDirections([], 4, 0)).toEqual([]);
  });

  it("balanceHydrogens ignores unknown elements and trim-only never adds", () => {
    expect(balanceHydrogens("x", 26, [0, 0, 0], [])).toEqual([]);
    expect(balanceHydrogens("x", 6, [0, 0, 0], [], true)).toEqual([]);
    expect(balanceHydrogens("x", 6, [0, 0, 0], [])).toHaveLength(4);
  });
});

describe("store.pushOps", () => {
  it("pushes a group as one undo / redo step and ignores an empty group", () => {
    const api = createBuilderStore();
    const s = () => api.getState();
    s().openStructure(methane(), null, "methane.xyz");
    s().pushOps([]);
    expect(s().edits).toHaveLength(0);
    s().pushOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    s().pushOps(addOnAtomOps(s().result!.snapshot, s().result!.refAt, 1, 6, 1));
    const n = s().edits.length;
    expect(n).toBeGreaterThan(2);
    expect(s().undo()).toMatchObject({ op: "set_element" });
    expect(s().edits).toHaveLength(1);
    expect(s().undo()).toMatchObject({ op: "move_atoms" });
    expect(s().edits).toHaveLength(0);
    s().redo();
    expect(s().edits).toHaveLength(1);
    s().redo();
    expect(s().edits).toHaveLength(n);
    expect(s().redo()).toBeNull();
  });
});

describe("balancesHydrogens", () => {
  const bare: Snapshot = {
    nAtoms: 1,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(3),
    elements: new Uint8Array([6]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
  const withH: Snapshot = { ...bare, elements: new Uint8Array([1]) };
  it("follows the document in auto, and the user otherwise", () => {
    expect(balancesHydrogens("auto", bare)).toBe(false);
    expect(balancesHydrogens("auto", withH)).toBe(true);
    expect(balancesHydrogens("on", bare)).toBe(true);
    expect(balancesHydrogens("off", withH)).toBe(false);
  });
});

/** Ethane with explicit hydrogens, built from methane by an Add on an H. */
function ethane(): Doc {
  const doc = new Doc(methane());
  doc.add(1, 6);
  return doc;
}

/** For each heavy atom (by index): its H count. */
function hCounts(doc: Doc): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < doc.snap.nAtoms; i++) {
    if (doc.snap.elements[i] === 1) continue;
    out.set(i, neighboursOf(doc.snap, i).filter((n) => doc.snap.elements[n.index] === 1).length);
  }
  return out;
}

describe("aromatic bonds count 1.5", () => {
  /** A benzene-like C with two aromatic ring neighbours and nothing else. */
  function ringCarbon(): Snapshot {
    const s = snapshot(
      [6, 6, 6, 1],
      [0, 0, 0, 1.4, 0, 0, -0.7, 1.21, 0, 9, 9, 9],
      [
        [0, 1],
        [0, 2],
      ],
    );
    s.bondOrders = new Uint8Array([4, 4]);
    return s;
  }

  it("a ring C gets one H, in the ring plane", () => {
    const doc = new Doc(ringCarbon());
    const ops = balanceHydrogens(
      0,
      6,
      [0, 0, 0],
      neighboursOf(doc.snap, 0).map((n) => ({
        ref: n.index,
        position: [doc.snap.positions[n.index * 3], doc.snap.positions[n.index * 3 + 1], 0],
        order: n.order,
        hydrogen: false,
      })),
    );
    expect(ops).toHaveLength(1);
    const h = (ops[0] as { position: number[] }).position;
    expect(Math.abs(h[2])).toBeLessThan(1e-6);
  });

  it("Add on a saturated aromatic C replaces its H; Element sets N with no H", () => {
    const doc = new Doc(ringCarbon());
    doc.push(addOnAtomOps(doc.snap, doc.result.refAt, 0, 1, 1, true));
    expect(hCounts(doc).get(0)).toBe(1);
    // C(ar)(ar)H is full: a methyl replaces the H rather than over-filling the C.
    doc.add(0, 6);
    expect(hCounts(doc).get(0)).toBe(0);
    const n = new Doc(ringCarbon());
    n.push(setElementsOps(n.snap, n.result.refAt, [0], 7, true));
    expect(hCounts(n).get(0)).toBe(0);
  });
});

describe("setElementsOps", () => {
  it("sets several atoms in one op and rebalances each that changes", () => {
    const doc = ethane();
    const carbons = [doc.find(6), doc.find(6, 1)];
    doc.push(setElementsOps(doc.snap, doc.result.refAt, carbons, 7));
    // Hydrazine: H2N–NH2.
    expect(doc.formula()).toEqual({ 7: 2, 1: 4 });
  });

  it("plans a changing neighbour with its new element, and skips bad indices", () => {
    const doc = new Doc(methane());
    // C and one of its H both become O: the O–O bond is heavy, so the old C keeps one H.
    doc.push(setElementsOps(doc.snap, doc.result.refAt, [0, 1, 99], 8));
    expect(doc.formula()).toEqual({ 8: 2, 1: 2 });
    expect(setElementsOps(doc.snap, doc.result.refAt, [99], 8)).toEqual([]);
    // Without balancing it is just the element.
    expect(setElementsOps(doc.snap, doc.result.refAt, [0], 6, false)).toHaveLength(1);
  });
});

describe("addFreeAtomOps", () => {
  it("adds a free atom, with its hydrogens when balanced", () => {
    expect(addFreeAtomOps(6, [0, 0, 0], false)).toHaveLength(1);
    expect(addFreeAtomOps(6, [0, 0, 0], true)).toHaveLength(5);
    expect(addFreeAtomOps(1, [0, 0, 0], true)).toHaveLength(1);
  });
});

describe("bondOps", () => {
  it("a new bond trims a hydrogen from each heavy end", () => {
    const doc = new Doc(methane());
    doc.push(addFreeAtomOps(6, [5, 0, 0], true)); // a second methane
    const c2 = doc.find(6, 1);
    doc.push(bondOps(doc.snap, doc.result.refAt, 0, c2, 1, true));
    expect(doc.heavyAtoms()).toEqual([
      [6, 3, 1],
      [6, 3, 1],
    ]);
    // Raising it to a double bond trims one more from each; lowering adds them back.
    doc.push(bondOps(doc.snap, doc.result.refAt, 0, doc.find(6, 1), 2, true));
    expect(doc.heavyAtoms()).toEqual([
      [6, 2, 1],
      [6, 2, 1],
    ]);
    doc.push(bondOps(doc.snap, doc.result.refAt, 0, doc.find(6, 1), 1, true));
    expect(doc.heavyAtoms()).toEqual([
      [6, 3, 1],
      [6, 3, 1],
    ]);
    expect(bondOrderBetween(doc.snap, 0, doc.find(6, 1))).toBe(1);
  });

  it("writes only the bond without balancing, for the same order, or onto an H", () => {
    const doc = ethane();
    const c2 = doc.find(6, 1);
    expect(bondOps(doc.snap, doc.result.refAt, 0, c2, 2, false)).toHaveLength(1);
    expect(bondOps(doc.snap, doc.result.refAt, 0, c2, 1, true)).toHaveLength(1);
    // Bonding a stray H to a full C: the C sheds one of its own H, the new one stays.
    const stray = new Doc(methane());
    stray.push([{ op: "add_atom", id: "h", element: 1, position: [3, 0, 0] }]);
    const h = stray.snap.nAtoms - 1;
    stray.push(bondOps(stray.snap, stray.result.refAt, 0, h, 1, true));
    expect(stray.formula()).toEqual({ 6: 1, 1: 4 });
    expect(neighboursOf(stray.snap, 0).map((n) => stray.result.refAt(n.index))).toContain("h");
  });
});

describe("removeBondOps", () => {
  it("gives each heavy end a hydrogen in place of the bond", () => {
    const doc = ethane();
    const c2 = doc.find(6, 1);
    doc.push(removeBondOps(doc.snap, doc.result.refAt, 0, c2, true));
    // Two methanes.
    expect(doc.heavyAtoms()).toEqual([
      [6, 4, 0],
      [6, 4, 0],
    ]);
  });

  it("removes only the bond for an H end or without balancing", () => {
    const doc = new Doc(methane());
    expect(removeBondOps(doc.snap, doc.result.refAt, 0, 1, true)).toEqual([
      { op: "delete_bond", a: 0, b: 1 },
    ]);
    const e = ethane();
    expect(removeBondOps(e.snap, e.result.refAt, 0, e.find(6, 1), false)).toHaveLength(1);
  });
});

describe("deleteAtomsEdit", () => {
  it("takes the deleted atom's hydrogens along and refills its neighbour", () => {
    const doc = ethane();
    const c2 = doc.find(6, 1);
    const edit = deleteAtomsEdit(doc.snap, doc.result.refAt, [c2], "auto");
    expect(edit.extraHydrogens).toBe(3);
    expect(edit.label).toBe(`Delete C #${c2} (+3 H)`);
    doc.push(edit.ops);
    // Back to methane.
    expect(doc.formula()).toEqual({ 6: 1, 1: 4 });
    expect(doc.heavyAtoms()).toEqual([[6, 4, 0]]);
  });

  it("deleting an H leaves the parent alone, and Off deletes only what was asked", () => {
    const doc = new Doc(methane());
    const h = deleteAtomsEdit(doc.snap, doc.result.refAt, [1], "auto");
    expect(h.ops).toEqual([{ op: "delete_atoms", atoms: [1] }]);
    expect(h.label).toBe("Delete H #1");
    const e = ethane();
    const off = deleteAtomsEdit(e.snap, e.result.refAt, [0], "off");
    expect(off.ops).toEqual([{ op: "delete_atoms", atoms: [0] }]);
  });

  it("deletes several atoms in one op, ignoring repeats and bad indices", () => {
    const doc = ethane();
    const both = [doc.find(6), doc.find(6, 1)];
    const edit = deleteAtomsEdit(doc.snap, doc.result.refAt, [...both, both[0], -1, 99], "on");
    expect(edit.label).toBe("Delete 2 atoms (+6 H)");
    expect(edit.ops).toHaveLength(1);
    doc.push(edit.ops);
    expect(doc.snap.nAtoms).toBe(0);
    expect(deleteAtomsOps(doc.snap, doc.result.refAt, [0], "on")).toEqual([]);
    expect(deleteAtomsEdit(doc.snap, doc.result.refAt, [], "on").label).toBe("Delete nothing");
  });

  it("keeps an H that is bonded to a surviving atom too", () => {
    // H bridging C0 and C2; deleting C0 keeps it (C2 still holds it).
    const s = snapshot(
      [6, 1, 6],
      [0, 0, 0, 1, 0, 0, 2, 0, 0],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const doc = new Doc(s);
    const edit = deleteAtomsEdit(doc.snap, doc.result.refAt, [0], "on");
    expect(edit.extraHydrogens).toBe(0);
  });
});
