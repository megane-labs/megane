import { describe, expect, it } from "vitest";
import { computeFrameDistanceBonds } from "@/pipeline/executors/addBond";

describe("computeFrameDistanceBonds", () => {
  it("infers bonds for a frame without a box", () => {
    // O-H at 1.0 Å bonds under the default VDW scale; the far atom stays free.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 10, 0, 0]);
    const elements = new Uint8Array([8, 1, 1]);

    const result = computeFrameDistanceBonds(positions, elements, 3, null);

    expect(result.nBonds).toBe(1);
    expect(Array.from(result.bondIndices)).toEqual([0, 1]);
    // No PBC processing → no ghost atoms appended.
    expect(result.positions).toBeNull();
    expect(result.nAtoms).toBe(0);
  });

  it("splits a periodic-image bond into two half-bonds with ghost endpoints", () => {
    // Two atoms near opposite faces of a 10 Å box bond across the boundary.
    const positions = new Float32Array([0.2, 0, 0, 9.5, 0, 0]);
    const elements = new Uint8Array([8, 1]);
    const box = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

    const result = computeFrameDistanceBonds(positions, elements, 2, box);

    expect(result.nBonds).toBe(2);
    expect(result.nAtoms).toBe(4);
    expect(Array.from(result.bondIndices)).toEqual([0, 2, 1, 3]);
    // Ghost of atom 1 sits at its minimum image next to atom 0.
    expect(result.positions![2 * 3]).toBeCloseTo(-0.5, 5);
    expect(result.elements![2]).toBe(1);
    // Ghost of atom 0 sits at its minimum image next to atom 1.
    expect(result.positions![3 * 3]).toBeCloseTo(10.2, 5);
    expect(result.elements![3]).toBe(8);
  });

  it("keeps ghost indices on their ghosts when the buffers hold more than nAtoms", () => {
    // Atoms 0 and 1 bond across the x face; atom 2 lies past nAtoms (an atom a
    // later frame added, seen with an older atom count). Ghost index 2 must be
    // atom 1's image next to atom 0, not atom 2.
    const positions = new Float32Array([0.2, 0, 0, 9.5, 0, 0, 5, 5, 9]);
    const elements = new Uint8Array([8, 1, 18]);
    const box = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

    const result = computeFrameDistanceBonds(positions, elements, 2, box);

    expect(Array.from(result.bondIndices)).toEqual([0, 2, 1, 3]);
    expect(result.nAtoms).toBe(4);
    expect(result.positions).toHaveLength(4 * 3);
    expect(Array.from(result.positions!.subarray(2 * 3, 3 * 3))).toEqual([
      expect.closeTo(-0.5, 5),
      0,
      0,
    ]);
    expect(Array.from(result.positions!.subarray(3 * 3, 4 * 3))).toEqual([
      expect.closeTo(10.2, 5),
      0,
      0,
    ]);
    expect(Array.from(result.elements!)).toEqual([8, 1, 1, 8]);
  });

  it("respects an explicit VDW scale", () => {
    // 1.8 Å O-O: bonded at a generous scale, not at a tiny one.
    const positions = new Float32Array([0, 0, 0, 1.8, 0, 0]);
    const elements = new Uint8Array([8, 8]);

    expect(computeFrameDistanceBonds(positions, elements, 2, null, 0.8).nBonds).toBe(1);
    expect(computeFrameDistanceBonds(positions, elements, 2, null, 0.1).nBonds).toBe(0);
  });
});
