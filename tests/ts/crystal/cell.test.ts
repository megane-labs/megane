import { describe, it, expect } from "vitest";
import {
  boxToCellParams,
  cellParamsToBox,
  cross,
  det3,
  extGcd,
  gcd,
  inverse3,
  mul3,
  mulVec,
  pyFloorDiv,
  pyMod,
  wrapFrac,
} from "@/crystal/cell";

describe("cell parameters", () => {
  it("round-trips lengths and angles through lattice vectors", () => {
    const p = { a: 5.1, b: 6.2, c: 7.3, alpha: 80, beta: 95, gamma: 110 };
    const box = cellParamsToBox(p);
    // a along x, b in the xy plane (ASE's cellpar_to_cell orientation).
    expect(box[1]).toBe(0);
    expect(box[2]).toBe(0);
    expect(box[5]).toBe(0);
    const back = boxToCellParams(box);
    for (const k of Object.keys(p) as (keyof typeof p)[]) expect(back[k]).toBeCloseTo(p[k], 6);
  });

  it("keeps right angles exact and reports 90° for a zero vector", () => {
    const box = cellParamsToBox({ a: 2, b: 3, c: 4, alpha: 90, beta: 90, gamma: 90 });
    expect(box).toEqual([2, 0, 0, 0, 3, 0, 0, 0, 4]);
    expect(boxToCellParams([2, 0, 0, 0, 3, 0, 0, 0, 0]).alpha).toBe(90);
  });
});

describe("matrix helpers", () => {
  it("inverts, multiplies and rejects singular matrices", () => {
    const m = [2, 0, 0, 1, 3, 0, 0, 1, 4];
    const inv = inverse3(m)!;
    const id = mul3(m, inv);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, k) => expect(id[k]).toBeCloseTo(v, 12));
    expect(inverse3([1, 2, 3, 2, 4, 6, 0, 0, 1])).toBeNull();
    expect(det3([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(1);
    expect(mulVec([1, 2, 3], [1, 0, 0, 0, 1, 0, 0, 0, 1])).toEqual([1, 2, 3]);
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("wraps fractional coordinates with a top-face tolerance", () => {
    expect(wrapFrac(1.5)).toBeCloseTo(0.5, 12);
    expect(wrapFrac(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrapFrac(1 - 1e-12)).toBeCloseTo(0, 10);
    expect(wrapFrac(1 - 1e-3, 1e-6)).toBeCloseTo(0.999, 12);
  });
});

describe("integer helpers (Python semantics)", () => {
  it("gcd, floor division and modulo behave like Python's", () => {
    expect(gcd(12, -18)).toBe(6);
    expect(gcd(0, 5)).toBe(5);
    expect(pyMod(-7, 3)).toBe(2);
    expect(pyMod(7, -3)).toBe(-2);
    expect(pyFloorDiv(-7, 3)).toBe(-3);
  });

  it("extGcd matches ASE's ext_gcd", () => {
    expect(extGcd(1, 1)).toEqual([0, 1]);
    expect(extGcd(3, 0)).toEqual([1, 0]);
    expect(extGcd(0, 3)).toEqual([0, 1]);
    // x·a + y·b = gcd(a, b)
    for (const [a, b] of [
      [2, 1],
      [-1, 2],
      [3, 2],
      [7, 5],
      [-4, 6],
    ]) {
      const [x, y] = extGcd(a, b);
      expect(x * a + y * b).toBe(gcd(a, b) * (a % b === 0 && b !== 0 ? Math.sign(b) : 1));
    }
  });
});
