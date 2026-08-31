import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  CHROMA_BOOST,
  RIM_POWER,
  RIM_STRENGTH,
  SHININESS,
  SPECULAR_STRENGTH,
  createSurfaceMaterial,
  surfaceFragmentShader,
  surfaceVertexShader,
} from "@/renderer/surfaceMaterial";

describe("createSurfaceMaterial", () => {
  it("blends without writing depth, so a surface never occludes what is behind it", () => {
    const mat = createSurfaceMaterial(0.4, THREE.FrontSide);
    expect(mat.transparent).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.side).toBe(THREE.FrontSide);
  });

  it("carries the requested opacity and the tuning constants as uniforms", () => {
    const mat = createSurfaceMaterial(0.35, THREE.BackSide);
    expect(mat.uniforms.uOpacity.value).toBeCloseTo(0.35);
    expect(mat.uniforms.uRimPower.value).toBe(RIM_POWER);
    expect(mat.uniforms.uRimStrength.value).toBe(RIM_STRENGTH);
    expect(mat.uniforms.uChromaBoost.value).toBe(CHROMA_BOOST);
    expect(mat.uniforms.uSpecular.value).toBe(SPECULAR_STRENGTH);
    expect(mat.uniforms.uShininess.value).toBe(SHININESS);
    expect(mat.side).toBe(THREE.BackSide);
  });

  it("each call owns its uniforms, so the two face passes stay independent", () => {
    const back = createSurfaceMaterial(0.2, THREE.BackSide);
    const front = createSurfaceMaterial(0.9, THREE.FrontSide);
    expect(back.uniforms.uOpacity.value).toBeCloseTo(0.2);
    expect(front.uniforms.uOpacity.value).toBeCloseTo(0.9);
    expect(back.uniforms).not.toBe(front.uniforms);
  });

  it("declares the per-vertex colour attribute itself rather than via vertexColors", () => {
    // three.js emits its own `attribute vec3 color;` when material.vertexColors
    // is set, which would collide with the declaration in our shader source.
    const mat = createSurfaceMaterial(1, THREE.DoubleSide);
    expect(mat.vertexColors).toBe(false);
    expect(surfaceVertexShader).toContain("attribute vec3 color;");
  });
});

describe("surface shader source", () => {
  it("reads every uniform the material supplies", () => {
    const mat = createSurfaceMaterial(0.5, THREE.FrontSide);
    const src = surfaceVertexShader + surfaceFragmentShader;
    for (const name of Object.keys(mat.uniforms)) {
      expect(src, `${name} is declared but never used`).toContain(name);
    }
  });

  it("keeps hue by renormalising rather than clamping the boosted colour", () => {
    // A per-channel clamp would shift the hue of any colour the chroma boost
    // pushes past 1; dividing by the peak channel cannot.
    expect(surfaceFragmentShader).toContain("boosted /= max(max(max(boosted.r");
  });
});

/**
 * The chroma compensation is GLSL, so mirror its algebra here to pin the
 * properties the shading depends on. `alpha(2 - alpha)` is the fraction of the
 * surface's own colour that survives two blended layers, and the boost is its
 * inverse, capped.
 */
function chromaBoost(alpha: number, cap = CHROMA_BOOST): number {
  return Math.min(1 / Math.max(alpha * (2 - alpha), 1e-3), cap);
}

describe("chroma compensation curve", () => {
  it("leaves an opaque surface's colour exactly as authored", () => {
    expect(chromaBoost(1)).toBeCloseTo(1, 6);
  });

  it("never desaturates: the boost is always at least 1", () => {
    for (let a = 0; a <= 1.0001; a += 0.05) {
      expect(chromaBoost(a)).toBeGreaterThanOrEqual(1);
    }
  });

  it("rises monotonically as the surface fades", () => {
    let prev = chromaBoost(1);
    for (let a = 0.95; a > 0; a -= 0.05) {
      const boost = chromaBoost(a);
      expect(boost).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = boost;
    }
  });

  it("holds apparent chroma level until the cap bites", () => {
    // Below the cap, boost × surviving fraction is exactly 1: the viewer sees
    // the same saturation at 0.5 opacity as at 1.0.
    for (const a of [1.0, 0.8, 0.6, 0.5]) {
      expect(chromaBoost(a) * a * (2 - a)).toBeCloseTo(1, 6);
    }
  });

  it("caps the boost so a faint surface still reads as transparent", () => {
    expect(chromaBoost(0.1)).toBe(CHROMA_BOOST);
    expect(chromaBoost(0.001)).toBe(CHROMA_BOOST);
    // And the guard keeps alpha = 0 finite instead of dividing by zero.
    expect(Number.isFinite(chromaBoost(0))).toBe(true);
  });
});
