/**
 * Full-screen shaders of the publication (studio) renderer.
 *
 * `composite` lights one sample: it reads the G-buffer (linear albedo, packed
 * view-space normal, depth) the impostor and mesh passes wrote, tests the
 * point against this sample's two shadow maps — one direction on the sky dome,
 * one inside the key light's cone — and adds the result to the running sum.
 * `resolve` divides by the sample count, tone-maps (Khronos PBR Neutral, which
 * keeps element colours recognizable), encodes sRGB, and puts the background
 * behind it.
 */

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
 * `floorPass` false: the lit sample (radiance, coverage) added to `tPrev`.
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
  uniform sampler2D tShadowSky;
  uniform sampler2D tShadowKey;

  uniform mat4 uInvProj;
  uniform int uOrtho;
  uniform vec2 uTexel;          // 1 / output size

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

  // 1 when nothing in the map lies between p and the light. A texel the map
  // left at the far plane holds no caster, so it lights whatever is behind it
  // — the ground below the structure reaches past the light's far plane.
  float shadowTexel(sampler2D map, vec2 uv, float z) {
    float m = texture(map, uv).r;
    return (m >= 1.0 || z <= m) ? 1.0 : 0.0;
  }

  float shadowTest(sampler2D map, mat4 viewToLight, vec3 p, vec3 n, vec2 bias, bool pcf) {
    vec4 c = viewToLight * vec4(p + n * bias.x, 1.0);
    vec3 s = c.xyz / c.w * 0.5 + 0.5;
    if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) return 1.0;
    float z = s.z - bias.y;
    if (!pcf) return shadowTexel(map, s.xy, z);
    float lit = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        lit += shadowTexel(map, s.xy + vec2(float(i), float(j)) * uShadowTexel, z);
      }
    }
    return lit / 9.0;
  }


  float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
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
      float vis = shadowTest(tShadowSky, uViewToSky, q, n, uSkyBias, false);
      lost += luminance(uSkyRadiance) * 4.0 * ndlSky * (1.0 - vis);
    }
    float ndlKey = dot(n, uKeyDir);
    if (ndlKey > 0.0) {
      float vis = shadowTest(tShadowKey, uViewToKey, q, n, uKeyBias, true);
      lost += luminance(uKeyRadiance) * ndlKey * (1.0 - vis);
    }
    float fade = 1.0 - smoothstep(uFloorFade * 0.55, uFloorFade, length(q - uFloorCenter));
    return clamp(lost / max(uFloorNorm, 1e-6), 0.0, 1.0) * fade;
  }

  void main() {
    vec4 prev = texture(tPrev, vUv);
    float depth = texture(tDepth, vUv).r;
#if FLOOR_PASS
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

      // Sky: one direction of the dome per sample. Uniform sphere sampling, so
      // the cosine-weighted estimator is radiance * cos * 4 (an unoccluded
      // surface under a white sky of radiance 1 averages to its albedo).
      float ndlSky = dot(n, uSkyDir);
      vec3 radiance = vec3(0.0);
      if (ndlSky > 0.0) {
        float vis = shadowTest(tShadowSky, uViewToSky, p, n, uSkyBias, false);
        radiance += albedo * uSkyRadiance * (4.0 * ndlSky * vis);
      }

      float ndlKey = dot(n, uKeyDir);
      if (ndlKey > 0.0 && dot(uKeyRadiance, uKeyRadiance) > 0.0) {
        float vis = shadowTest(tShadowKey, uViewToKey, p, n, uKeyBias, true);
        vec3 h = normalize(uKeyDir + v);
        float spec = uSpecular * pow(max(dot(n, h), 0.0), uShininess) * (uShininess + 8.0) / 32.0;
        radiance += uKeyRadiance * vis * (albedo * ndlKey + vec3(spec) * ndlKey);
      }

      float ndlRim = dot(n, uRimDir);
      if (ndlRim > 0.0) {
        float facing = 1.0 - max(dot(n, v), 0.0);
        radiance += uRimRadiance * (albedo * 0.5 + 0.5) * ndlRim * facing * facing;
      }

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

    fragColor = prev + sampleColor;
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
