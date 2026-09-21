import { describe, it, expect } from "vitest";
import { applyEditOps, fragmentAtomRef } from "@/pipeline/executors/edit";
import { executeLoadStructure } from "@/pipeline/executors/loadStructure";
import type { EditOp, ParticleData, CellData, LoadStructureParams } from "@/pipeline/types";
import type { Snapshot } from "@/types";

/** Water: O at origin, two H bonded to it, in a 10 Å cubic cell. */
function water(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    boxOrigin: null,
    atomChainIds: new Uint8Array([65, 65, 65]),
    atomBFactors: new Float32Array([1, 2, 3]),
    caIndices: new Uint32Array([0, 2]),
    caChainIds: new Uint8Array([65, 65]),
    caResNums: new Uint32Array([1, 1]),
    caSsType: new Uint8Array([0, 1]),
    ...extra,
  };
}

function loader(edits?: EditOp[]): LoadStructureParams {
  return {
    type: "load_structure",
    fileName: "water.xyz",
    hasTrajectory: false,
    hasCell: true,
    edits,
  };
}

/** Run the loader executor on `src` with `edits`, collecting its warnings. */
function load(src: Snapshot, edits?: EditOp[], opts: { editsBypassed?: boolean } = {}) {
  const warnings: string[] = [];
  const out = executeLoadStructure(loader(edits), src, null, null, "loader-1", null, {
    ...opts,
    warnings,
  });
  return { out, warnings };
}

function bondSet(s: Snapshot): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.nBonds; i++) out.add(`${s.bonds[i * 2]}-${s.bonds[i * 2 + 1]}`);
  return out;
}

