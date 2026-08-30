import { describe, it, expect } from "vitest";
import {
  atomVertexShader,
  atomFragmentShader,
  bondVertexShader,
  bondFragmentShader,
} from "@/renderer/shaders";

const ALL_SHADERS = {
  atomVertexShader,
  atomFragmentShader,
  bondVertexShader,
  bondFragmentShader,
};

describe("shaders module", () => {
  it("exports four non-empty GLSL strings", () => {
    for (const [name, src] of Object.entries(ALL_SHADERS)) {
      expect(typeof src, name).toBe("string");
      expect(src.length, name).toBeGreaterThan(0);
    }
  });

  it("declares high precision floats and ints (RawShaderMaterial requires explicit precision)", () => {
    for (const [name, src] of Object.entries(ALL_SHADERS)) {
      expect(src, name).toMatch(/precision\s+highp\s+float/);
    }
  });

  it("vertex shaders write gl_Position", () => {
    expect(atomVertexShader).toMatch(/gl_Position\s*=/);
    expect(bondVertexShader).toMatch(/gl_Position\s*=/);
  });

  it("fragment shaders declare an `out` color and assign it", () => {
    expect(atomFragmentShader).toMatch(/out\s+vec4\s+fragColor/);
    expect(atomFragmentShader).toMatch(/fragColor\s*=/);
    expect(bondFragmentShader).toMatch(/out\s+vec4\s+fragColor/);
    expect(bondFragmentShader).toMatch(/fragColor\s*=/);
  });
});

describe("atom shaders", () => {
  it("vertex shader declares per-instance attributes consumed by InstancedBufferGeometry", () => {
    const required = [
      "instanceCenter",
      "instanceRadius",
      "instanceColor",
      "instanceScaleOverride",
      "instanceOpacityOverride",
    ];
    for (const attr of required) {
      expect(atomVertexShader, attr).toMatch(new RegExp(`\\bin\\b[^;]*\\b${attr}\\b`));
    }
  });

  it("vertex shader passes through varyings used by the fragment shader", () => {
    const varyings = ["vColor", "vUv", "vRadius", "vViewCenter", "vOpacityOverride"];
    for (const v of varyings) {
      expect(atomVertexShader, `${v} out`).toMatch(new RegExp(`\\bout\\b[^;]*\\b${v}\\b`));
      expect(atomFragmentShader, `${v} in`).toMatch(new RegExp(`\\bin\\b[^;]*\\b${v}\\b`));
    }
  });

  it("vertex shader gates per-atom overrides on uUsePerAtomOverrides", () => {
    expect(atomVertexShader).toMatch(/uUsePerAtomOverrides\s*==\s*1/);
    expect(atomFragmentShader).toMatch(/uUsePerAtomOverrides\s*==\s*1/);
  });

  it("fragment shader writes gl_FragDepth for correct depth on impostor spheres", () => {
    expect(atomFragmentShader).toMatch(/gl_FragDepth\s*=/);
  });

  it("fragment shader discards pixels outside the unit disk (impostor mask)", () => {
    // dot(vUv, vUv) > 1.0 → outside the sphere silhouette → discard
    expect(atomFragmentShader).toMatch(/dot\(vUv,\s*vUv\)/);
    expect(atomFragmentShader).toMatch(/discard/);
  });
});

describe("atom shader — illustrative branch", () => {
  it("takes the silhouette derivative before the discard", () => {
    // GLSL ES 3.0 leaves derivatives undefined once a fragment in the 2x2 quad
    // has terminated, so fwidth() must run in uniform control flow or the
    // outline flickers along the very edge it traces.
    const fwidthAt = atomFragmentShader.indexOf("fwidth(");
    // The statement, not the word — the comment above it also says "discard".
    const discardAt = atomFragmentShader.indexOf("discard;");
    expect(fwidthAt).toBeGreaterThan(-1);
    expect(discardAt).toBeGreaterThan(-1);
    expect(fwidthAt).toBeLessThan(discardAt);
  });

  it("shades toward the rim before compositing the outline", () => {
    // The rim ramp stands in for the SSAO pass megane has no post-processing
    // stack for; without it the mode is a field of flat discs.
    expect(atomFragmentShader).toContain("uAmbientDarkening");
    const shadeAt = atomFragmentShader.indexOf("uAmbientDarkening");
    const outlineAt = atomFragmentShader.indexOf("uOutlineColor, edge");
    expect(outlineAt).toBeGreaterThan(shadeAt);
  });

  it("keeps the lit path free of the illustrative uniforms", () => {
    // Everything illustrative must sit behind uIllustrative and return early,
    // so ball-and-stick renders byte-identically to before the mode existed.
    const branchAt = atomFragmentShader.indexOf("uIllustrative == 1");
    const hemisphereAt = atomFragmentShader.indexOf("skyColor");
    expect(branchAt).toBeGreaterThan(-1);
    expect(branchAt).toBeLessThan(hemisphereAt);
    expect(atomFragmentShader.slice(hemisphereAt)).not.toContain("uAmbientDarkening");
  });
});

