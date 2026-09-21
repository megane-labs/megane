import { describe, it, expect } from "vitest";
import { adsorptionSite, describeOp, newAtomId, placeBondedAtom } from "@/builder/placement";
import { getCovalentRadius } from "@/constants";
import type { Snapshot } from "@/types";

function chain(): Snapshot {
  // C0 at origin bonded to C1 along +x; C2 alone.
  return {
    nAtoms: 3,
    nBonds: 1,
    nFileBonds: 1,
    positions: new Float32Array([0, 0, 0, 1.5, 0, 0, 5, 5, 5]),
    elements: new Uint8Array([6, 6, 6]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

describe("placeBondedAtom", () => {
  it("points away from the anchor's neighbours at covalent bond length", () => {
    const p = placeBondedAtom(chain(), 0, 1);
    const len = getCovalentRadius(6) + getCovalentRadius(1);
    expect(p[0]).toBeCloseTo(-len);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(0);
  });

  it("goes along +x for an atom with no neighbours", () => {
    const p = placeBondedAtom(chain(), 2, 6);
    expect(p[0]).toBeCloseTo(5 + 2 * getCovalentRadius(6));
    expect(p[1]).toBeCloseTo(5);
  });

  it("goes along +y when the neighbours cancel out", () => {
    const s = chain();
    // Two neighbours on opposite sides of atom 0.
    s.nAtoms = 4;
    s.nBonds = 2;
    s.positions = new Float32Array([0, 0, 0, 1.5, 0, 0, -1.5, 0, 0, 5, 5, 5]);
    s.elements = new Uint8Array([6, 6, 6, 6]);
    s.bonds = new Uint32Array([0, 1, 0, 2]);
    const p = placeBondedAtom(s, 0, 6);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeGreaterThan(0);
  });
});

describe("newAtomId", () => {
  it("is unique", () => {
    expect(newAtomId()).not.toBe(newAtomId());
  });
});

describe("adsorptionSite", () => {
  const snap = (box: Float32Array | null): Snapshot => ({
    nAtoms: 1,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([1, 2, 3]),
    elements: new Uint8Array([29]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  });
  it("goes up the cell's c axis, or +z without a cell", () => {
    expect(adsorptionSite(snap(new Float32Array([4, 0, 0, 0, 4, 0, 0, 3, 4])), 0, 5)).toEqual([
      1,
      2 + 3,
      3 + 4,
    ]);
    expect(adsorptionSite(snap(null), 0, 2)).toEqual([1, 2, 5]);
    expect(adsorptionSite(snap(new Float32Array(9)), 0, 2)).toEqual([1, 2, 5]);
  });
});

describe("describeOp", () => {
  it("reads the crystal ops in one line", () => {
    expect(describeOp({ op: "set_cell", box: [1, 0, 0, 0, 1, 0, 0, 0, 1], scaleAtoms: true })).toBe(
      "Set cell (atoms scaled)",
    );
    expect(describeOp({ op: "supercell", id: "s", matrix: [2, 0, 0, 0, 3, 0, 0, 0, 1] })).toBe(
      "Supercell 2×3×1",
    );
    expect(describeOp({ op: "supercell", id: "s", matrix: [1, 1, 0, -1, 1, 0, 0, 0, 1] })).toBe(
      "Supercell [1 1 0 -1 1 0 0 0 1]",
    );
    expect(describeOp({ op: "slab", id: "s", miller: [1, 1, 1], layers: 1, vacuum: 10 })).toBe(
      "Slab (1 1 1), 1 layer, 10 Å vacuum",
    );
    expect(
      describeOp({ op: "slab", id: "s", miller: [1, 0, 0], layers: 3, vacuum: 0, shift: 0.5 }),
    ).toBe("Slab (1 0 0), 3 layers, 0 Å vacuum, shift 0.5");
    expect(describeOp({ op: "expand_symmetry", id: "e" })).toBe("Expand symmetry");
    expect(describeOp({ op: "wrap" })).toBe("Wrap atoms into cell");
    expect(describeOp({ op: "center" })).toBe("Center along abc");
    expect(describeOp({ op: "center", axes: [2], vacuum: 5 })).toBe(
      "Center along c with 5 Å vacuum",
    );
  });

  it("reads each op in one line", () => {
    expect(describeOp({ op: "add_atom", id: "a", element: 6, position: [0, 0, 0] })).toBe("Add C");
    expect(
      describeOp({ op: "add_atom", id: "a", element: 8, position: [0, 0, 0], bondTo: 2 }),
    ).toBe("Add O bonded to #2");
    expect(describeOp({ op: "delete_atoms", atoms: [1] })).toBe("Delete 1 atom");
    expect(describeOp({ op: "delete_atoms", atoms: [1, 2] })).toBe("Delete 2 atoms");
    expect(describeOp({ op: "move_atoms", atoms: [1], delta: [1, 0.5, 0] })).toBe(
      "Move 1 atom by (1.00, 0.50, 0.00) Å",
    );
    expect(describeOp({ op: "set_element", atoms: [1, 2], element: 7 })).toBe("Set 2 atoms to N");
    expect(describeOp({ op: "add_bond", a: 0, b: "x" })).toBe("Bond #0 – x");
    expect(describeOp({ op: "add_bond", a: 0, b: 1, order: 2 })).toBe("Bond #0 – #1 (order 2)");
    expect(describeOp({ op: "delete_bond", a: 0, b: 1 })).toBe("Remove bond #0 – #1");
    expect(
      describeOp({
        op: "add_fragment",
        id: "f",
        elements: [6, 6],
        positions: [0, 0, 0, 1, 0, 0],
        bonds: [],
      }),
    ).toBe("Add f (2 atoms)");
    expect(describeOp({ op: "set_cell", box: null })).toBe("Remove cell");
    expect(describeOp({ op: "set_cell", box: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBe("Set cell");
    expect(describeOp({ op: "bogus" } as never)).toBe("bogus");
  });
});