describe("applyEditOps", () => {
  it("returns an equivalent copy for an empty op list and never mutates the input", () => {
    const src = water();
    const before = Array.from(src.positions);
    const { snapshot, outputRefs, warnings } = applyEditOps(src, []);
    expect(snapshot).not.toBe(src);
    expect(snapshot.nAtoms).toBe(3);
    expect(Array.from(snapshot.positions)).toEqual(before);
    expect(outputRefs).toEqual([0, 1, 2]);
    expect(warnings).toEqual([]);
    expect(Array.from(src.positions)).toEqual(before);
  });

  it("adds an atom with a bond in one op", () => {
    const { snapshot, outputRefs } = applyEditOps(water(), [
      { op: "add_atom", id: "a1", element: 6, position: [1, 2, 3], bondTo: 0, order: 2 },
    ]);
    expect(snapshot.nAtoms).toBe(4);
    expect(snapshot.elements[3]).toBe(6);
    expect(Array.from(snapshot.positions.slice(9))).toEqual([1, 2, 3]);
    expect(outputRefs[3]).toBe("a1");
    expect(bondSet(snapshot)).toEqual(new Set(["0-1", "0-2", "0-3"]));
    expect(snapshot.bondOrders).not.toBeNull();
    expect(Array.from(snapshot.bondOrders!)).toEqual([1, 1, 2]);
    expect(snapshot.nFileBonds).toBe(3);
    // New atoms get neutral chain / B-factor entries.
    expect(snapshot.atomChainIds![3]).toBe(0);
    expect(snapshot.atomBFactors![3]).toBe(0);
  });

  it("deletes atoms, drops their bonds and remaps later refs and Cα data", () => {
    const { snapshot, outputRefs, warnings } = applyEditOps(water(), [
      { op: "delete_atoms", atoms: [1] },
      // Ref 2 still means the original third atom even though it is now index 1.
      { op: "set_element", atoms: [2], element: 9 },
    ]);
    expect(warnings).toEqual([]);
    expect(snapshot.nAtoms).toBe(2);
    expect(outputRefs).toEqual([0, 2]);
    expect(Array.from(snapshot.elements)).toEqual([8, 9]);
    expect(bondSet(snapshot)).toEqual(new Set(["0-1"]));
    expect(Array.from(snapshot.atomChainIds!)).toEqual([65, 65]);
    expect(Array.from(snapshot.atomBFactors!)).toEqual([1, 3]);
    expect(Array.from(snapshot.caIndices!)).toEqual([0, 1]);
    expect(Array.from(snapshot.caSsType!)).toEqual([0, 1]);
  });

  it("moves atoms by a delta", () => {
    const { snapshot } = applyEditOps(water(), [
      { op: "move_atoms", atoms: [1, 2], delta: [1, 0, -1] },
    ]);
    expect(snapshot.positions[3]).toBeCloseTo(1.757);
    expect(snapshot.positions[5]).toBeCloseTo(-1);
    expect(snapshot.positions[0]).toBe(0);
  });

  it("adds, updates and deletes bonds regardless of pair orientation", () => {
    const { snapshot, warnings } = applyEditOps(water(), [
      { op: "add_bond", a: 2, b: 1 },
      { op: "add_bond", a: 1, b: 2, order: 3 },
      { op: "delete_bond", a: 1, b: 0 },
    ]);
    expect(warnings).toEqual([]);
    expect(bondSet(snapshot)).toEqual(new Set(["0-2", "1-2"]));
    const orders = Array.from(snapshot.bondOrders!);
    expect(orders).toEqual([1, 3]);
  });

  it("places a fragment and bonds it to an existing atom", () => {
    const ops: EditOp[] = [
      {
        op: "add_fragment",
        id: "me",
        elements: [6, 1, 1, 1],
        positions: [0, 0, 0, 1.09, 0, 0, -0.36, 1.03, 0, -0.36, -0.51, 0.89],
        bonds: [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
        translate: [5, 5, 5],
      },
      { op: "add_bond", a: fragmentAtomRef("me", 0), b: 0 },
    ];
    const { snapshot, outputRefs } = applyEditOps(water(), ops);
    expect(snapshot.nAtoms).toBe(7);
    expect(outputRefs.slice(3)).toEqual(["me:0", "me:1", "me:2", "me:3"]);
    expect(Array.from(snapshot.positions.slice(9, 12))).toEqual([5, 5, 5]);
    expect(snapshot.nBonds).toBe(6);
    expect(bondSet(snapshot).has("0-3")).toBe(true);
  });

  it("sets and clears the cell", () => {
    const cleared = applyEditOps(water(), [{ op: "set_cell", box: null }]).snapshot;
    expect(cleared.box).toBeNull();
    const set = applyEditOps(water({ box: null }), [
      { op: "set_cell", box: [5, 0, 0, 0, 6, 0, 0, 0, 7] },
    ]).snapshot;
    expect(Array.from(set.box!)).toEqual([5, 0, 0, 0, 6, 0, 0, 0, 7]);
  });

  it("skips bad ops with a warning instead of throwing", () => {
    const { snapshot, warnings } = applyEditOps(water(), [
      { op: "delete_atoms", atoms: [42] },
      { op: "add_bond", a: 0, b: 0 },
      { op: "add_bond", a: 0, b: "nope" },
      { op: "delete_bond", a: 1, b: 2 },
      { op: "add_atom", id: "dup", element: 1, position: [0, 0, 0] },
      { op: "add_atom", id: "dup", element: 1, position: [0, 0, 0] },
      { op: "set_cell", box: [1, 2, 3] },
      { op: "add_fragment", id: "f", elements: [6], positions: [0, 0], bonds: [] },
      { op: "add_fragment", id: "g", elements: [6], positions: [0, 0, 0], bonds: [[0, 3]] },
      { op: "move_atoms", atoms: ["missing"], delta: [1, 1, 1] },
      { op: "set_element", atoms: ["missing"], element: 6 },
      { op: "bogus" } as unknown as EditOp,
    ]);
    expect(snapshot.nAtoms).toBe(5); // water + "dup" + "g:0"
    expect(warnings.length).toBe(11);
    expect(warnings[0]).toContain("unknown atom 42");
    expect(warnings[1]).toContain("itself");
    expect(warnings[2]).toContain('"nope"');
    expect(warnings[3]).toContain("no bond");
    expect(warnings[4]).toContain("already exists");
    expect(warnings[5]).toContain("9 values");
    expect(warnings[6]).toContain("positions length");
    expect(warnings[7]).toContain("out of range");
    expect(warnings[8]).toContain("missing");
    expect(warnings[9]).toContain("missing");
    expect(warnings[10]).toContain("unknown edit op");
  });

  it("clamps elements and bond orders into range", () => {
    const { snapshot } = applyEditOps(water(), [
      { op: "add_atom", id: "x", element: 500, position: [0, 0, 0] },
      { op: "set_element", atoms: [1], element: -3 },
      { op: "add_bond", a: 1, b: 2, order: 9 },
    ]);
    expect(snapshot.elements[3]).toBe(118);
    expect(snapshot.elements[1]).toBe(0);
    expect(Array.from(snapshot.bondOrders!)).toEqual([1, 1, 4]);
  });

  it("keeps existing bond orders and drops duplicate input bonds", () => {
    const src = water({
      nBonds: 3,
      bonds: new Uint32Array([0, 1, 0, 2, 1, 0]),
      bondOrders: new Uint8Array([1, 2, 1]),
    });
    const { snapshot } = applyEditOps(src, [{ op: "move_atoms", atoms: [0], delta: [0, 0, 0] }]);
    expect(snapshot.nBonds).toBe(2);
    expect(Array.from(snapshot.bondOrders!)).toEqual([1, 2]);
  });
});

describe("applyEditOps — crystal ops", () => {
  const sym = (extra: Partial<Snapshot> = {}) =>
    water({
      nBonds: 0,
      nFileBonds: 0,
      bonds: new Uint32Array(0),
      symmetryOps: ["x,y,z", "-x,-y,-z"],
      ...extra,
    });

  it("set_cell with scaleAtoms keeps fractional coordinates", () => {
    const { snapshot } = applyEditOps(water(), [
      { op: "set_cell", box: [20, 0, 0, 0, 10, 0, 0, 0, 10], scaleAtoms: true },
    ]);
    expect(snapshot.positions[3]).toBeCloseTo(0.757 * 2, 5);
    expect(snapshot.positions[4]).toBeCloseTo(0.586, 5);
    // Without a previous cell the flag is ignored.
    const noCell = applyEditOps(water({ box: null }), [
      { op: "set_cell", box: [20, 0, 0, 0, 10, 0, 0, 0, 10], scaleAtoms: true },
    ]).snapshot;
    expect(noCell.positions[3]).toBeCloseTo(0.757, 5);
    // A singular current cell cannot be scaled from; warn and set the cell anyway.
    const singular = applyEditOps(water({ box: new Float32Array(9) }), [
      { op: "set_cell", box: [20, 0, 0, 0, 10, 0, 0, 0, 10], scaleAtoms: true },
    ]);
    expect(singular.warnings[0]).toContain("singular");
    expect(singular.snapshot.box![0]).toBe(20);
  });

  it("supercell replaces the atoms with <id>:<k> refs, tiles bonds and drops symmetry ops", () => {
    const { snapshot, outputRefs, warnings } = applyEditOps(
      sym({ nBonds: 2, bonds: new Uint32Array([0, 1, 0, 2]) }),
      [{ op: "supercell", id: "sc", matrix: [2, 0, 0, 0, 1, 0, 0, 0, 1] }],
    );
    expect(warnings).toEqual([]);
    expect(snapshot.nAtoms).toBe(6);
    expect(snapshot.nBonds).toBe(4);
    expect(outputRefs).toEqual(["sc:0", "sc:1", "sc:2", "sc:3", "sc:4", "sc:5"]);
    expect(Array.from(snapshot.box!)).toEqual([20, 0, 0, 0, 10, 0, 0, 0, 10]);
    expect(snapshot.symmetryOps).toBeUndefined();
    expect(Array.from(snapshot.atomChainIds!)).toEqual([65, 65, 65, 65, 65, 65]);
    // Later ops address the new refs; the old numeric refs are gone.
    const next = applyEditOps(water(), [
      { op: "supercell", id: "sc", matrix: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
      { op: "set_element", atoms: ["sc:3"], element: 7 },
      { op: "delete_atoms", atoms: [0] },
    ]);
    expect(next.snapshot.elements[3]).toBe(7);
    expect(next.warnings).toHaveLength(1);
    expect(next.warnings[0]).toContain("unknown atom 0");
  });

  it("supercell warns without a cell or with a bad matrix", () => {
    const noCell = applyEditOps(water({ box: null }), [
      { op: "supercell", id: "sc", matrix: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
    ]);
    expect(noCell.snapshot.nAtoms).toBe(3);
    expect(noCell.warnings[0]).toContain("no cell");
    const bad = applyEditOps(water(), [
      { op: "supercell", id: "sc", matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
    ]);
    expect(bad.snapshot.nAtoms).toBe(3);
    expect(bad.warnings[0]).toContain("determinant");
  });

  it("slab cuts a surface with vacuum and re-keys the atoms", () => {
    const { snapshot, outputRefs, warnings } = applyEditOps(water(), [
      { op: "slab", id: "sl", miller: [0, 0, 1], layers: 2, vacuum: 5, shift: 0.5 },
    ]);
    expect(warnings).toEqual([]);
    expect(snapshot.nAtoms).toBe(6);
    expect(outputRefs[5]).toBe("sl:5");
    // Thickness: atoms span one repeat (10 Å) plus 2 × 5 Å vacuum.
    expect(snapshot.box![8]).toBeCloseTo(20, 4);
    expect(snapshot.symmetryOps).toBeUndefined();
    const noCell = applyEditOps(water({ box: null }), [
      { op: "slab", id: "sl", miller: [1, 1, 1], layers: 1, vacuum: 0 },
    ]);
    expect(noCell.warnings[0]).toContain("no cell");
    const bad = applyEditOps(water(), [
      { op: "slab", id: "sl", miller: [0, 0, 0], layers: 1, vacuum: 0 },
    ]);
    expect(bad.warnings[0]).toContain("Miller");
    expect(bad.snapshot.nAtoms).toBe(3);
  });

  it("expand_symmetry fills the cell once and consumes the operations", () => {
    const { snapshot, outputRefs, warnings } = applyEditOps(sym(), [
      { op: "expand_symmetry", id: "ex" },
    ]);
    expect(warnings).toEqual([]);
    expect(snapshot.nAtoms).toBe(6);
    expect(outputRefs[0]).toBe("ex:0");
    expect(snapshot.symmetryOps).toBeUndefined();
    // A second expansion has nothing to apply.
    const twice = applyEditOps(sym(), [
      { op: "expand_symmetry", id: "ex" },
      { op: "expand_symmetry", id: "ex2" },
    ]);
    expect(twice.snapshot.nAtoms).toBe(6);
    expect(twice.warnings[0]).toContain("no symmetry operations");
    // Identity-only operations: nothing to expand, but they are consumed.
    const identity = applyEditOps(sym({ symmetryOps: ["x,y,z"] }), [
      { op: "expand_symmetry", id: "ex" },
    ]);
    expect(identity.snapshot.nAtoms).toBe(3);
    expect(identity.snapshot.symmetryOps).toBeUndefined();
    expect(identity.warnings).toEqual([]);
    const noOps = applyEditOps(water(), [{ op: "expand_symmetry", id: "ex" }]);
    expect(noOps.warnings[0]).toContain("no symmetry operations");
    const noCell = applyEditOps(sym({ box: null }), [{ op: "expand_symmetry", id: "ex" }]);
    expect(noCell.warnings[0]).toContain("no cell");
  });

  it("wrap folds atoms into the cell and keeps refs; center pads with vacuum", () => {
    const src = water();
    src.positions[0] = -1;
    const wrapped = applyEditOps(src, [{ op: "wrap" }]);
    expect(wrapped.snapshot.positions[0]).toBeCloseTo(9, 5);
    expect(wrapped.outputRefs).toEqual([0, 1, 2]);
    expect(wrapped.snapshot.symmetryOps).toBe(src.symmetryOps);
    expect(applyEditOps(water({ box: null }), [{ op: "wrap" }]).warnings[0]).toContain(
      "no usable cell",
    );

    const centered = applyEditOps(water(), [{ op: "center", axes: [2], vacuum: 4 }]);
    expect(centered.snapshot.box![8]).toBeCloseTo(8, 5);
    expect(centered.snapshot.positions[2]).toBeCloseTo(4, 5);
    expect(centered.outputRefs).toEqual([0, 1, 2]);
    // Without a vacuum the cell is kept and only the atoms move.
    const only = applyEditOps(water(), [{ op: "center" }]);
    expect(Array.from(only.snapshot.box!)).toEqual([10, 0, 0, 0, 10, 0, 0, 0, 10]);
    expect(only.snapshot.positions[2]).toBeCloseTo(5, 5);
    expect(applyEditOps(water({ box: null }), [{ op: "center" }]).warnings[0]).toContain(
      "no usable cell",
    );
  });
});

describe("applyEditOps — refs after a whole-structure op", () => {
  const slab = (): EditOp => ({ op: "slab", id: "sl", miller: [0, 0, 1], layers: 2, vacuum: 5 });

  it("refAt agrees with outputRefs, and base refs keep resolving after deletions", () => {
    const { snapshot, refAt, outputRefs, warnings } = applyEditOps(water(), [
      slab(),
      { op: "delete_atoms", atoms: ["sl:1"] },
      // Ref "sl:3" still names the original fourth slab atom, now at index 2.
      { op: "set_element", atoms: ["sl:3"], element: 9 },
      { op: "add_atom", id: "extra", element: 6, position: [1, 1, 1], bondTo: "sl:5" },
    ]);
    expect(warnings).toEqual([]);
    expect(snapshot.nAtoms).toBe(6);
    expect(outputRefs).toEqual(["sl:0", "sl:2", "sl:3", "sl:4", "sl:5", "extra"]);
    for (let i = 0; i < snapshot.nAtoms; i++) expect(refAt(i)).toBe(outputRefs[i]);
    expect(snapshot.elements[2]).toBe(9);
    expect(bondSet(snapshot).has("4-5")).toBe(true);
  });

  it("only exact <id>:<k> strings name base atoms; a colliding add_atom id is refused", () => {
    const { snapshot, warnings } = applyEditOps(water(), [
      slab(),
      {
        op: "set_element",
        atoms: ["sl:01", "sl:1e0", "sl:-1", "sl:6", "sl:", 1, "sl:1x"],
        element: 7,
      },
      { op: "add_atom", id: "sl:0", element: 1, position: [0, 0, 0] },
      { op: "set_element", atoms: ["sl:1"], element: 7 },
    ]);
    expect(warnings).toHaveLength(8);
    expect(warnings[7]).toContain("already exists");
    expect(Array.from(snapshot.elements).filter((z) => z === 7)).toHaveLength(1);
    expect(snapshot.elements[1]).toBe(7);
  });

  it("added atoms survive a deletion before them and can be deleted themselves", () => {
    const { snapshot, outputRefs, warnings } = applyEditOps(water(), [
      slab(),
      {
        op: "add_fragment",
        id: "f",
        elements: [7, 7],
        positions: [0, 0, 0, 1, 0, 0],
        bonds: [[0, 1]],
      },
      { op: "add_bond", a: "f:0", b: "sl:0" },
      { op: "delete_atoms", atoms: ["sl:0", "sl:2"] },
      { op: "set_element", atoms: ["f:1"], element: 8 },
      { op: "delete_atoms", atoms: ["f:0"] },
      { op: "add_atom", id: "f:0", element: 1, position: [2, 2, 2] },
    ]);
    expect(warnings).toEqual([]);
    expect(outputRefs).toEqual(["sl:1", "sl:3", "sl:4", "sl:5", "f:1", "f:0"]);
    expect(snapshot.elements[4]).toBe(8);
    // Only the second layer's O–H bonds are left: the first O (sl:0) took its
    // bonds and the bond to f:0 with it, and f:0 took the fragment's own bond.
    expect(bondSet(snapshot)).toEqual(new Set(["1-2", "1-3"]));
  });

  it("finds bonds after many appends and through deleted slots", () => {
    // A chain long enough to outgrow the adjacency index built for the first lookup.
    const ops: EditOp[] = [];
    for (let k = 0; k < 200; k++) {
      ops.push({
        op: "add_atom",
        id: `c${k}`,
        element: 6,
        position: [k, 0, 0],
        bondTo: k === 0 ? 0 : `c${k - 1}`,
      });
    }
    ops.push({ op: "delete_bond", a: "c10", b: "c11" });
    ops.push({ op: "delete_bond", a: "c11", b: "c10" });
    ops.push({ op: "add_bond", a: "c11", b: "c10", order: 2 });
    ops.push({ op: "add_bond", a: "c150", b: "c151", order: 3 });
    ops.push({ op: "delete_atoms", atoms: ["c100"] });
    ops.push({ op: "add_bond", a: "c99", b: "c101" });
    const { snapshot, warnings } = applyEditOps(water(), ops);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no bond");
    // 2 water + 200 chain bonds − 2 lost with c100 + 1 re-added.
    expect(snapshot.nBonds).toBe(201);
    const orders = new Map<string, number>();
    for (let b = 0; b < snapshot.nBonds; b++) {
      orders.set(`${snapshot.bonds[b * 2]}-${snapshot.bonds[b * 2 + 1]}`, snapshot.bondOrders![b]);
    }
    // c10 is atom 13, c11 atom 14 (3 water atoms first); c150/c151 were
    // 153/154 and moved down by one when c100 (103) was deleted.
    expect(orders.get("13-14")).toBe(2);
    expect(orders.get("152-153")).toBe(3);
    // c99 (102) now bonds straight to c101 (103, after c100 was removed).
    expect(orders.get("102-103")).toBe(1);
  });

  it("stacks up under repeated cuts without per-atom bookkeeping blowing up", () => {
    const cu = {
      ...water(),
      nAtoms: 4,
      nBonds: 0,
      nFileBonds: 0,
      positions: new Float32Array([0, 0, 0, 0, 1.8, 1.8, 1.8, 0, 1.8, 1.8, 1.8, 0]),
      elements: new Uint8Array([29, 29, 29, 29]),
      bonds: new Uint32Array(0),
      box: new Float32Array([3.6, 0, 0, 0, 3.6, 0, 0, 0, 3.6]),
      atomChainIds: null,
      atomBFactors: null,
      caIndices: undefined,
      caChainIds: undefined,
      caResNums: undefined,
      caSsType: undefined,
    };
    const ops: EditOp[] = [];
    for (let k = 0; k < 6; k++) {
      ops.push({ op: "slab", id: `s${k}`, miller: [1, 1, 1], layers: 4, vacuum: 10 });
    }
    const { snapshot, refAt } = applyEditOps(cu, ops);
    expect(snapshot.nAtoms).toBe(4 * 4 ** 6);
    expect(refAt(0)).toBe("s5:0");
    expect(refAt(snapshot.nAtoms - 1)).toBe(`s5:${snapshot.nAtoms - 1}`);
  });
});

describe("executeLoadStructure with edits", () => {
  it("emits the file as loaded when there are no edits (absent or empty)", () => {
    const src = water();
    for (const edits of [undefined, []]) {
      const { out, warnings } = load(src, edits);
      expect((out.get("particle") as ParticleData).source).toBe(src);
      expect(Array.from((out.get("cell") as CellData).box)).toEqual(Array.from(src.box!));
      expect(warnings).toEqual([]);
    }
  });

  it("emits the edited structure and cell, keeps the source node id, and reports op problems", () => {
    const { out, warnings } = load(water(), [
      { op: "delete_atoms", atoms: [1] },
      { op: "add_atom", id: "n", element: 7, position: [3, 3, 3] },
      { op: "set_cell", box: [5, 0, 0, 0, 5, 0, 0, 0, 5] },
      { op: "delete_atoms", atoms: [99] },
    ]);
    const edited = out.get("particle") as ParticleData;
    expect(edited.sourceNodeId).toBe("loader-1");
    expect(edited.source.nAtoms).toBe(3);
    expect(Array.from(edited.source.elements)).toEqual([8, 1, 7]);
    expect(edited.indices).toBeNull();
    expect(Array.from((out.get("cell") as CellData).box)).toEqual([5, 0, 0, 0, 5, 0, 0, 0, 5]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown atom 99");
  });

  it("drops the cell output when the edits clear the box", () => {
    const { out } = load(water(), [{ op: "set_cell", box: null }]);
    expect(out.has("cell")).toBe(false);
    expect(out.has("particle")).toBe(true);
  });

  it("shows the file as loaded while the edits are bypassed", () => {
    const src = water();
    const { out, warnings } = load(src, [{ op: "delete_atoms", atoms: [0] }], {
      editsBypassed: true,
    });
    expect((out.get("particle") as ParticleData).source).toBe(src);
    expect(warnings).toEqual([]);
  });

  it("keeps the trajectory on the file's atoms even when the edits change the count", () => {
    const src = water();
    const frames = [{ frameId: 1, nAtoms: 3, positions: new Float32Array(9) }];
    const meta = { nFrames: 1, timestepPs: 1, nAtoms: 3 };
    const out = executeLoadStructure(
      loader([{ op: "delete_atoms", atoms: [0] }]),
      src,
      frames,
      meta,
      "loader-1",
    );
    expect((out.get("particle") as ParticleData).source.nAtoms).toBe(2);
    const traj = out.get("trajectory") as { meta: { nAtoms: number } };
    expect(traj.meta.nAtoms).toBe(3);
  });

  it("tolerates a malformed edits field", () => {
    const src = water();
    const out = executeLoadStructure(
      loader(null as unknown as EditOp[]),
      src,
      null,
      null,
      "loader-1",
    );
    expect((out.get("particle") as ParticleData).source).toBe(src);
  });
});
