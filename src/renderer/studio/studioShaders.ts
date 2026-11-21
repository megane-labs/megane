/**
 * Full-screen shaders of the publication (studio) renderer.
 *
 * `composite` lights one sample: it reads the G-buffer (linear albedo, packed
 * view-space normal, depth) the impostor and mesh passes wrote, tests the
 * point against this sample's two shadow maps — one direction on the sky dome,
 * one inside the key light's cone. Translucent meshes are lit the same way
 * (`translucent*Shader`) and blended over that sample, and `accumulate` adds
 * it to the running sum.
 * `resolve` divides by the sample count, tone-maps (Khronos PBR Neutral, which
 * keeps element colours recognizable), encodes sRGB, and puts the background
 * behind it.
 */

/**
 * Lighting shared by the opaque composite and the translucent pass: this
 * sample's sky direction and key-light point, each tested against its shadow
 * map, plus the shadowless rim light. Everything is in view space.
 */
const STUDIO_LIGHTING_GLSL = /* glsl */ `
  uniform sampler2D tShadowSky;
  uniform sampler2D tShadowKey;
  uniform int uOrtho;

  // View space -> light clip space, per shadow map.
  uniform mat4 uViewToSky;
  uniform mat4 uViewToKey;
  // Normal offset (view units) and depth bias (light NDC/2 units).
  uniform vec2 uSkyBias;
  uniform vec2 uKeyBias;
  uniform float uShadowTexel;   // 1 / shadow map size

  uniform vec3 uSkyDir;         // toward the light, view space
  uniform vec3 uSkyRadiance;
  uniform vec3 uKeyDir;
  uniform vec3 uKeyRadiance;
  uniform vec3 uRimDir;
  uniform vec3 uRimRadiance;
  uniform float uSpecular;
  uniform float uShininess;

  // 1 when nothing in the map lies between p and the light. A texel the map
  // left at the far plane holds no caster, so it lights whatever is behind it
  // — the ground below the structure reaches past the light's far plane.
  float shadowTexel(sampler2D map, vec2 uv, float z) {
    float m = texture(map, uv).r;
    return (m >= 1.0 || z <= m) ? 1.0 : 0.0;
  }

  // spread 0: one texel; otherwise a 3x3 filter whose taps are spread texels
  // apart (a soft light's wider penumbra).
  float shadowTest(sampler2D map, mat4 viewToLight, vec3 p, vec3 n, vec2 bias, float spread) {
    vec4 c = viewToLight * vec4(p + n * bias.x, 1.0);
    vec3 s = c.xyz / c.w * 0.5 + 0.5;
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return 1.0;
    float z = s.z - bias.y;
    if (spread <= 0.0) return shadowTexel(map, s.xy, z);
    float lit = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        lit += shadowTexel(map, s.xy + vec2(float(i), float(j)) * uShadowTexel * spread, z);
      }
    }
    return lit / 9.0;
  }

  float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  // Megane's palettes (CPK, chains, polyhedra) are sRGB, also when they reach
  // a mesh as vertex colours.
  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }

  // Radiance leaving view-space point p (normal n, toward the viewer v) of
  // linear albedo \`albedo\` for this sample.
  vec3 studioShade(vec3 albedo, vec3 p, vec3 n, vec3 v) {
    // Sky: one direction of the dome per sample. Uniform sphere sampling, so
    // the cosine-weighted estimator is radiance * cos * 4 (an unoccluded
    // surface under a white sky of radiance 1 averages to its albedo).
    float ndlSky = dot(n, uSkyDir);
    vec3 radiance = vec3(0.0);
    if (ndlSky > 0.0) {
      float vis = shadowTest(tShadowSky, uViewToSky, p, n, uSkyBias, 0.0);
      radiance += albedo * uSkyRadiance * (4.0 * ndlSky * vis);
    }

    float ndlKey = dot(n, uKeyDir);
    if (ndlKey > 0.0 && dot(uKeyRadiance, uKeyRadiance) > 0.0) {
      float vis = shadowTest(tShadowKey, uViewToKey, p, n, uKeyBias, 1.0);
      vec3 h = normalize(uKeyDir + v);
      float spec = uSpecular * pow(max(dot(n, h), 0.0), uShininess) * (uShininess + 8.0) / 32.0;
      radiance += uKeyRadiance * vis * (albedo * ndlKey + vec3(spec) * ndlKey);
    }

    float ndlRim = dot(n, uRimDir);
    if (ndlRim > 0.0) {
      float facing = 1.0 - max(dot(n, v), 0.0);
      radiance += uRimRadiance * (albedo * 0.5 + 0.5) * ndlRim * facing * facing;
    }

    return radiance;
  }
`;

