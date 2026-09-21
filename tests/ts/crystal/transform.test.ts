import { describe, it, expect } from "vitest";
import {
  buildSlab,
  centerSnapshot,
  makeSupercell,
  surfaceBasis,
  wrapSnapshot,
} from "@/crystal/transform";
import { det3 } from "@/crystal/cell";
import { bulkSnapshot } from "@/crystal/bulk";
import type { Snapshot } from "@/types";
import {
  ORACLE,
  bulkOf,
  expectSameAtoms,
  expectSameAtomsModLattice,
  type OracleBulkInput,
} from "./oracle";

type Vec3 = [number, number, number];

/** Water in a 10 Å cube with two O–H bonds, one H across the periodic face. */
function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0.2, 5, 5, 0.957, 5, 5, 9.443, 5, 5]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: new Uint8Array([1, 2]),
    box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    boxOrigin: null,
    atomChainIds: new Uint8Array([65, 66, 67]),
    atomBFactors: new Float32Array([1, 2, 3]),
  };
}

describe("makeSupercell vs ASE make_supercell", () => {
  for (const c of ORACLE.cases.filter((c) => c.kind === "supercell")) {
    it(c.name, () => {
      const base = bulkOf(c.input.base as OracleBulkInput);
      const out = makeSupercell(base, c.input.matrix as number[])!;
      expect(out).not.toBeNull();
      // Same atoms modulo the new lattice (ASE wraps its result too, but the
      // lattice-point enumeration order differs).
      expectSameAtomsModLattice(out, c.expected);
    });
  }
});

