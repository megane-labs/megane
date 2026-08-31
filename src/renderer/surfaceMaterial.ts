/**
 * Shading for the pipeline's transparent surface meshes — isosurfaces,
 * coordination polyhedra and alpha-shape surfaces.
 *
 * ## Why this is not just a MeshPhongMaterial
 *
 * A surface drawn with `transparent: true` is composited as
 * `result = surface·α + background·(1 − α)`, so the surface's chroma reaches
 * the frame buffer scaled by α. Against megane's white default background the
 * hue therefore fades toward white as the opacity slider comes down, and two
 * lobes of an orbital (or the two ends of an ESP colormap) converge on the
 * same pale grey long before the surface is faint enough to see through
 * comfortably. Three things made that worse than it had to be:
 *
 *  1. **World-space lights.** The scene's key/fill lights sit at fixed world
 *     positions, so whichever side of the surface faces the camera can end up
 *     lit almost entirely by ambient — a dull, desaturated version of the
 *     colour the user picked, before transparency touches it. The impostor
 *     atoms and bonds dodge this by lighting in view space (see `shaders.ts`);
 *     surfaces now use the same rig, so a surface matches the atoms inside it
 *     from every camera angle.
 *  2. **A white specular highlight at full strength.** Broad and white, it
 *     dilutes hue exactly where the surface is most visible. It is now scaled
 *     by the surface's own alpha, so a nearly-clear surface stops wearing a
 *     bright grey sheen.
 *  3. **Nothing anchoring the silhouette.** Boosting alpha where the surface
 *     turns away from the camera (a Fresnel term — physically, that is where
 *     the viewing ray travels furthest through the shell) firms up the rim, so
 *     shape and colour stay legible even at 15 % opacity.
 *
 * On top of those, {@link CHROMA_BOOST} compensates for the α-scaling of
 * chroma directly: as alpha falls, the emitted colour is pushed away from its
 * own luminance so that the fraction of it that survives the blend is still
 * recognisably blue or red. At α = 1 the boost is exactly 1 — an opaque
 * surface is rendered with the literal colour it was given.
 */

import * as THREE from "three";

/** Fresnel exponent: how tightly the alpha boost hugs the silhouette. */
export const RIM_POWER = 2.5;

/** How much of the remaining transparency the silhouette claws back (0–1). */
export const RIM_STRENGTH = 0.65;

/**
 * Ceiling on the saturation compensation applied as alpha falls.
 *
 * Exact compensation is 1 / (α(2 − α)) — see the shader — which diverges at
 * α → 0, so it is capped. 2.2 is where a surface stops looking like a surface:
 * past it the emitted colour is so saturated that a faint surface reads as a
 * flat opaque sticker rather than something you are seeing through.
 */
export const CHROMA_BOOST = 2.2;

/** Specular strength at full opacity; scaled by alpha below that. */
export const SPECULAR_STRENGTH = 0.25;

/** Blinn–Phong exponent. Softer than the atom impostors: surfaces are broad. */
export const SHININESS = 32.0;

export const surfaceVertexShader = /* glsl */ `
  attribute vec3 color;

  varying vec3 vColor;
  varying vec3 vNormalView;
  varying vec3 vViewPos;

  void main() {
    vColor = color;
    vNormalView = normalMatrix * normal;
    vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
    vViewPos = viewPos.xyz;
    gl_Position = projectionMatrix * viewPos;
  }
`;