export const fullscreenVertexShader = /* glsl */ `precision highp float;
  in vec3 position;
  in vec2 uv;
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * `floorPass` false: the lit sample (radiance, coverage) on its own.
 * `floorPass` true: the ground shadow (darkness, background-sample count)
 * added to `tPrev`. Two single-output passes rather than one with two render
 * targets, whose draw-buffer state three.js does not reliably reset.
 */
export function compositeFragmentShader(floorPass: boolean): string {
  return /* glsl */ `precision highp float;
  precision highp int;
  #define FLOOR_PASS ${floorPass ? 1 : 0}

  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D tPrev;
  uniform sampler2D tAlbedo;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform vec2 uTexel;          // 1 / output size
${STUDIO_LIGHTING_GLSL}

  // Invisible ground the structure rests on, in view space: dot(n, p) = d.
  // Only the shadows and occlusion it receives are drawn (a shadow catcher).
  uniform int uFloor;
  uniform vec3 uFloorNormal;
  uniform float uFloorD;
  uniform vec3 uFloorCenter;    // structure centre projected onto the ground
  uniform float uFloorFade;     // distance at which the shadow has faded out
  uniform float uFloorNorm;     // the ground's unoccluded irradiance

  uniform int uOutline;
  uniform float uOutlineWidth;  // pixels
  uniform float uOutlineThreshold;
  uniform vec3 uOutlineColor;

  vec3 viewPosAt(vec2 uv, float depth) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * ndc;
    return v.xyz / v.w;
  }

  float viewDistAt(vec2 uv) {
    float d = texture(tDepth, uv).r;
    if (d >= 1.0) return 1e20;
    return -viewPosAt(uv, d).z;
  }

  // How much light the ground loses at the background pixel vUv to this
  // sample's sky and key directions, relative to an unshadowed ground; -1 when
  // the view ray misses the ground.
  float floorDarkness() {
    vec3 ro;
    vec3 rd;
    if (uOrtho == 1) {
      ro = viewPosAt(vUv, 0.0);
      rd = vec3(0.0, 0.0, -1.0);
    } else {
      ro = vec3(0.0);
      rd = normalize(viewPosAt(vUv, 0.5));
    }
    float denom = dot(uFloorNormal, rd);
    if (denom >= -1e-5) return -1.0;
    float t = (uFloorD - dot(uFloorNormal, ro)) / denom;
    if (t <= 0.0) return -1.0;
    vec3 q = ro + rd * t;
    vec3 n = uFloorNormal;
    float lost = 0.0;
    float ndlSky = dot(n, uSkyDir);
    if (ndlSky > 0.0) {
      // The ground is far from what shades it, where the sky's penumbra is
      // widest: a wide filter keeps the separate sky directions from showing.
      float vis = shadowTest(tShadowSky, uViewToSky, q, n, uSkyBias, 4.0);
      lost += luminance(uSkyRadiance) * 4.0 * ndlSky * (1.0 - vis);
    }
    float ndlKey = dot(n, uKeyDir);
    if (ndlKey > 0.0) {
      float vis = shadowTest(tShadowKey, uViewToKey, q, n, uKeyBias, 1.5);
      lost += luminance(uKeyRadiance) * ndlKey * (1.0 - vis);
    }
    float fade = 1.0 - smoothstep(uFloorFade * 0.55, uFloorFade, length(q - uFloorCenter));
    return clamp(lost / max(uFloorNorm, 1e-6), 0.0, 1.0) * fade;
  }

  void main() {
    float depth = texture(tDepth, vUv).r;
#if FLOOR_PASS
    vec4 prev = texture(tPrev, vUv);
    vec4 floorSample = vec4(0.0);
    if (uFloor == 1 && depth >= 1.0) {
      float dark = floorDarkness();
      if (dark >= 0.0) floorSample = vec4(dark, 1.0, 0.0, 0.0);
    }
    fragColor = prev + floorSample;
#else
    vec4 sampleColor = vec4(0.0);

    if (depth < 1.0) {
      vec3 albedo = texture(tAlbedo, vUv).rgb;
      vec3 n = normalize(texture(tNormal, vUv).xyz * 2.0 - 1.0);
      vec3 p = viewPosAt(vUv, depth);
      vec3 v = uOrtho == 1 ? vec3(0.0, 0.0, 1.0) : normalize(-p);
      // What the camera sees always faces it. Open sheets drawn double-sided
      // (cartoon ribbons) can hand over the far side's normal when their
      // winding disagrees with their normals; turn it toward the viewer.
      if (dot(n, v) < 0.0) n = -n;

      vec3 radiance = studioShade(albedo, p, n, v);
      sampleColor = vec4(radiance, 1.0);
    }

    if (uOutline == 1) {
      // Drawn on the farther pixel of a depth step (it hugs the outside of the
      // nearer object), including on the background around a silhouette.
      float self = depth < 1.0 ? -viewPosAt(vUv, depth).z : 1e20;
      float edge = 0.0;
      for (int k = 0; k < 8; k++) {
        float a = float(k) * 0.78539816;
        vec2 o = vec2(cos(a), sin(a)) * uOutlineWidth * 0.5 * uTexel;
        float other = viewDistAt(vUv + o);
        if (other < 1e19 && self - other > uOutlineThreshold) edge = 1.0;
      }
      sampleColor = mix(sampleColor, vec4(uOutlineColor, 1.0), edge);
    }

    // This sample alone: the translucent pass blends over it before it is
    // added to the running sum (accumulateFragmentShader).
    fragColor = sampleColor;
#endif
  }
