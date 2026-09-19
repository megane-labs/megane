/**
 * Valence-aware hydrogen addition: how many hydrogens each atom gets and
 * where they land (tetrahedral / trigonal / linear, oriented by the
 * neighbours the atom already has).
 */

import { describe, it, expect } from "vitest";
import {
  addHydrogens,
  hydrogenDirections,
  implicitHydrogenCount,
} from "@/builder/library/hydrogens";
import type { MoleculeGeometry } from "@/builder/library/types";
import { BOND_AROMATIC, getCovalentRadius } from "@/constants";

type Vec3 = [number, number, number];

function angle(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(...a);
  const lb = Math.hypot(...b);
  return (Math.acos(Math.max(-1, Math.min(1, dot / (la * lb)))) * 180) / Math.PI;
}

/** Position of atom `i` in a flat xyz array. */
function at(g: MoleculeGeometry, i: number): Vec3 {
  return [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
}

/** Direction from atom `i` to atom `j`. */
function dir(g: MoleculeGeometry, i: number, j: number): Vec3 {
  const a = at(g, i);
  const b = at(g, j);
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

/** Indices of the hydrogens bonded to atom `i`. */
function hydrogensOf(g: MoleculeGeometry, i: number): number[] {
  return g.bonds
    .filter(([a, b]) => (a === i && g.elements[b] === 1) || (b === i && g.elements[a] === 1))
    .map(([a, b]) => (a === i ? b : a));
}

describe("implicitHydrogenCount", () => {
  it("fills each element to its valence", () => {
    expect(implicitHydrogenCount(6, 0, 0)).toBe(4); // methane
    expect(implicitHydrogenCount(6, 0, 3)).toBe(1); // CH with three bonds
    expect(implicitHydrogenCount(7, 0, 0)).toBe(3); // ammonia
    expect(implicitHydrogenCount(8, 0, 1)).toBe(1); // hydroxyl
    expect(implicitHydrogenCount(9, 0, 0)).toBe(1); // HF
    expect(implicitHydrogenCount(17, 0, 1)).toBe(0);
    expect(implicitHydrogenCount(14, 0, 0)).toBe(4);
    expect(implicitHydrogenCount(5, 0, 0)).toBe(3);
  });

  it("follows the formal charge", () => {
    expect(implicitHydrogenCount(7, 1, 0)).toBe(4); // ammonium
    expect(implicitHydrogenCount(7, -1, 1)).toBe(1); // amide anion
    expect(implicitHydrogenCount(8, -1, 1)).toBe(0); // alkoxide
    expect(implicitHydrogenCount(8, 1, 2)).toBe(1); // oxonium
    expect(implicitHydrogenCount(6, 1, 0)).toBe(3); // carbenium
    expect(implicitHydrogenCount(6, -1, 0)).toBe(3); // carbanion
    expect(implicitHydrogenCount(5, -1, 0)).toBe(4); // borohydride
  });

  it("steps S and P up to their hypervalent valences and never goes negative", () => {
    expect(implicitHydrogenCount(16, 0, 1)).toBe(1); // thiol
    expect(implicitHydrogenCount(16, 0, 3)).toBe(1); // sulfoxide-like S with 3 bond orders
    expect(implicitHydrogenCount(16, 0, 6)).toBe(0); // sulfone
    expect(implicitHydrogenCount(16, 0, 7)).toBe(0); // over-bonded
    expect(implicitHydrogenCount(15, 0, 4)).toBe(1);
    expect(implicitHydrogenCount(6, 0, 5)).toBe(0);
  });

  it("gives elements without a valence rule (metals, noble gases) nothing", () => {
    expect(implicitHydrogenCount(11, 0, 0)).toBe(0);
    expect(implicitHydrogenCount(26, 0, 2)).toBe(0);
    expect(implicitHydrogenCount(18, 0, 0)).toBe(0);
  });

  it("counts an aromatic bond as one and a half", () => {
    expect(implicitHydrogenCount(6, 0, 3)).toBe(1);
    expect(implicitHydrogenCount(6, 0, 1.5 + 1.5)).toBe(1);
  });
});

describe("hydrogenDirections", () => {
  it("returns unit vectors, exactly `count` of them, and nothing for zero", () => {
    expect(hydrogenDirections([], 0, 4, null, null)).toEqual([]);
    for (const [dirs, steric] of [
      [[], 4],
      [[[1, 0, 0]], 4],
      [[[1, 0, 0]], 3],
      [
        [
          [1, 0, 0],
          [0, 1, 0],
        ],
        4,
      ],
      [
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        4,
      ],
    ] as [Vec3[], number][]) {
      for (let count = 1; count <= 4 - dirs.length; count++) {
        const out = hydrogenDirections(dirs, count, steric, null, null);
        expect(out).toHaveLength(count);
        for (const v of out) expect(Math.hypot(...v)).toBeCloseTo(1, 6);
      }
    }
  });

  it("lays out an isolated atom by steric number", () => {
    const tet = hydrogenDirections([], 4, 4, null, null);
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) expect(angle(tet[i], tet[j])).toBeCloseTo(109.47, 1);
    const tri = hydrogenDirections([], 3, 3, [0, 0, 1], null);
    expect(angle(tri[0], tri[1])).toBeCloseTo(120, 5);
    for (const v of tri) expect(v[2]).toBeCloseTo(0, 6);
    const lin = hydrogenDirections([], 2, 2, null, null);
    expect(angle(lin[0], lin[1])).toBeCloseTo(180, 5);
  });

  it("with one neighbour: linear opposite, trigonal in the plane, tetrahedral cone", () => {
    const d: Vec3 = [1, 0, 0];
    expect(angle(hydrogenDirections([d], 1, 2, null, null)[0], d)).toBeCloseTo(180, 5);
    const tri = hydrogenDirections([d], 2, 3, [0, 0, 1], null);
    for (const v of tri) {
      expect(angle(v, d)).toBeCloseTo(120, 5);
      expect(v[2]).toBeCloseTo(0, 6);
    }
    const cone = hydrogenDirections([d], 3, 4, [0, 0, 1], null);
    for (const v of cone) expect(angle(v, d)).toBeCloseTo(109.47, 1);
    expect(angle(cone[0], cone[1])).toBeCloseTo(109.47, 1);
  });

  it("staggers a tetrahedral cone against the neighbour's substituent", () => {
    const d: Vec3 = [1, 0, 0];
    const substituent: Vec3 = [0.5, 0.866, 0]; // neighbour's other bond, projected: +y
    const cone = hydrogenDirections([d], 3, 4, null, substituent);
    // The first hydrogen is anti to that substituent: its y component is negative.
    expect(cone[0][1]).toBeLessThan(-0.5);
    expect(cone[0][2]).toBeCloseTo(0, 6);
  });

  it("with two neighbours: trigonal bisector, tetrahedral pair above and below", () => {
    const dirs: Vec3[] = [
      [1, 0, 0],
      [-0.5, 0.866, 0],
    ];
    const [tri] = hydrogenDirections(dirs, 1, 3, null, null);
    expect(angle(tri, dirs[0])).toBeCloseTo(120, 0);
    expect(angle(tri, dirs[1])).toBeCloseTo(120, 0);
    const pair = hydrogenDirections(dirs, 2, 4, null, null);
    expect(angle(pair[0], pair[1])).toBeCloseTo(109.47, 1);
    expect(pair[0][2]).toBeGreaterThan(0.5);
    expect(pair[1][2]).toBeLessThan(-0.5);
  });

  it("with two collinear neighbours falls back to a perpendicular", () => {
    const out = hydrogenDirections(
      [
        [1, 0, 0],
        [-1, 0, 0],
      ],
      2,
      4,
      null,
      null,
    );
    expect(out).toHaveLength(2);
    for (const v of out) expect(Math.abs(v[0])).toBeLessThan(1e-6);
  });

  it("with three neighbours: opposite their sum, or out of a flat plane", () => {
    const [away] = hydrogenDirections(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      1,
      4,
      null,
      null,
    );
    expect(away.map((v) => +v.toFixed(4))).toEqual([-0.5774, -0.5774, -0.5774]);
    const flat: Vec3[] = [
      [1, 0, 0],
      [-0.5, 0.866, 0],
      [-0.5, -0.866, 0],
    ];
    const [up, down] = hydrogenDirections(flat, 2, 5, null, null);
    expect(Math.abs(up[2])).toBeCloseTo(1, 5);
    expect(down[2]).toBeCloseTo(-up[2], 5);
  });

  it("pads an over-coordinated atom with axis directions", () => {
    const out = hydrogenDirections(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [-1, 0, 0],
      ],
      4,
      6,
      null,
      null,
    );
    expect(out).toHaveLength(4);
  });
});

