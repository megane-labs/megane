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

const angleAt = (p: number[], center: number[], q: number[]) => {
  const u = [0, 1, 2].map((k) => p[k] - center[k]);
  const v = [0, 1, 2].map((k) => q[k] - center[k]);
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  return (Math.acos(dot / (Math.hypot(...u) * Math.hypot(...v))) * 180) / Math.PI;
};

describe("placeBondedAtom", () => {
  it("takes a free tetrahedral direction at covalent bond length", () => {
    const p = placeBondedAtom(chain(), 0, 1);
    const len = getCovalentRadius(6) + getCovalentRadius(1);
    expect(Math.hypot(...p)).toBeCloseTo(len, 4);
    // 109.5° from the C0–C1 bond, not straight across it.
    expect(angleAt(p, [0, 0, 0], [1.5, 0, 0])).toBeCloseTo(109.47, 1);
  });

  it("goes trigonal for a double bond and linear for a triple", () => {
    const double = placeBondedAtom(chain(), 0, 6, 2);
    expect(angleAt(double, [0, 0, 0], [1.5, 0, 0])).toBeCloseTo(120, 1);
    const triple = placeBondedAtom(chain(), 0, 6, 3);
    expect(angleAt(triple, [0, 0, 0], [1.5, 0, 0])).toBeCloseTo(180, 1);
    // An aromatic neighbour counts half a multiple bond: benzene's C is trigonal.
    const s = chain();
    s.nAtoms = 4;
    s.nBonds = 2;
    s.positions = new Float32Array([0, 0, 0, 1.4, 0, 0, -0.7, 1.21, 0, 9, 9, 9]);
    s.elements = new Uint8Array([6, 6, 6, 6]);
    s.bonds = new Uint32Array([0, 1, 0, 2]);
    s.bondOrders = new Uint8Array([4, 4]);
    const ring = placeBondedAtom(s, 0, 1);
    expect(angleAt(ring, [0, 0, 0], [1.4, 0, 0])).toBeCloseTo(120, 0);
    expect(angleAt(ring, [0, 0, 0], [-0.7, 1.21, 0])).toBeCloseTo(120, 0);
  });

  it("goes along +x for an atom with no neighbours", () => {
    const p = placeBondedAtom(chain(), 2, 6);
    expect(p[0]).toBeCloseTo(5 + 2 * getCovalentRadius(6));
    expect(p[1]).toBeCloseTo(5);
  });

  it("keeps clear of both neighbours when they sit on opposite sides", () => {
    const s = chain();
    s.nAtoms = 4;
    s.nBonds = 2;
    s.positions = new Float32Array([0, 0, 0, 1.5, 0, 0, -1.5, 0, 0, 5, 5, 5]);
    s.elements = new Uint8Array([6, 6, 6, 6]);
    s.bonds = new Uint32Array([0, 1, 0, 2]);
    const p = placeBondedAtom(s, 0, 6);
    expect(angleAt(p, [0, 0, 0], [1.5, 0, 0])).toBeGreaterThan(60);
    expect(angleAt(p, [0, 0, 0], [-1.5, 0, 0])).toBeGreaterThan(60);
  });

  it("falls back to pointing away from a full shell", () => {
    const d = 1.09 / Math.sqrt(3);
    const s = chain();
    s.nAtoms = 5;
    s.nBonds = 4;
    s.positions = new Float32Array([0, 0, 0, d, d, d, -d, -d, d, -d, d, -d, d, -d, -d]);
    s.elements = new Uint8Array([6, 1, 1, 1, 1]);
    s.bonds = new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4]);
    const p = placeBondedAtom(s, 0, 6);
    expect(Math.hypot(...p)).toBeGreaterThan(1);
    // Four neighbours in a plane that cancel out: the free axis out of it.
    const flat = chain();
    flat.nAtoms = 5;
    flat.nBonds = 4;
    flat.positions = new Float32Array([0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0]);
    flat.elements = new Uint8Array([6, 6, 6, 6, 6]);
    flat.bonds = new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4]);
    const q = placeBondedAtom(flat, 0, 6);
    expect(Math.abs(q[2])).toBeCloseTo(2 * getCovalentRadius(6));
  });

  it("picks the free direction with room, away from a non-bonded atom", () => {
    // C0–C1 along +x; the first free direction is crowded by a stray atom.
    const s = chain();
    const free = placeBondedAtom(s, 0, 6);
    s.positions = new Float32Array([0, 0, 0, 1.5, 0, 0, free[0], free[1], free[2]]);
    const p = placeBondedAtom(s, 0, 6);
    const gap = Math.hypot(p[0] - free[0], p[1] - free[1], p[2] - free[2]);
    expect(gap).toBeGreaterThan(2);
    expect(angleAt(p, [0, 0, 0], [1.5, 0, 0])).toBeCloseTo(109.47, 1);
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
    // An added atom's internal id is never shown.
    expect(describeOp({ op: "add_bond", a: 0, b: "x" })).toBe("Bond #0 – an added atom");
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
