import { describe, it, expect } from "vitest";
import {
  coneDirection,
  halton,
  normalize,
  pixelJitter,
  seededRandom,
  sphereDirections,
  type Vec3,
} from "@/renderer/studio/sampling";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

describe("halton", () => {
  it("follows the radical inverse in base 2 and 3", () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
    expect(halton(1, 3)).toBeCloseTo(1 / 3);
    expect(halton(2, 3)).toBeCloseTo(2 / 3);
    expect(halton(3, 3)).toBeCloseTo(1 / 9);
    expect(halton(0, 2)).toBe(0);
  });
});

describe("pixelJitter", () => {
  it("starts at the pixel centre and stays inside the pixel", () => {
    const j = pixelJitter(64);
    expect(j).toHaveLength(64);
    expect(j[0]).toEqual([0, 0]);
    for (const [x, y] of j) {
      expect(x).toBeGreaterThanOrEqual(-0.5);
      expect(x).toBeLessThan(0.5);
      expect(y).toBeGreaterThanOrEqual(-0.5);
      expect(y).toBeLessThan(0.5);
    }
    // Low discrepancy: no two offsets coincide.
    expect(new Set(j.map((p) => p.join(","))).size).toBe(64);
  });
});

describe("seededRandom", () => {
  it("is reproducible per seed and stays in [0, 1)", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const sa = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).toEqual(sa);
    expect(Array.from({ length: 20 }, c)).not.toEqual(sa);
    for (const v of sa) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sphereDirections", () => {
  it("returns unit vectors that cover the whole sphere evenly", () => {
    const dirs = sphereDirections(512, seededRandom(1));
    expect(dirs).toHaveLength(512);
    const mean: Vec3 = [0, 0, 0];
    for (const d of dirs) {
      expect(len(d)).toBeCloseTo(1, 6);
      for (let k = 0; k < 3; k++) mean[k] += d[k] / dirs.length;
    }
    expect(len(mean)).toBeLessThan(0.02);
    // Every octant gets roughly an eighth.
    const octants = new Array(8).fill(0);
    for (const d of dirs) octants[(d[0] > 0 ? 1 : 0) + (d[1] > 0 ? 2 : 0) + (d[2] > 0 ? 4 : 0)]++;
    for (const n of octants) expect(Math.abs(n - 64)).toBeLessThan(12);
  });

  it("shuffles so a prefix still covers both hemispheres", () => {
    const dirs = sphereDirections(256, seededRandom(3)).slice(0, 32);
    const up = dirs.filter((d) => d[1] > 0).length;
    expect(up).toBeGreaterThan(8);
    expect(up).toBeLessThan(24);
  });

  it("uses Math.random when no generator is passed", () => {
    expect(sphereDirections(4)).toHaveLength(4);
  });
});

describe("normalize", () => {
  it("scales to unit length and maps the zero vector to +z", () => {
    expect(normalize([3, 0, 4])).toEqual([0.6, 0, 0.8]);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 1]);
  });
});

describe("coneDirection", () => {
  it("returns the axis itself for a zero-size light", () => {
    expect(coneDirection([0, 2, 0], 0, 0.3, 0.7)).toEqual([0, 1, 0]);
  });

  it("stays inside the cone and reaches its rim", () => {
    const axis = normalize([-0.5, 0.7, 0.5]);
    const half = (10 * Math.PI) / 180;
    const rand = seededRandom(5);
    let widest = 1;
    for (let i = 0; i < 200; i++) {
      const d = coneDirection(axis, half, rand(), rand());
      expect(len(d)).toBeCloseTo(1, 6);
      const c = dot(d, axis);
      expect(c).toBeGreaterThanOrEqual(Math.cos(half) - 1e-9);
      widest = Math.min(widest, c);
    }
    expect(widest).toBeLessThan(Math.cos(half * 0.8));
    // u = 1 is exactly on the rim; u = 0 on the axis.
    expect(dot(coneDirection(axis, half, 1, 0.25), axis)).toBeCloseTo(Math.cos(half), 9);
    expect(dot(coneDirection(axis, half, 0, 0.25), axis)).toBeCloseTo(1, 9);
  });

  it("handles an axis along y (the alternate reference vector)", () => {
    const d = coneDirection([1, 0, 0], 0.2, 0.5, 0.5);
    expect(dot(d, [1, 0, 0])).toBeGreaterThan(Math.cos(0.2) - 1e-9);
    const e = coneDirection([0, 1, 0], 0.2, 0.5, 0.5);
    expect(dot(e, [0, 1, 0])).toBeGreaterThan(Math.cos(0.2) - 1e-9);
  });
});