export const surfaceFragmentShader = /* glsl */ `
  uniform float uOpacity;
  uniform float uRimPower;
  uniform float uRimStrength;
  uniform float uChromaBoost;
  uniform float uSpecular;
  uniform float uShininess;

  varying vec3 vColor;
  varying vec3 vNormalView;
  varying vec3 vViewPos;

  void main() {
    // Orthographic is megane's default camera, and there -vViewPos is not the
    // view direction. isOrthographic is one of three.js' built-in fragment
    // uniforms, so no plumbing is needed to tell the two cases apart.
    vec3 viewDir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPos);

    // Marching cubes and the polyhedron builder both emit unsorted, two-sided
    // triangles, so shade whichever side actually points at the camera rather
    // than trusting the winding.
    vec3 n = normalize(vNormalView);
    if (dot(n, viewDir) < 0.0) n = -n;

    // View-space light rig, sharing the atom/bond impostors' light directions
    // (shaders.ts) so a surface and the atoms it wraps agree at every angle.
    // The two differences are deliberate: a touch more ambient, and a wrapped
    // (half-Lambert) diffuse instead of a clamped one. A sphere impostor is
    // small enough that a hard terminator reads as shape, but on a surface
    // spanning the viewport it crushes whole flanks to near-black — and a
    // black flank is a grey flank once it is blended over the background.
    vec3 skyColor = vec3(0.87, 0.92, 1.0);
    vec3 groundColor = vec3(0.6, 0.47, 0.27);
    vec3 ambient = mix(groundColor, skyColor, n.y * 0.5 + 0.5) * 0.4;

    vec3 lightDir1 = normalize(vec3(0.5, 0.5, 1.0));
    vec3 lightDir2 = normalize(vec3(-0.3, 0.3, 0.8));
    float diffuse = (dot(n, lightDir1) * 0.5 + 0.5) * 0.5
                  + (dot(n, lightDir2) * 0.5 + 0.5) * 0.18;

    // Fresnel alpha: the silhouette, where the viewing ray takes the longest
    // path through the shell, firms up toward opaque and carries the shape.
    float facing = clamp(dot(n, viewDir), 0.0, 1.0);
    float rim = pow(1.0 - facing, uRimPower);
    float alpha = clamp(uOpacity + (1.0 - uOpacity) * rim * uRimStrength, 0.0, 1.0);

    vec3 lit = vColor * (ambient + diffuse);

    // A white highlight on a nearly-clear surface is pure desaturation, so it
    // fades with the surface instead of staying at full strength.
    vec3 halfDir = normalize(lightDir1 + viewDir);
    float spec = pow(max(dot(n, halfDir), 0.0), uShininess);
    lit += vec3(spec * uSpecular * alpha);

    // Chroma compensation. A closed surface covers each pixel with two layers
    // (back face then front face), so the fraction of the surface's own colour
    // that survives the blend is 1 − (1 − α)² = α(2 − α), and the chroma the
    // viewer actually sees is scaled by exactly that. Emitting the inverse
    // cancels it, holding apparent saturation level as the slider comes down;
    // it is 1.0 at α = 1 (an opaque surface keeps its literal colour) and is
    // capped at uChromaBoost where it would otherwise run away near α = 0.
    // Renormalising by the peak channel afterwards — rather than clamping each
    // one — keeps the hue exact when the boost pushes a channel past 1.
    float boost = min(1.0 / max(alpha * (2.0 - alpha), 1e-3), uChromaBoost);
    float lum = dot(lit, vec3(0.2126, 0.7152, 0.0722));
    vec3 boosted = lum + (lit - lum) * boost;
    boosted /= max(max(max(boosted.r, boosted.g), boosted.b), 1.0);

    gl_FragColor = vec4(max(boosted, vec3(0.0)), alpha);
  }
`;

/**
 * Build the shared material for one surface mesh.
 *
 * `side` is set by the caller: {@link PolyhedronRenderer} draws the mesh twice,
 * back faces then front faces, so the two layers of a closed surface composite
 * back-to-front instead of in triangle-emission order.
 */
export function createSurfaceMaterial(opacity: number, side: THREE.Side): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: surfaceVertexShader,
    fragmentShader: surfaceFragmentShader,
    uniforms: {
      uOpacity: { value: opacity },
      uRimPower: { value: RIM_POWER },
      uRimStrength: { value: RIM_STRENGTH },
      uChromaBoost: { value: CHROMA_BOOST },
      uSpecular: { value: SPECULAR_STRENGTH },
      uShininess: { value: SHININESS },
    },
    transparent: true,
    side,
    depthWrite: false,
  });
}