`;
}

export const resolveFragmentShader = /* glsl */ `precision highp float;

  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D tAccum;
  uniform sampler2D tFloor;
  uniform float uFloorStrength;
  uniform sampler2D tDepth;
  uniform float uInvSamples;
  uniform float uExposure;
  uniform vec3 uBackground;     // linear RGB
  uniform float uBackgroundAlpha;

  // Khronos PBR Neutral tone mapping: compresses only the highlights and keeps
  // hues, so CPK and chain colours stay what the legend says.
  vec3 neutralToneMap(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    const float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }

  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  void main() {
    vec4 acc = texture(tAccum, vUv) * uInvSamples;
    float coverage = clamp(acc.a, 0.0, 1.0);
    vec3 color = coverage > 0.0 ? acc.rgb / acc.a : vec3(0.0);
    color = neutralToneMap(color * uExposure);
    vec4 fl = texture(tFloor, vUv);
    float shadow = fl.g > 0.0 ? uFloorStrength * clamp(fl.r / fl.g, 0.0, 1.0) : 0.0;
    if (uBackgroundAlpha > 0.0) {
      vec3 lin = mix(uBackground * (1.0 - shadow), color, coverage);
      fragColor = vec4(linearToSrgb(lin), 1.0);
    } else {
      // Transparent export: premultiplied, as the canvas expects; the ground
      // shadow becomes black at the shadow's opacity.
      float alpha = coverage + (1.0 - coverage) * shadow;
      fragColor = vec4(linearToSrgb(color) * coverage, alpha);
    }
    // The unjittered depth, so the overlay pass is hidden behind the atoms.
    gl_FragDepth = texture(tDepth, vUv).r;
  }