describe("bond shaders", () => {
  it("vertex shader declares per-instance attributes used for endpoint lookups", () => {
    const required = [
      "instanceAtomA",
      "instanceAtomB",
      "instanceOffsetX",
      "instanceOffsetY",
      "instanceColorA",
      "instanceColorB",
      "instanceRadius",
      "instanceDashed",
      "instanceBondOpacity",
    ];
    for (const attr of required) {
      expect(bondVertexShader, attr).toMatch(new RegExp(`\\bin\\b[^;]*\\b${attr}\\b`));
    }
  });

  it("splits the bond into two endpoint colors via vColorA / vColorB varyings", () => {
    for (const v of ["vColorA", "vColorB"]) {
      expect(bondVertexShader, `${v} out`).toMatch(new RegExp(`\\bout\\b[^;]*\\b${v}\\b`));
      expect(bondFragmentShader, `${v} in`).toMatch(new RegExp(`\\bin\\b[^;]*\\b${v}\\b`));
    }
    // The midpoint split (computed from the ray-cast hit's axial position)
    // decides which endpoint color a fragment uses.
    expect(bondFragmentShader).toMatch(/tAxial\s*<\s*0\.0\s*\?\s*vColorA\s*:\s*vColorB/);
  });

  it("vertex shader fetches atom positions from the position texture", () => {
    expect(bondVertexShader).toMatch(/uPositionTex\b/);
    expect(bondVertexShader).toMatch(/texelFetch\(/);
  });

  it("fragment shader supports dashed bonds via vDashed varying", () => {
    expect(bondVertexShader).toMatch(/\bout\b[^;]*\bvDashed\b/);
    expect(bondFragmentShader).toMatch(/\bin\b[^;]*\bvDashed\b/);
    expect(bondFragmentShader).toMatch(/discard/);
  });

  it("fragment shader respects per-bond opacity gating on uUsePerBondOverrides", () => {
    expect(bondFragmentShader).toMatch(/uUsePerBondOverrides\s*==\s*1/);
  });

  it("fragment shader writes gl_FragDepth from the ray-cast hit so cylinders join spheres seamlessly", () => {
    // Per-fragment depth from the real cylinder surface lets the stick occlude
    // the atom sphere's inner hemisphere, so the sphere caps the tube instead of
    // sitting on top of it.
    expect(bondFragmentShader).toMatch(/gl_FragDepth\s*=/);
  });

  it("passes the view-space cylinder + billboard ray position to the fragment shader", () => {
    const frameVaryings = ["vViewMid", "vAxisDir", "vRadius", "vHalfLen", "vViewRayPos"];
    for (const v of frameVaryings) {
      expect(bondVertexShader, `${v} out`).toMatch(new RegExp(`\\bout\\b[^;]*\\b${v}\\b`));
      expect(bondFragmentShader, `${v} in`).toMatch(new RegExp(`\\bin\\b[^;]*\\b${v}\\b`));
    }
    // The fragment must declare projectionMatrix to project the hit point.
    expect(bondFragmentShader).toMatch(/uniform\s+mat4\s+projectionMatrix/);
  });

  it("ray-casts the analytic cylinder (correct for tilted bonds) and handles ortho vs perspective", () => {
    // A flat billboard parameterization mis-places the surface for tilted bonds.
    // The fragment must solve a ray-cylinder quadratic (discriminant) and pick a
    // camera ray per projection type.
    expect(bondFragmentShader).toMatch(/disc\s*=\s*b\s*\*\s*b\s*-\s*4\.0\s*\*\s*a\s*\*\s*c/);
    expect(bondFragmentShader).toMatch(/projectionMatrix\[2\]\[3\]\s*==\s*0\.0/);
    // The old flat-billboard varyings must be gone.
    expect(bondFragmentShader).not.toMatch(/vCylUv/);
    expect(bondFragmentShader).not.toMatch(/vSideDir/);
  });
});