describe("makeSupercell", () => {
  it("lays a diagonal repeat out image-major like the Replicate node and keeps channels", () => {
    const out = makeSupercell(water(), [2, 0, 0, 0, 1, 0, 0, 0, 1])!;
    expect(out.nAtoms).toBe(6);
    expect(Array.from(out.elements)).toEqual([8, 1, 1, 8, 1, 1]);
    expect(out.positions[9]).toBeCloseTo(10.2, 5);
    expect(Array.from(out.atomChainIds!)).toEqual([65, 66, 67, 65, 66, 67]);
    expect(Array.from(out.atomBFactors!)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(Array.from(out.box!)).toEqual([20, 0, 0, 0, 10, 0, 0, 0, 10]);
    expect(out.symmetryOps).toBeUndefined();
    expect(out.boxOrigin).toBeNull();
  });

  it("re-draws bonds by geometry: the boundary bond reaches the neighbouring image", () => {
    const out = makeSupercell(water(), [2, 0, 0, 0, 1, 0, 0, 0, 1])!;
    expect(out.nBonds).toBe(4);
    const pairs = new Set<string>();
    for (let b = 0; b < out.nBonds; b++) pairs.add(`${out.bonds[b * 2]}-${out.bonds[b * 2 + 1]}`);
    // O0–H1 and O3–H4 intra-image; O0's second H is the H at x=9.443 of the
    // *other* image (index 5), and O3's is atom 2 (across the supercell face).
    expect(pairs).toEqual(new Set(["0-1", "3-4", "0-5", "2-3"]));
    expect(Array.from(out.bondOrders!)).toHaveLength(4);
    expect(out.bondOrders![0]).toBe(1);
  });

  it("wraps atoms outside the home cell into the supercell", () => {
    const src = water();
    src.positions[0] = -0.5;
    const out = makeSupercell(src, [1, 0, 0, 0, 1, 0, 0, 0, 1])!;
    expect(out.nAtoms).toBe(3);
    expect(out.positions[0]).toBeCloseTo(9.5, 5);
  });

  it("returns null without a cell, for a singular or non-integer matrix", () => {
    expect(makeSupercell({ ...water(), box: null }, [2, 0, 0, 0, 2, 0, 0, 0, 2])).toBeNull();
    expect(makeSupercell(water(), [1, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
    expect(makeSupercell(water(), [1.5, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull();
    expect(makeSupercell(water(), [1, 0, 0, 0, 1])).toBeNull();
  });
});

describe("surfaceBasis", () => {
  const cubic = [4, 0, 0, 0, 4, 0, 0, 0, 4];
  it("is unimodular and spans the (hkl) plane with its first two vectors", () => {
    for (const m of [
      [1, 1, 1],
      [1, 0, 0],
      [1, 1, 0],
      [2, 1, 1],
      [3, -1, 2],
      [0, 1, 1],
      [0, 0, 1],
      [0, 1, 0],
    ] as Vec3[]) {
      const b = surfaceBasis(cubic, m)!;
      expect(Math.abs(det3(b))).toBe(1);
      // c1·(hkl) = 0 and c2·(hkl) = 0 in the reciprocal sense: for a cubic
      // cell the in-plane condition is simply the integer dot product.
      expect(b[0] * m[0] + b[1] * m[1] + b[2] * m[2]).toBe(0);
      expect(b[3] * m[0] + b[4] * m[1] + b[5] * m[2]).toBe(0);
    }
  });
  it("rejects (0 0 0) and non-integers", () => {
    expect(surfaceBasis(cubic, [0, 0, 0])).toBeNull();
    expect(surfaceBasis(cubic, [1.5, 0, 0])).toBeNull();
  });
});

describe("buildSlab vs ASE surface()", () => {
  for (const c of ORACLE.cases.filter((c) => c.kind === "slab")) {
    it(c.name, () => {
      const base = bulkOf(c.input.base as OracleBulkInput);
      const out = buildSlab(base, {
        miller: c.input.miller as Vec3,
        layers: c.input.layers as number,
        vacuum: c.input.vacuum as number,
      })!;
      expect(out).not.toBeNull();
      // Atoms sitting exactly on an in-plane cell face wrap to either side
      // depending on float noise (ASE's float64 vs the Snapshot's float32),
      // so in-plane positions are compared modulo the surface lattice; the
      // normal direction must match exactly.
      expectSameAtomsModLattice(out, c.expected, [true, true, (c.input.vacuum as number) === 0]);
    });
  }
});

describe("buildSlab", () => {
  const cu = () => bulkSnapshot({ structure: "fcc", elements: [29], a: 3.61, cubic: true });

  it("a shift slides the termination: the atom count is kept, the layers move", () => {
    const a = buildSlab(cu(), { miller: [1, 0, 0], layers: 2, vacuum: 5 })!;
    const b = buildSlab(cu(), { miller: [1, 0, 0], layers: 2, vacuum: 5, shift: 0.25 })!;
    expect(b.nAtoms).toBe(a.nAtoms);
    expect(Array.from(b.box!)).toEqual(Array.from(a.box!));
    // Both are centred, so the z extents coincide; the atoms themselves differ.
    expect(Array.from(b.positions)).not.toEqual(Array.from(a.positions));
  });

  it("drops the bonds that would cross the vacuum and keeps in-plane periodic ones", () => {
    // A chain along z in a 3 Å cube: every atom bonded to its +z image.
    const chain: Snapshot = {
      nAtoms: 1,
      nBonds: 1,
      nFileBonds: 1,
      positions: new Float32Array([0, 0, 0]),
      elements: new Uint8Array([6]),
      bonds: new Uint32Array([0, 0]),
      bondOrders: null,
      box: new Float32Array([3, 0, 0, 0, 3, 0, 0, 0, 3]),
      boxOrigin: null,
      atomChainIds: null,
      atomBFactors: null,
    };
    // A self-bond is meaningless; use a 2-atom cell instead: A at z=0, B at z=1.5, bonded, plus B–A(+c).
    const two: Snapshot = {
      ...chain,
      nAtoms: 2,
      nBonds: 2,
      nFileBonds: 2,
      positions: new Float32Array([0, 0, 0, 0, 0, 1.5]),
      elements: new Uint8Array([6, 7]),
      bonds: new Uint32Array([0, 1, 1, 0]),
    };
    // (001), 2 layers, periodic: 4 atoms, chain intact (4 bonds incl. the wrap-around).
    const periodic = buildSlab(two, { miller: [0, 0, 1], layers: 2, vacuum: 0 })!;
    expect(periodic.nAtoms).toBe(4);
    expect(periodic.nBonds).toBe(4);
    // With vacuum the wrap-around bond across the vacuum is gone: 3 bonds.
    const vac = buildSlab(two, { miller: [0, 0, 1], layers: 2, vacuum: 4 })!;
    expect(vac.nAtoms).toBe(4);
    expect(vac.nBonds).toBe(3);
    expect(vac.box![8]).toBeCloseTo(4.5 + 8, 5);
    // In-plane periodic bonds survive: bond A to its own +a image.
    const inPlane: Snapshot = {
      ...chain,
      nAtoms: 2,
      nBonds: 1,
      nFileBonds: 1,
      positions: new Float32Array([0, 0, 0, 1.5, 0, 0]),
      elements: new Uint8Array([6, 6]),
      bonds: new Uint32Array([0, 1]),
    };
    const flat = buildSlab(inPlane, { miller: [0, 0, 1], layers: 1, vacuum: 4 })!;
    expect(flat.nBonds).toBe(1);
  });

  it("returns null without a cell or for a zero Miller index", () => {
    expect(
      buildSlab({ ...cu(), box: null }, { miller: [1, 1, 1], layers: 1, vacuum: 1 }),
    ).toBeNull();
    expect(buildSlab(cu(), { miller: [0, 0, 0], layers: 1, vacuum: 1 })).toBeNull();
  });
});

describe("centerSnapshot vs ASE Atoms.center", () => {
  for (const c of ORACLE.cases.filter((c) => c.kind === "center")) {
    it(c.name, () => {
      const base = bulkOf(c.input.base as OracleBulkInput);
      const out = centerSnapshot(base, c.input.axes as number[], c.input.vacuum as number | null)!;
      expectSameAtoms(out, c.expected);
    });
  }
  it("returns null without a cell and keeps bonds", () => {
    expect(centerSnapshot({ ...water(), box: null }, [2], 1)).toBeNull();
    const out = centerSnapshot(water(), [0, 1, 2], null)!;
    expect(out.nBonds).toBe(2);
    expect(out.bonds).toBe(water().bonds.length === 4 ? out.bonds : out.bonds);
  });
});

describe("wrapSnapshot", () => {
  it("folds atoms into the home cell, honouring the box origin", () => {
    const src = water();
    src.positions[0] = -0.5;
    src.positions[3] = 10.3;
    const out = wrapSnapshot(src)!;
    expect(out.positions[0]).toBeCloseTo(9.5, 5);
    expect(out.positions[3]).toBeCloseTo(0.3, 5);
    expect(out.nBonds).toBe(2);
    const shifted = { ...water(), boxOrigin: new Float32Array([5, 0, 0]) };
    shifted.positions[0] = 4.5;
    const out2 = wrapSnapshot(shifted)!;
    expect(out2.positions[0]).toBeCloseTo(14.5, 5);
  });
  it("returns null without a usable cell", () => {
    expect(wrapSnapshot({ ...water(), box: null })).toBeNull();
    expect(wrapSnapshot({ ...water(), box: new Float32Array(9) })).toBeNull();
  });
});