`;

/** Adds this sample (`tSample`) to the running sum (`tPrev`). */
export const accumulateFragmentShader = /* glsl */ `precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D tPrev;
  uniform sampler2D tSample;
  void main() {
    fragColor = texture(tPrev, vUv) + texture(tSample, vUv);
  }
`;

/**
 * Translucent meshes (coordination polyhedra, a see-through surface): drawn
 * over each sample with ordinary alpha blending, but lit like everything
 * else — the sky and key light with the shadows the opaque scene casts on
 * them. The opaque depth is not attached to this pass, so a fragment behind
 * the atoms is discarded against the G-buffer's depth instead.
 */
export const translucentVertexShader = /* glsl */ `precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform mat3 normalMatrix;
  in vec3 position;
  in vec3 normal;
  in vec3 color;
  out vec3 vViewPos;
  out vec3 vViewNormal;
  out vec3 vColor;
  void main() {
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = viewPos.xyz;
    vViewNormal = normalMatrix * normal;
    vColor = color;
    gl_Position = projectionMatrix * viewPos;
  }
`;

export const translucentFragmentShader = /* glsl */ `precision highp float;
  precision highp int;

  in vec3 vViewPos;
  in vec3 vViewNormal;
  in vec3 vColor;
  out vec4 fragColor;

  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform vec3 uColor;          // linear RGB
  uniform float uOpacity;
  uniform int uVertexColors;
  uniform int uHasNormals;
${STUDIO_LIGHTING_GLSL}

  void main() {
    if (gl_FragCoord.z > texture(tDepth, gl_FragCoord.xy * uTexel).r) discard;
    // Faceted geometry without normals (or with unusable ones) gets the face's
    // own normal from the screen-space derivatives of its position.
    vec3 n = uHasNormals == 1 ? vViewNormal : cross(dFdx(vViewPos), dFdy(vViewPos));
    n = length(n) > 0.0 ? normalize(n) : vec3(0.0, 0.0, 1.0);
    vec3 v = uOrtho == 1 ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPos);
    if (dot(n, v) < 0.0) n = -n;
    vec3 albedo = uColor * (uVertexColors == 1 ? srgbToLinear(vColor) : vec3(1.0));
    fragColor = vec4(studioShade(albedo, vViewPos, n, v), uOpacity);
  }
`;

/**
 * G-buffer albedo of an opaque mesh (cartoon, opaque surface): its colour in
 * linear RGB, with sRGB vertex colours decoded like the impostors' colours.
 */
export const surfaceAlbedoVertexShader = /* glsl */ `precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  in vec3 position;
  in vec3 color;
  out vec3 vColor;
  void main() {
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const surfaceAlbedoFragmentShader = /* glsl */ `precision highp float;
  precision highp int;
  in vec3 vColor;
  out vec4 fragColor;
  uniform vec3 uColor;          // linear RGB
  uniform int uVertexColors;
  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  void main() {
    fragColor = vec4(uColor * (uVertexColors == 1 ? srgbToLinear(vColor) : vec3(1.0)), 1.0);
  }
`;

/**
 * A translucent mesh in a shadow map: each fragment is drawn with probability
 * equal to its opacity (a per-sample hash), so averaged over the samples it
 * blocks exactly that fraction of the light — a coloured glass plate at 50 %
 * casts a half shadow, on the atoms inside it and on the ground.
 */
export const shadowCasterVertexShader = /* glsl */ `precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  in vec3 position;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const stochasticShadowFragmentShader = /* glsl */ `precision highp float;
  out vec4 fragColor;
  uniform float uOpacity;
  uniform float uSeed;
  void main() {
    float h = fract(sin(dot(gl_FragCoord.xy + vec2(uSeed, uSeed * 1.618), vec2(12.9898, 78.233))) * 43758.5453);
    if (h >= uOpacity) discard;
    fragColor = vec4(1.0);
  }
`;
