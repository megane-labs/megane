import { describe, it, expect } from "vitest";
import { atomFragmentShader, bondFragmentShader } from "@/renderer/shaders";
import {
  accumulateFragmentShader,
  compositeFragmentShader,
  fullscreenVertexShader,
  resolveFragmentShader,
  shadowCasterVertexShader,
  stochasticShadowFragmentShader,
  surfaceAlbedoFragmentShader,
  surfaceAlbedoVertexShader,
  translucentFragmentShader,
  translucentVertexShader,
} from "@/renderer/studio/studioShaders";

describe("impostor shaders: studio passes", () => {
  it("both impostors declare uPass and route through studioPass after the depth write", () => {
    for (const [name, src] of Object.entries({ atomFragmentShader, bondFragmentShader })) {
      expect(src, name).toContain("uniform int uPass;");
      expect(src, name).toContain("bool studioPass(");
      const depth = src.indexOf("gl_FragDepth =");
      const pass = src.indexOf("if (studioPass(");
      expect(depth, name).toBeGreaterThan(0);
      // The G-buffer needs the true surface depth, so the pass branch follows it.
      expect(pass, name).toBeGreaterThan(depth);
    }
  });

  it("writes opaque fragments only to the G-buffer, translucent ones only in pass 3", () => {
    expect(atomFragmentShader).toMatch(/if \(opacity < 0\.999\) discard;/);
    expect(atomFragmentShader).toMatch(/if \(uPass == 3 && opacity >= 0\.999\) discard;/);
    expect(atomFragmentShader).toContain("studioSrgbToLinear(albedo)");
    expect(atomFragmentShader).toContain("normalize(normal) * 0.5 + 0.5");
  });
});

describe("studio full-screen shaders", () => {
  it("builds a colour and a ground-shadow variant of the composite", () => {
    const color = compositeFragmentShader(false);
    const floor = compositeFragmentShader(true);
    expect(color).toContain("#define FLOOR_PASS 0");
    expect(floor).toContain("#define FLOOR_PASS 1");
    // One output each: no multiple render targets.
    for (const src of [color, floor]) {
      expect(src.match(/\bout vec4\b/g)).toHaveLength(1);
      expect(src).toContain("uniform sampler2D tShadowSky;");
      expect(src).toContain("uniform sampler2D tShadowKey;");
    }
  });

  it("writes the sample alone; accumulate adds it to the sum", () => {
    expect(compositeFragmentShader(false)).toContain("fragColor = sampleColor;");
    expect(accumulateFragmentShader).toContain("texture(tPrev, vUv) + texture(tSample, vUv)");
  });

  it("lights translucent meshes like the composite, behind-the-atoms fragments dropped", () => {
    expect(translucentFragmentShader).toContain("vec3 studioShade(");
    expect(translucentFragmentShader).toContain("studioShade(albedo, vViewPos, n, v)");
    expect(translucentFragmentShader).toMatch(/gl_FragCoord\.z > texture\(tDepth/);
    expect(translucentFragmentShader).toContain("cross(dFdx(vViewPos), dFdy(vViewPos))");
    expect(translucentVertexShader).toContain("vViewNormal = normalMatrix * normal;");
  });

  it("decodes sRGB palette colours on meshes, as on the impostors", () => {
    expect(translucentFragmentShader).toContain("srgbToLinear(vColor)");
    expect(surfaceAlbedoFragmentShader).toContain("srgbToLinear(vColor)");
    expect(surfaceAlbedoVertexShader).toContain("vColor = color;");
  });

  it("casts translucent shadows with probability equal to the opacity", () => {
    expect(stochasticShadowFragmentShader).toMatch(/if \(h >= uOpacity\) discard;/);
    expect(stochasticShadowFragmentShader).toContain("uSeed");
    expect(shadowCasterVertexShader).toContain("gl_Position");
  });

  it("turns normals toward the viewer before lighting", () => {
    expect(compositeFragmentShader(false)).toContain("if (dot(n, v) < 0.0) n = -n;");
  });

  it("resolves with tone mapping, the ground shadow and the unjittered depth", () => {
    expect(resolveFragmentShader).toContain("neutralToneMap(");
    expect(resolveFragmentShader).toContain("uniform sampler2D tFloor;");
    expect(resolveFragmentShader).toContain("gl_FragDepth = texture(tDepth, vUv).r;");
    expect(fullscreenVertexShader).toContain("gl_Position = vec4(position.xy, 0.0, 1.0);");
  });
});
