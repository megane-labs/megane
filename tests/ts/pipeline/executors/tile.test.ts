import { describe, it, expect } from "vitest";
import { tileArray, tileIndices } from "@/pipeline/executors/tile";

describe("tileIndices", () => {
  it("shifts each copy by the image's atom offset", () => {
    expect(Array.from(tileIndices(new Uint32Array([0, 2]), 3, 3))).toEqual([0, 2, 3, 5, 6, 8]);
  });

  it("returns an empty array for zero images", () => {
    expect(tileIndices(new Uint32Array([1]), 4, 0)).toHaveLength(0);
  });
});

describe("tileArray", () => {
  it.each([
    [new Float32Array([0.5, 1]), [0.5, 1, 0.5, 1]],
    [new Uint8Array([7]), [7, 7]],
    [new Uint32Array([1, 2]), [1, 2, 1, 2]],
  ])("repeats %s and keeps its type", (arr, expected) => {
    const out = tileArray(arr, 2);
    expect(out.constructor).toBe(arr.constructor);
    expect(Array.from(out)).toEqual(expected);
    expect(out).not.toBe(arr);
  });
});
