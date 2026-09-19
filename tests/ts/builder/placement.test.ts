import { describe, it, expect } from "vitest";
import { newAtomId, placeBondedAtom, describeOp } from "@/builder/placement";
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

describe("describeOp", () => {
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
    ).toBe('Add fragment "f" (2 atoms)');
    expect(describeOp({ op: "set_cell", box: null })).toBe("Remove cell");
    expect(describeOp({ op: "set_cell", box: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBe("Set cell");
    expect(describeOp({ op: "bogus" } as never)).toBe("bogus");
  });
});
