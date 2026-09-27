/**
 * Numeric geometry editing: which atoms move together, setting a distance /
 * angle / dihedral, and the rigid fit used to put a re-embedded molecule back.
 */

import { describe, it, expect } from "vitest";
import {
  adjacency,
  molecules,
  moleculeOf,
  movingSide,
  reachable,
  setAngle,
  setDihedral,
  setDistance,
  superpose,
  unwrappedPositions,
  type Displacements,
} from "@/builder/geometry";
import { computeAngle, computeDihedral, computeDistance } from "@/renderer/Selection";
import type { Snapshot } from "@/types";

function snap(positions: number[], bonds: [number, number][]): Snapshot {
  const n = positions.length / 3;
  return {
    nAtoms: n,
    nBonds: bonds.length,
    nFileBonds: bonds.length,
    positions: new Float32Array(positions),
    elements: new Uint8Array(n).fill(6),
    bonds: new Uint32Array(bonds.flat()),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** A zig-zag butane-like chain 0–1–2–3 plus a stray atom 4 and a bonded pair 5–6. */
const chain = () =>
  snap(
    [0, 0, 0, 1.5, 0, 0, 2, 1.4, 0, 3.5, 1.4, 0.3, 10, 10, 10, 20, 0, 0, 21, 0, 0],
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [5, 6],
    ],
  );

/** Apply displacements to a copy of the positions. */
function moved(s: Snapshot, d: Displacements | null): Float32Array {
  const p = new Float32Array(s.positions);
  for (const [i, v] of d ?? []) for (let k = 0; k < 3; k++) p[i * 3 + k] += v[k];
  return p;
}

describe("connectivity", () => {
  it("builds neighbour lists and finds molecules", () => {
    const s = chain();
    expect(adjacency(s)[1]).toEqual([0, 2]);
    expect(molecules(s)).toEqual([[0, 1, 2, 3], [4], [5, 6]]);
    expect(moleculeOf(s, 2)).toEqual([0, 1, 2, 3]);
    expect(reachable(adjacency(s), 2, 1)).toEqual([2, 3]);
  });

  it("moves one side of a bond, or only the atom when a ring joins the sides", () => {
    expect(movingSide(chain(), 1, 2)).toEqual([2, 3]);
    const ring = snap(
      [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );
    expect(movingSide(ring, 0, 1)).toEqual([1]);
  });

  it("ignores bonds that point past the atoms", () => {
    const s = { ...chain(), nBonds: 5, bonds: new Uint32Array([0, 1, 1, 2, 2, 3, 5, 6, 0, 99]) };
    expect(adjacency(s)[0]).toEqual([1]);
  });
});

describe("setting values", () => {
  it("sets a distance by moving the far side along the bond", () => {
    const s = chain();
    const d = setDistance(s, 1, 2, 2.0);
    expect([...d!.keys()]).toEqual([2, 3]);
    const p = moved(s, d);
    expect(computeDistance(p, 1, 2)).toBeCloseTo(2.0, 5);
    // The moved side keeps its own shape.
    expect(computeDistance(p, 2, 3)).toBeCloseTo(computeDistance(s.positions, 2, 3), 5);
    expect(setDistance(s, 1, 2, 0)).toBeNull();
    expect(setDistance(snap([0, 0, 0, 0, 0, 0], []), 0, 1, 1)).toBeNull();
  });

  it("sets an angle by rotating the far side about the vertex", () => {
    const s = chain();
    const d = setAngle(s, 0, 1, 2, 100);
    const p = moved(s, d);
    expect(computeAngle(p, 0, 1, 2)).toBeCloseTo(100, 3);
    expect(computeDistance(p, 1, 2)).toBeCloseTo(computeDistance(s.positions, 1, 2), 5);
    expect(setAngle(s, 0, 1, 2, 180)).toBeNull();
    const line = snap([0, 0, 0, 1, 0, 0, 2, 0, 0], []);
    expect(setAngle(line, 0, 1, 2, 90)).toBeNull();
  });

  it("sets a dihedral by rotating the far side about the middle bond", () => {
    const s = chain();
    for (const target of [60, -120, 180]) {
      const p = moved(s, setDihedral(s, 0, 1, 2, 3, target));
      const got = computeDihedral(p, 0, 1, 2, 3);
      expect(Math.abs(((got - target + 540) % 360) - 180)).toBeLessThan(1e-3);
      expect(computeAngle(p, 1, 2, 3)).toBeCloseTo(computeAngle(s.positions, 1, 2, 3), 3);
    }
    expect(setDihedral(s, 0, 1, 2, 3, NaN)).toBeNull();
    const same = snap([0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 1, 0], []);
    expect(setDihedral(same, 0, 1, 2, 3, 30)).toBeNull();
  });
});

describe("superpose", () => {
  it("undoes a rotation and translation", () => {
    const ref = [0, 0, 0, 1.2, 0, 0, 1.6, 1.1, 0.2, -0.4, 0.9, -0.7];
    // Rotate 70° about z, then shift.
    const c = Math.cos(1.22);
    const s = Math.sin(1.22);
    const moving: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [x, y, z] = ref.slice(i * 3, i * 3 + 3);
      moving.push(c * x - s * y + 3, s * x + c * y - 2, z + 5);
    }
    const out = superpose(moving, ref);
    for (let k = 0; k < ref.length; k++) expect(out[k]).toBeCloseTo(ref[k], 5);
  });

  it("keeps an identical set in place", () => {
    const ref = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const out = superpose(ref, ref);
    for (let k = 0; k < ref.length; k++) expect(out[k]).toBeCloseTo(ref[k], 6);
  });
});

describe("unwrappedPositions", () => {
  it("puts each bonded atom at the image nearest its neighbour", () => {
    // A chain 0–1–2 crossing the x face of a 10 Å cube, plus an unbonded atom 3.
    const s = {
      ...snap(
        [9, 0, 0, 0.5, 0, 0, 1.5, 0, 0, 5, 5, 5],
        [
          [0, 1],
          [1, 2],
        ],
      ),
      box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    };
    expect(Array.from(unwrappedPositions(s, [0, 1, 2, 3]))).toEqual([
      9, 0, 0, 10.5, 0, 0, 11.5, 0, 0, 5, 5, 5,
    ]);
    // Walked from the first atom listed.
    expect(Array.from(unwrappedPositions(s, [2, 1, 0]))).toEqual([1.5, 0, 0, 0.5, 0, 0, -1, 0, 0]);
  });

  it("leaves positions alone without a usable cell", () => {
    const s = snap([9, 0, 0, 0.5, 0, 0], [[0, 1]]);
    expect(Array.from(unwrappedPositions(s, [0, 1]))).toEqual([9, 0, 0, 0.5, 0, 0]);
    const flat = { ...s, box: new Float32Array(9) };
    expect(Array.from(unwrappedPositions(flat, [0, 1]))).toEqual([9, 0, 0, 0.5, 0, 0]);
  });
});
