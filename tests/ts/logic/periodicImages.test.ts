import { describe, expect, it } from "vitest";
import { positionsWithPeriodicImages } from "@/logic/periodicImages";

const BOX = [4, 0, 0, 0, 5, 0, 1, 0, 6]; // row-major a, b, c (c tilted along x)

describe("positionsWithPeriodicImages", () => {
  it("appends each copy at its source atom plus its lattice shift", () => {
    const positions = new Float32Array([0, 0, 0, 1, 2, 3]);
    const images = {
      sourceIndices: new Uint32Array([1, 0]),
      latticeShifts: new Int32Array([1, 0, 0, -1, 1, 1]),
    };
    const out = positionsWithPeriodicImages(positions, 2, images, BOX);
    expect(Array.from(out)).toEqual([0, 0, 0, 1, 2, 3, 5, 2, 3, -3, 5, 6]);
  });

  it("reuses an output buffer of the right length and replaces one of the wrong length", () => {
    const images = {
      sourceIndices: new Uint32Array([0]),
      latticeShifts: new Int32Array([0, 0, 1]),
    };
    const out = new Float32Array(6);
    const first = positionsWithPeriodicImages(new Float32Array([1, 1, 1]), 1, images, BOX, out);
    expect(first).toBe(out);
    expect(Array.from(out)).toEqual([1, 1, 1, 2, 1, 7]);
    const wrong = new Float32Array(3);
    const second = positionsWithPeriodicImages(new Float32Array([1, 1, 1]), 1, images, BOX, wrong);
    expect(second).not.toBe(wrong);
    expect(second.length).toBe(6);
  });

  it("only copies the first nAtoms atoms before the images", () => {
    const images = { sourceIndices: new Uint32Array(0), latticeShifts: new Int32Array(0) };
    const out = positionsWithPeriodicImages(new Float32Array([1, 2, 3, 4, 5, 6]), 1, images, BOX);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