describe("addHydrogens", () => {
  const hLength = (z: number) => getCovalentRadius(z) + getCovalentRadius(1);

  it("makes methane from a lone carbon, tetrahedral at the covalent bond length", () => {
    const { geometry, added } = addHydrogens({ elements: [6], positions: [1, 2, 3], bonds: [] });
    expect(added).toBe(4);
    expect(geometry.elements).toEqual([6, 1, 1, 1, 1]);
    expect(geometry.bonds).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ]);
    expect(geometry.bondOrders).toBeUndefined();
    for (let h = 1; h <= 4; h++)
      expect(Math.hypot(...dir(geometry, 0, h))).toBeCloseTo(hLength(6), 6);
    expect(angle(dir(geometry, 0, 1), dir(geometry, 0, 2))).toBeCloseTo(109.47, 1);
    // The carbon itself did not move.
    expect(at(geometry, 0)).toEqual([1, 2, 3]);
  });

  it("makes water and ammonia bent / pyramidal (lone pairs count)", () => {
    const water = addHydrogens({ elements: [8], positions: [0, 0, 0], bonds: [] }).geometry;
    expect(water.elements).toEqual([8, 1, 1]);
    expect(angle(dir(water, 0, 1), dir(water, 0, 2))).toBeCloseTo(109.47, 1);
    const ammonia = addHydrogens({ elements: [7], positions: [0, 0, 0], bonds: [] }).geometry;
    expect(ammonia.elements).toEqual([7, 1, 1, 1]);
  });

  it("completes a flat ethanol sketch: CH3 cone, CH2 above and below the plane, OH", () => {
    const l = 1.5;
    const sketch: MoleculeGeometry = {
      elements: [6, 6, 8],
      positions: [0, 0, 0, l * 0.866, l * 0.5, 0, 2 * l * 0.866, 0, 0],
      bonds: [
        [0, 1],
        [1, 2],
      ],
    };
    const { geometry, added } = addHydrogens(sketch, { planeNormal: [0, 0, 1] });
    expect(added).toBe(6);
    expect(geometry.elements.slice(0, 3)).toEqual([6, 6, 8]);
    expect(hydrogensOf(geometry, 0)).toHaveLength(3);
    expect(hydrogensOf(geometry, 1)).toHaveLength(2);
    expect(hydrogensOf(geometry, 2)).toHaveLength(1);
    const [up, down] = hydrogensOf(geometry, 1).map((h) => at(geometry, h));
    expect(up[2]).toBeGreaterThan(0.5);
    expect(down[2]).toBeLessThan(-0.5);
    // Every C–H / O–H is one covalent-radius sum long.
    for (const [i, h] of geometry.bonds.slice(2)) {
      expect(Math.hypot(...dir(geometry, i, h))).toBeCloseTo(hLength(geometry.elements[i]), 6);
    }
    // Heavy atoms are exactly where the sketch put them.
    expect(geometry.positions.slice(0, 9)).toEqual(sketch.positions);
  });

  it("keeps a double-bonded carbon's hydrogens in the plane and a triple bond linear", () => {
    const ethene = addHydrogens(
      {
        elements: [6, 6],
        positions: [0, 0, 0, 1.34, 0, 0],
        bonds: [[0, 1]],
        bondOrders: [2],
      },
      { planeNormal: [0, 0, 1] },
    ).geometry;
    expect(ethene.elements).toEqual([6, 6, 1, 1, 1, 1]);
    expect(ethene.bondOrders).toEqual([2, 1, 1, 1, 1]);
    for (let h = 2; h < 6; h++) expect(ethene.positions[h * 3 + 2]).toBeCloseTo(0, 6);
    expect(angle(dir(ethene, 0, 1), dir(ethene, 0, 2))).toBeCloseTo(120, 5);

    const ethyne = addHydrogens({
      elements: [6, 6],
      positions: [0, 0, 0, 1.2, 0, 0],
      bonds: [[0, 1]],
      bondOrders: [3],
    }).geometry;
    expect(ethyne.elements).toEqual([6, 6, 1, 1]);
    expect(at(ethyne, 2)[0]).toBeLessThan(0);
    expect(at(ethyne, 3)[0]).toBeGreaterThan(1.2);
  });

  it("gives benzene one in-plane hydrogen per carbon, Kekulé or aromatic", () => {
    const ring = (orders: number[]): MoleculeGeometry => {
      const positions: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        positions.push(1.4 * Math.cos(a), 1.4 * Math.sin(a), 0);
      }
      return {
        elements: [6, 6, 6, 6, 6, 6],
        positions,
        bonds: [0, 1, 2, 3, 4, 5].map((i) => [i, (i + 1) % 6] as [number, number]),
        bondOrders: orders,
      };
    };
    for (const orders of [
      [1, 2, 1, 2, 1, 2],
      [BOND_AROMATIC, BOND_AROMATIC, BOND_AROMATIC, BOND_AROMATIC, BOND_AROMATIC, BOND_AROMATIC],
    ]) {
      const { geometry, added } = addHydrogens(ring(orders), { planeNormal: [0, 0, 1] });
      expect(added).toBe(6);
      for (let c = 0; c < 6; c++) {
        const [h] = hydrogensOf(geometry, c);
        const p = at(geometry, h);
        expect(p[2]).toBeCloseTo(0, 6);
        // Pointing outward: farther from the ring centre than its carbon.
        expect(Math.hypot(p[0], p[1])).toBeGreaterThan(1.4);
      }
    }
  });

  it("respects formal charges and existing hydrogens, and leaves metals alone", () => {
    const { geometry, added } = addHydrogens(
      {
        // ammonium N⁺, alkoxide O⁻ on a carbon, an explicit H already on that carbon, sodium
        elements: [7, 6, 8, 1, 11],
        positions: [0, 0, 0, 5, 0, 0, 6.4, 0, 0, 4, 0, 0, 10, 0, 0],
        bonds: [
          [1, 2],
          [1, 3],
        ],
      },
      { charges: [1, 0, -1, 0, 0] },
    );
    expect(hydrogensOf(geometry, 0)).toHaveLength(4);
    expect(hydrogensOf(geometry, 1)).toHaveLength(3); // the explicit one plus two added
    expect(hydrogensOf(geometry, 2)).toHaveLength(0);
    expect(hydrogensOf(geometry, 4)).toHaveLength(0);
    expect(added).toBe(6);
  });

  it("returns a saturated molecule unchanged", () => {
    const methane = addHydrogens({ elements: [6], positions: [0, 0, 0], bonds: [] }).geometry;
    const again = addHydrogens(methane);
    expect(again.added).toBe(0);
    expect(again.geometry).toEqual(methane);
  });

  it("puts the hydrogen of a flat CH with three neighbours out of the plane", () => {
    const g = addHydrogens(
      {
        elements: [6, 6, 6, 6],
        positions: [0, 0, 0, 1.5, 0, 0, -0.75, 1.3, 0, -0.75, -1.3, 0],
        bonds: [
          [0, 1],
          [0, 2],
          [0, 3],
        ],
      },
      { planeNormal: [0, 0, 1] },
    ).geometry;
    const [h] = hydrogensOf(g, 0);
    expect(Math.abs(at(g, h)[2])).toBeCloseTo(hLength(6), 5);
  });

  it("ignores a bond between coincident atoms when orienting", () => {
    const g = addHydrogens({
      elements: [6, 6],
      positions: [0, 0, 0, 0, 0, 0],
      bonds: [[0, 1]],
    }).geometry;
    expect(hydrogensOf(g, 0)).toHaveLength(3);
    expect(hydrogensOf(g, 1)).toHaveLength(3);
  });
});
