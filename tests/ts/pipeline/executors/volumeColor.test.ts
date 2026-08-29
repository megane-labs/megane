import { describe, it, expect } from "vitest";
import {
  invert3x3,
  createVolumeSampler,
  colormapColor,
  computeAutoRange,
  colorVerticesByVolume,
  isDivergingColormap,
  VOLUME_COLORMAP_LABELS,
} from "@/pipeline/executors/volumeColor";
import type { VolumetricData } from "@/pipeline/types";

const UNIT_STEP = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const ORIGIN_ZERO = new Float32Array([0, 0, 0]);

/** Gradient field value = ix (linear along x, constant in y/z). */
function makeVol(overrides: Partial<VolumetricData> = {}): VolumetricData {
  const nx = 3,
    ny = 3,
    nz = 3;
  const data = new Float32Array(nx * ny * nz);
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        data[ix * ny * nz + iy * nz + iz] = ix;
      }
    }
  }
  return {
    type: "volumetric",
    nx,
    ny,
    nz,
    origin: ORIGIN_ZERO,
    step: UNIT_STEP,
    data,
    dataMin: 0,
    dataMax: nx - 1,
    ...overrides,
  };
}

describe("invert3x3", () => {
  it("inverts the identity to itself", () => {
    const inv = invert3x3(UNIT_STEP)!;
    expect(inv).not.toBeNull();
    expect(Array.from(inv)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("inverts a diagonal scaling matrix", () => {
    const inv = invert3x3([2, 0, 0, 0, 4, 0, 0, 0, 0.5])!;
    expect(inv[0]).toBeCloseTo(0.5);
    expect(inv[4]).toBeCloseTo(0.25);
    expect(inv[8]).toBeCloseTo(2);
  });

  it("inverts a non-orthogonal matrix (M * M⁻¹ = I)", () => {
    const m = [1, 0.2, 0, 0.1, 1, 0.3, 0, 0.2, 1];
    const inv = invert3x3(m)!;
    expect(inv).not.toBeNull();
    // Multiply m * inv and compare to identity.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += m[r * 3 + k] * inv[k * 3 + c];
        expect(s).toBeCloseTo(r === c ? 1 : 0, 6);
      }
    }
  });

  it("returns null for a singular matrix", () => {
    expect(invert3x3([1, 0, 0, 2, 0, 0, 0, 0, 1])).toBeNull();
  });
});

describe("createVolumeSampler", () => {
  it("reproduces exact grid-point values", () => {
    const sample = createVolumeSampler(makeVol())!;
    expect(sample(0, 0, 0)).toBeCloseTo(0);
    expect(sample(1, 1, 1)).toBeCloseTo(1);
    expect(sample(2, 2, 2)).toBeCloseTo(2);
  });

  it("interpolates linearly between grid points", () => {
    const sample = createVolumeSampler(makeVol())!;
    expect(sample(0.5, 0, 0)).toBeCloseTo(0.5);
    expect(sample(1.25, 1, 1)).toBeCloseTo(1.25);
  });

  it("clamps points outside the grid to the boundary value", () => {
    const sample = createVolumeSampler(makeVol())!;
    expect(sample(-5, 0, 0)).toBeCloseTo(0);
    expect(sample(50, 1, 1)).toBeCloseTo(2);
  });

  it("respects a non-zero origin", () => {
    const sample = createVolumeSampler(makeVol({ origin: new Float32Array([10, 10, 10]) }))!;
    expect(sample(10, 10, 10)).toBeCloseTo(0);
    expect(sample(11.5, 10, 10)).toBeCloseTo(1.5);
  });

  it("handles a non-orthogonal step lattice", () => {
    // stepX has a y-shear; grid point (1,0,0) sits at world (1, 0.5, 0).
    const step = new Float32Array([1, 0.5, 0, 0, 1, 0, 0, 0, 1]);
    const sample = createVolumeSampler(makeVol({ step }))!;
    expect(sample(1, 0.5, 0)).toBeCloseTo(1);
    expect(sample(2, 1, 0)).toBeCloseTo(2);
  });

  it("returns null for a singular step matrix", () => {
    const step = new Float32Array([1, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(createVolumeSampler(makeVol({ step }))).toBeNull();
  });

  it("returns null when the data array is shorter than the grid", () => {
    expect(createVolumeSampler(makeVol({ data: new Float32Array(5) }))).toBeNull();
  });
});

describe("colormapColor", () => {
  it("rwb runs red → white → blue", () => {
    expect(colormapColor(0, "rwb")[0]).toBeGreaterThan(0.5); // red end
    expect(colormapColor(0.5, "rwb")).toEqual([1, 1, 1]); // white middle
    expect(colormapColor(1, "rwb")[2]).toBeGreaterThan(0.5); // blue end
  });

  it("bwr is the reverse of rwb", () => {
    const pairs: Array<[number, number]> = [
      [0, 1],
      [1, 0],
      [0.25, 0.75],
    ];
    for (const [tB, tR] of pairs) {
      const bwr = colormapColor(tB, "bwr");
      const rwb = colormapColor(tR, "rwb");
      for (let c = 0; c < 3; c++) expect(bwr[c]).toBeCloseTo(rwb[c], 6);
    }
  });

  it("rainbow runs blue → red", () => {
    expect(colormapColor(0, "rainbow")[2]).toBeGreaterThan(0.5); // blue end
    expect(colormapColor(1, "rainbow")[0]).toBeGreaterThan(0.5); // red end
  });

  it("clamps t outside [0, 1]", () => {
    expect(colormapColor(-3, "rwb")).toEqual(colormapColor(0, "rwb"));
    expect(colormapColor(7, "rwb")).toEqual(colormapColor(1, "rwb"));
  });

  it("maps non-finite t to the midpoint", () => {
    expect(colormapColor(NaN, "rwb")).toEqual(colormapColor(0.5, "rwb"));
  });

  it("has a label for every colormap", () => {
    expect(Object.keys(VOLUME_COLORMAP_LABELS).sort()).toEqual(["bwr", "rainbow", "rwb"]);
  });
});

describe("isDivergingColormap", () => {
  it("classifies rwb/bwr as diverging and rainbow as sequential", () => {
    expect(isDivergingColormap("rwb")).toBe(true);
    expect(isDivergingColormap("bwr")).toBe(true);
    expect(isDivergingColormap("rainbow")).toBe(false);
  });
});

describe("computeAutoRange", () => {
  it("is symmetric around zero for diverging maps", () => {
    expect(computeAutoRange([-0.2, 0.7], "rwb")).toEqual([-0.7, 0.7]);
    expect(computeAutoRange([-0.9, 0.1], "bwr")).toEqual([-0.9, 0.9]);
  });

  it("spans min..max for the rainbow map", () => {
    expect(computeAutoRange([-0.2, 0.7], "rainbow")).toEqual([-0.2, 0.7]);
  });

  it("skips non-finite values", () => {
    expect(computeAutoRange([NaN, -0.5, Infinity, 0.25], "rwb")).toEqual([-0.5, 0.5]);
  });

  it("falls back on empty input", () => {
    expect(computeAutoRange([], "rwb")).toEqual([-1, 1]);
    expect(computeAutoRange([], "rainbow")).toEqual([0, 1]);
  });

  it("widens a degenerate all-equal range", () => {
    expect(computeAutoRange([0, 0, 0], "rwb")).toEqual([-1, 1]);
    expect(computeAutoRange([3, 3], "rainbow")).toEqual([3, 4]);
  });
});

describe("colorVerticesByVolume", () => {
  // Two vertices at the two ends of the x-gradient field.
  const positions = new Float32Array([0, 1, 1, 2, 1, 1]);

  it("fills RGBA colors mapped through the colormap and returns the range", () => {
    const colors = new Float32Array(2 * 4);
    const range = colorVerticesByVolume(positions, colors, 0.6, makeVol(), "rainbow");
    expect(range).toEqual([0, 2]);
    // Vertex 0 samples 0 (blue end), vertex 1 samples 2 (red end).
    expect(colors[2]).toBeGreaterThan(0.5); // v0 blue channel
    expect(colors[4]).toBeGreaterThan(0.5); // v1 red channel
    expect(colors[3]).toBeCloseTo(0.6); // alpha = opacity
    expect(colors[7]).toBeCloseTo(0.6);
  });

  it("honors an explicit range", () => {
    const colors = new Float32Array(2 * 4);
    const range = colorVerticesByVolume(positions, colors, 1, makeVol(), "rainbow", [0, 4]);
    expect(range).toEqual([0, 4]);
    // Vertex 1 samples 2 → t = 0.5, the green stop.
    expect(colors[5]).toBeGreaterThan(0.5);
  });

  it("ignores an invalid explicit range and auto-computes", () => {
    const colors = new Float32Array(2 * 4);
    expect(colorVerticesByVolume(positions, colors, 1, makeVol(), "rainbow", [2, 2])).toEqual([
      0, 2,
    ]);
    expect(colorVerticesByVolume(positions, colors, 1, makeVol(), "rainbow", [NaN, 1])).toEqual([
      0, 2,
    ]);
  });

  it("uses a symmetric auto range for the diverging maps", () => {
    const colors = new Float32Array(2 * 4);
    const range = colorVerticesByVolume(positions, colors, 1, makeVol(), "rwb");
    expect(range).toEqual([-2, 2]);
    // Vertex 0 samples 0 → the white midpoint of rwb.
    expect(colors[0]).toBeCloseTo(1);
    expect(colors[1]).toBeCloseTo(1);
    expect(colors[2]).toBeCloseTo(1);
  });

  it("returns null and leaves colors untouched for an unusable volume", () => {
    const colors = new Float32Array(2 * 4).fill(0.5);
    const bad = makeVol({ step: new Float32Array([1, 0, 0, 1, 0, 0, 0, 0, 1]) });
    expect(colorVerticesByVolume(positions, colors, 1, bad, "rwb")).toBeNull();
    expect(colors.every((c) => c === 0.5)).toBe(true);
  });
});
