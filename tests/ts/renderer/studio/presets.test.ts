import { describe, it, expect } from "vitest";
import {
  STUDIO_PRESETS,
  STUDIO_STYLES,
  STUDIO_STYLE_LABELS,
  floorNormal,
  skyRadiance,
  type StudioSky,
} from "@/renderer/studio/presets";

describe("studio presets", () => {
  it("has a labelled, complete preset for every style", () => {
    for (const style of STUDIO_STYLES) {
      const p = STUDIO_PRESETS[style];
      expect(STUDIO_STYLE_LABELS[style]).toBeTruthy();
      expect(Math.hypot(...p.key.direction)).toBeCloseTo(1, 9);
      if (p.rim) expect(Math.hypot(...p.rim.direction)).toBeCloseTo(1, 9);
      expect(p.exposure).toBeGreaterThan(0);
      if (p.floor) {
        expect(p.floor.strength).toBeGreaterThan(0);
        expect(p.floor.strength).toBeLessThanOrEqual(1);
      }
    }
  });

  it("lights the illustrative style by the sky alone, with an outline and no ground", () => {
    const p = STUDIO_PRESETS.illustrative;
    expect(p.key.intensity).toBe(0);
    expect(p.specular).toBe(0);
    expect(p.outline).not.toBeNull();
    expect(p.floor).toBeNull();
  });

  it("keeps every key light in front of the subject, above the horizon", () => {
    for (const style of STUDIO_STYLES) {
      const [, y, z] = STUDIO_PRESETS[style].key.direction;
      expect(y).toBeGreaterThan(0);
      expect(z).toBeGreaterThan(0);
    }
  });
});

describe("skyRadiance", () => {
  const sky: StudioSky = {
    top: [1, 1, 1],
    horizon: [0.5, 0.5, 0.5],
    bottom: [0, 0, 0],
    intensity: 2,
  };

  it("blends horizon to top above and horizon to bottom below, times intensity", () => {
    expect(skyRadiance(sky, [0, 1, 0])).toEqual([2, 2, 2]);
    expect(skyRadiance(sky, [1, 0, 0])).toEqual([1, 1, 1]);
    expect(skyRadiance(sky, [0, -1, 0])).toEqual([0, 0, 0]);
    expect(skyRadiance(sky, [0, 0.5, 0])[0]).toBeCloseTo(1.5);
  });

  it("clamps an out-of-range direction", () => {
    expect(skyRadiance(sky, [0, -3, 0])).toEqual([0, 0, 0]);
    expect(skyRadiance(sky, [0, 3, 0])).toEqual([2, 2, 2]);
  });
});

describe("floorNormal", () => {
  it("tilts from straight up toward the viewer", () => {
    const flat = floorNormal(0);
    expect(flat[0]).toBeCloseTo(0);
    expect(flat[1]).toBeCloseTo(1);
    expect(flat[2]).toBeCloseTo(0);
    const backdrop = floorNormal(90);
    expect(backdrop[1]).toBeCloseTo(0);
    expect(backdrop[2]).toBeCloseTo(1);
    const n = floorNormal(40);
    expect(Math.hypot(...n)).toBeCloseTo(1);
    expect(n[2]).toBeCloseTo(Math.sin((40 * Math.PI) / 180));
  });
});
