/**
 * GLSL 3.0 ES shaders for billboard impostor rendering.
 *
 * Atom shader: screen-aligned quad + ray-sphere intersection in fragment
 *              -> pixel-perfect spheres with correct depth.
 * Bond shader: screen-aligned quad between two endpoints
 *              -> cylinder-like shading with dashed bond support.
 *
 * RawShaderMaterial requires explicit uniform/attribute declarations.
 */

/**
 * Immersive (WebXR) finishing shared by both impostor fragment shaders; a no-op
 * on the desktop (`uExactImpostor` 0). Content nearer to the eye than
 * `uXRNear.y` fades out and is gone inside `uXRNear.x` (too close to fuse into
 * one image), the depth cue fades the far side toward `uXRFogColor` along the
 * `uXRFog` ramp (start, end in metres from the eye, strength), and `coverage`
 * — a one-pixel ramp centred on the silhouette — becomes alpha, which
 * alpha-to-coverage turns into smooth edges on the headset's multisampled
 * buffer. The exact billboards reach `uXRPixel` (2 / viewport height) past the
 * silhouette so the ramp's outer half has fragments to draw.
 */
const XR_FINISH_GLSL = /* glsl */ `
  uniform vec2 uXRNear;
  uniform vec3 uXRFog;
  uniform vec3 uXRFogColor;

  vec4 xrFinish(vec4 color, vec3 viewPos, float coverage) {
    if (uExactImpostor != 1) return color;
    float eyeDist = length(viewPos);
    float cue = clamp((eyeDist - uXRFog.x) / max(uXRFog.y - uXRFog.x, 1e-6), 0.0, 1.0);
    color.rgb = mix(color.rgb, uXRFogColor, uXRFog.z * cue);
    color.a *= coverage * clamp((eyeDist - uXRNear.x) / max(uXRNear.y - uXRNear.x, 1e-6), 0.0, 1.0);
    return color;
  }
`;

export const atomVertexShader = /* glsl */ `precision highp float;
  precision highp int;

  // Three.js built-in uniforms (must declare explicitly for RawShaderMaterial)
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform float uScaleMultiplier;
  uniform int uUsePerAtomOverrides;
  // 1 in an immersive (WebXR) view: perspective-exact billboard + ray-cast.
  uniform highp int uExactImpostor;
  // Immersive view: one pixel's size at unit distance, times projection[1][1].
  uniform float uXRPixel;

  // Per-vertex (quad corners)
  in vec3 position;

  // Per-instance
  in vec3 instanceCenter;
  in float instanceRadius;
  in vec3 instanceColor;
  in float instanceScaleOverride;
  in float instanceOpacityOverride;

  out vec3 vColor;
  out vec2 vUv;
  out float vRadius;
  out vec3 vViewCenter;
  out float vOpacityOverride;
  out vec3 vViewPos;

  void main() {
    vColor = instanceColor;
    vUv = position.xy;
    vOpacityOverride = instanceOpacityOverride;
    float effectiveScale = uScaleMultiplier;
    if (uUsePerAtomOverrides == 1) {
      effectiveScale *= instanceScaleOverride;
    }
    // Radii are in model units but added in view space, so they take the
    // model-view scale along: an immersive view scales the scene (Å to
    // metres). The desktop view never scales it, so the factor is 1 there.
    float scaledRadius = instanceRadius * effectiveScale * length(modelViewMatrix[0].xyz);
    vRadius = scaledRadius;

    vec4 viewCenter = modelViewMatrix * vec4(instanceCenter, 1.0);
    vViewCenter = viewCenter.xyz;

    vec3 viewPos = viewCenter.xyz;
    if (uExactImpostor == 1) {
      // A square facing the eye (the view-space origin), sized to the sphere's
      // tangent cone: it covers the whole perspective silhouette however close
      // the sphere is and however far off the view axis it sits, both of which
      // a wide-field headset view reaches.
      float d = length(viewPos);
      if (d <= scaledRadius * 1.001) {
        // The eye is inside the sphere: drop it.
        vViewPos = viewPos;
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
      }
      vec3 axis = viewPos / d;
      vec3 ref = abs(axis.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
      vec3 right = normalize(cross(axis, ref));
      vec3 up = cross(right, axis);
      float extent = scaledRadius * d / sqrt(d * d - scaledRadius * scaledRadius)
        + d * uXRPixel / projectionMatrix[1][1];
      viewPos += (right * position.x + up * position.y) * extent;
    } else {
      viewPos.xy += position.xy * scaledRadius;
    }
    vViewPos = viewPos;

    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  }
`;

export const atomFragmentShader = /* glsl */ `precision highp float;
  precision highp int;

  in vec3 vColor;
  in vec2 vUv;
  in float vRadius;
  in vec3 vViewCenter;
  in float vOpacityOverride;
  in vec3 vViewPos;

  uniform mat4 projectionMatrix;
  uniform float uOpacity;
  uniform int uUsePerAtomOverrides;
  uniform highp int uExactImpostor;
  // Illustrative (Mol*-style) mode: flat unlit color plus a constant-width
  // silhouette outline. 0 = off (lit ball-and-stick shading).
  uniform int uIllustrative;
  uniform float uOutlineWidth;
  uniform vec3 uOutlineColor;
  uniform float uAmbientDarkening;

  out vec4 fragColor;
${XR_FINISH_GLSL}
  void main() {
    // Desktop: the billboard's |uv|^2 (an orthographic view along -z). An
    // immersive view casts the real ray from the eye through this fragment
    // instead; dist2 is then its closest approach to the centre, in radii^2.
    vec3 rd = vec3(0.0, 0.0, -1.0);
    float dist2;
    if (uExactImpostor == 1) {
      rd = normalize(vViewPos);
      float b = dot(rd, vViewCenter);
      dist2 = (dot(vViewCenter, vViewCenter) - b * b) / (vRadius * vRadius);
    } else {
      dist2 = dot(vUv, vUv);
    }
    // Screen-space derivative of the normalized silhouette distance, taken
    // BEFORE the discard below: derivatives are undefined once a fragment in
    // the 2x2 quad has terminated, which would make the outline flicker along
    // the very edge it is supposed to trace.
    float rim = sqrt(dist2);
    float rimDeriv = fwidth(rim);
    float rimWidth = rimDeriv * uOutlineWidth;
    // Immersive view: a one-pixel edge ramp centred on the silhouette (see
    // xrFinish). Its outer half lies just off the sphere and takes the
    // silhouette's depth. The desktop draws hard edges.
    float coverage = 1.0;
    if (uExactImpostor == 1) {
      coverage = clamp((1.0 - rim) / max(rimDeriv, 1e-6) + 0.5, 0.0, 1.0);
      if (coverage <= 0.0) discard;
      dist2 = min(dist2, 1.0);
    }
    if (dist2 > 1.0) discard;

    // z: how squarely the surface faces the viewer (1 at the centre, 0 at
    // the silhouette).
    float z;
    vec3 normal;
    vec3 fragViewPos;
    if (uExactImpostor == 1) {
      fragViewPos = rd * (dot(rd, vViewCenter) - vRadius * sqrt(1.0 - dist2));
      if (length(fragViewPos) < uXRNear.x) discard;
      normal = (fragViewPos - vViewCenter) / vRadius;
      z = dot(normal, -rd);
    } else {
      z = sqrt(1.0 - dist2);
      normal = vec3(vUv, z);
      fragViewPos = vViewCenter + normal * vRadius;
    }

    // Correct depth
    vec4 clipPos = projectionMatrix * vec4(fragViewPos, 1.0);
    float ndcDepth = clipPos.z / clipPos.w;
    gl_FragDepth = ndcDepth * 0.5 + 0.5;

    float finalOpacity = uOpacity;
    if (uUsePerAtomOverrides == 1) {
      finalOpacity *= vOpacityOverride;
    }

    if (uIllustrative == 1) {
      // Mol*'s illustrative representation renders spacefill spheres with
      // ignoreLight, so the sphere reads as a flat disc of its own color and
      // the shape is carried entirely by the outline. rimWidth comes from the
      // screen-space derivative, so the band stays uOutlineWidth device pixels
      // wide no matter how large the sphere is on screen.
      // Stand-in for the ambient occlusion Mol* gets from its SSAO pass: in a
      // spacefill field the dominant occlusion is contact with neighbouring
      // spheres, which always sits near a sphere's rim, so a radial ramp
      // recovers most of the sculpted look with no depth prepass. z is the
      // sphere normal's view-space Z: 1 facing the camera, 0 at the silhouette.
      vec3 shaded = vColor * mix(1.0 - uAmbientDarkening, 1.0, z);
      float edge = smoothstep(1.0 - rimWidth, 1.0 - rimWidth * 0.5, rim);
      fragColor = xrFinish(vec4(mix(shaded, uOutlineColor, edge), finalOpacity), fragViewPos, coverage);
      return;
    }

    // Hemisphere ambient: sky blue on top, warm brown on bottom
    vec3 skyColor = vec3(0.87, 0.92, 1.0);
    vec3 groundColor = vec3(0.6, 0.47, 0.27);
    float hemiMix = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(groundColor, skyColor, hemiMix) * 0.35;

    // Dual-light diffuse
    vec3 lightDir1 = normalize(vec3(0.5, 0.5, 1.0));
    vec3 lightDir2 = normalize(vec3(-0.3, 0.3, 0.8));
    float diffuse1 = max(dot(normal, lightDir1), 0.0);
    float diffuse2 = max(dot(normal, lightDir2), 0.0);
    float diffuse = diffuse1 * 0.55 + diffuse2 * 0.2;

    // Specular (Blinn-Phong)
    vec3 viewDir = -rd;
    vec3 halfDir = normalize(lightDir1 + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 64.0);

    // Fresnel rim
    float fresnel = pow(1.0 - z, 3.0) * 0.15;

    // Edge darkening
    float edgeFactor = mix(0.7, 1.0, z);

    vec3 color = vColor * (ambient + diffuse) * edgeFactor
               + vec3(1.0) * spec * 0.3
               + vec3(0.15) * fresnel;
    fragColor = xrFinish(vec4(color, finalOpacity), fragViewPos, coverage);
  }
`;

export const bondVertexShader = /* glsl */ `precision highp float;

  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform float uBondScaleMultiplier;
  uniform float uAtomRadiusScale;
  uniform sampler2D uPositionTex;
  uniform int uPositionTexWidth;
  // 1 in an immersive (WebXR) view: perspective-exact billboard.
  uniform highp int uExactImpostor;
  // Immersive view: one pixel's size at unit distance, times projection[1][1].
  uniform float uXRPixel;

  in vec3 position;
  in vec2 uv;

  in float instanceAtomA;
  in float instanceAtomB;
  in float instanceOffsetX;
  in float instanceOffsetY;
  in vec3 instanceColorA;
  in vec3 instanceColorB;
  in float instanceRadius;
  in float instanceDashed;
  in float instanceBondOpacity;

  out vec3 vColorA;
  out vec3 vColorB;
  out float vDashed;
  out float vBondOpacity;
  // View-space cylinder description + this fragment's billboard position. The
  // fragment shader ray-casts the analytic cylinder (correct for any viewing
  // angle), unlike a flat billboard parameterization which is only accurate for
  // bonds perpendicular to the camera.
  out vec3 vViewMid;
  out vec3 vAxisDir;
  out float vRadius;
  out float vHalfLen;
  out vec3 vViewRayPos;
  // Endpoint spheres in view space, used by the fragment shader to trim the
  // stick where it is buried inside a ball (see the CSG union note there).
  // The radii ride in the alpha channel of the position texture, scaled by
  // uAtomRadiusScale — together they mirror whatever the atom impostor draws.
  out vec3 vViewCenterA;
  out vec3 vViewCenterB;
  out float vAtomRadiusA;
  out float vAtomRadiusB;

  vec4 getAtomTexel(int idx) {
    int tx = idx % uPositionTexWidth;
    int ty = idx / uPositionTexWidth;
    return texelFetch(uPositionTex, ivec2(tx, ty), 0);
  }

  void main() {
    vColorA = instanceColorA;
    vColorB = instanceColorB;
    vDashed = instanceDashed;
    vBondOpacity = instanceBondOpacity;

    int atomA = int(instanceAtomA + 0.5);
    int atomB = int(instanceAtomB + 0.5);
    vec4 texelA = getAtomTexel(atomA);
    vec4 texelB = getAtomTexel(atomB);
    vec3 posA = texelA.rgb;
    vec3 posB = texelB.rgb;

    // Radii are in model units; carry the model-view scale over to them (an
    // immersive view scales the scene, the desktop view never does).
    float viewScale = length(modelViewMatrix[0].xyz);

    // Sphere centres stay on the atoms even when the cylinder is pushed aside
    // for a double / triple / aromatic bond, so the trim below cuts against
    // the ball that is actually drawn.
    vViewCenterA = (modelViewMatrix * vec4(posA, 1.0)).xyz;
    vViewCenterB = (modelViewMatrix * vec4(posB, 1.0)).xyz;
    vAtomRadiusA = texelA.a * uAtomRadiusScale * viewScale;
    vAtomRadiusB = texelB.a * uAtomRadiusScale * viewScale;

    vec3 start = posA;
    vec3 end = posB;

    // Apply perpendicular offset for double/triple/aromatic bonds
    if (instanceOffsetX != 0.0 || instanceOffsetY != 0.0) {
      vec3 bdir = normalize(posB - posA);
      vec3 perpX = cross(bdir, vec3(0.0, 1.0, 0.0));
      if (dot(perpX, perpX) < 0.001) {
        perpX = cross(bdir, vec3(1.0, 0.0, 0.0));
      }
      perpX = normalize(perpX);
      vec3 perpY = normalize(cross(bdir, perpX));
      vec3 offset = perpX * instanceOffsetX + perpY * instanceOffsetY;
      start += offset;
      end += offset;
    }

    vec4 viewStart = modelViewMatrix * vec4(start, 1.0);
    vec4 viewEnd = modelViewMatrix * vec4(end, 1.0);

    vec3 viewMid = (viewStart.xyz + viewEnd.xyz) * 0.5;
    vec3 axis = viewEnd.xyz - viewStart.xyz;
    float len = length(axis);
    vec3 dir = axis / max(len, 0.0001);

    vec3 side = normalize(cross(dir, vec3(0.0, 0.0, 1.0)));

    float radius = instanceRadius * uBondScaleMultiplier * viewScale;

    // Expose the view-space cylinder to the fragment shader.
    vViewMid = viewMid;
    vAxisDir = dir;
    vRadius = radius;
    vHalfLen = len * 0.5;

    // Billboard that conservatively covers the cylinder's screen silhouette.
    // Extend the half-length by the radius so the rounded ends are covered, and
    // span the full radius along the screen-perpendicular side axis.
    vec3 viewPos = viewMid
      + dir * (position.y * (len * 0.5 + radius))
      + side * (position.x * radius);

    if (uExactImpostor == 1) {
      // Perspective-exact billboard: the plane through the axis that faces the
      // eye's foot point F on it (at distance D). Seen from the eye, the
      // cylinder's silhouette in that plane is r*D/sqrt(D^2 - r^2) wide along
      // the whole stick, and a cut end at axial distance e from F projects at
      // most e*r/(D - r) past it — so this covers the stick at any angle.
      vec3 foot = viewStart.xyz - dir * dot(viewStart.xyz, dir);
      float footDist = length(foot);
      if (footDist <= radius * 1.001) {
        // The eye is inside the cylinder: drop it.
        vViewRayPos = viewMid;
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
      }
      vec3 facingSide = normalize(cross(dir, -foot / footDist));
      float pixel = length(viewMid) * uXRPixel / projectionMatrix[1][1];
      float sideExtent = radius * footDist / sqrt(footDist * footDist - radius * radius) + pixel;
      float reach = max(abs(dot(viewStart.xyz, dir)), abs(dot(viewEnd.xyz, dir)));
      float axialExtent = len * 0.5 + reach * radius / (footDist - radius) + pixel;
      viewPos = viewMid
        + dir * (position.y * axialExtent)
        + facingSide * (position.x * sideExtent);
    }

    vViewRayPos = viewPos;
    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  }
`;

export const bondFragmentShader = /* glsl */ `precision highp float;

  in vec3 vColorA;
  in vec3 vColorB;
  in float vDashed;
  in float vBondOpacity;
  in vec3 vViewMid;
  in vec3 vAxisDir;
  in float vRadius;
  in float vHalfLen;
  in vec3 vViewRayPos;
  in vec3 vViewCenterA;
  in vec3 vViewCenterB;
  in float vAtomRadiusA;
  in float vAtomRadiusB;

  uniform mat4 projectionMatrix;
  uniform float uOpacity;
  uniform int uUsePerBondOverrides;
  uniform highp int uExactImpostor;

  out vec4 fragColor;
${XR_FINISH_GLSL}
  void main() {
    // Analytic ray-cylinder intersection in view space. A flat billboard
    // parameterization mis-places the surface (and thus gl_FragDepth) for bonds
    // tilted toward/away from the camera, so the cylinder fails to occlude the
    // atom sphere's inner hemisphere and the sphere looks like a ball sitting on
    // top of the stick. Casting the real cylinder fixes the depth at any angle.
    bool isOrtho = projectionMatrix[2][3] == 0.0;
    vec3 ro = isOrtho ? vec3(vViewRayPos.xy, 0.0) : vec3(0.0);
    vec3 rd = isOrtho ? vec3(0.0, 0.0, -1.0) : normalize(vViewRayPos);

    vec3 d = vAxisDir;
    vec3 oc = ro - vViewMid;
    // Components of the ray and offset perpendicular to the cylinder axis.
    vec3 rdPerp = rd - dot(rd, d) * d;
    vec3 ocPerp = oc - dot(oc, d) * d;
    float a = dot(rdPerp, rdPerp);
    float b = 2.0 * dot(rdPerp, ocPerp);
    float c = dot(ocPerp, ocPerp) - vRadius * vRadius;
    float disc = b * b - 4.0 * a * c;
    // Immersive view: a one-pixel edge ramp centred on the silhouette, from
    // the ray's closest approach to the axis in radii (see xrFinish). Taken
    // before the discards so the derivative is defined. Its outer half misses
    // the cylinder and takes the closest-approach point as its surface.
    float coverage = 1.0;
    if (uExactImpostor == 1) {
      float rimB = sqrt(max(1.0 - disc / (4.0 * max(a, 1e-8) * vRadius * vRadius), 0.0));
      coverage = clamp((1.0 - rimB) / max(fwidth(rimB), 1e-6) + 0.5, 0.0, 1.0);
      if (coverage <= 0.0) discard;
      disc = max(disc, 0.0);
    }
    if (disc < 0.0 || a < 1e-8) discard;
    float sq = sqrt(disc);
    // Near (entry) root first; fall back to the far root if the camera is inside.
    float t = (-b - sq) / (2.0 * a);
    if (t < 0.0) t = (-b + sq) / (2.0 * a);
    if (t < 0.0) discard;

    vec3 hit = ro + t * rd;
    if (uExactImpostor == 1 && length(hit) < uXRNear.x) discard;
    float axial = dot(hit - vViewMid, d);
    if (abs(axial) > vHalfLen) discard; // beyond the stick ends; the spheres cap it

    // CSG union trim. The cylinder runs centre-to-centre, so its ends are
    // buried inside the endpoint spheres. An opaque atom hides that via the
    // depth test — an interior point is always behind the sphere's front face
    // along the same ray — but a transparent one stops writing depth and the
    // buried stick blends through, so the ball reads as a bead threaded onto a
    // rod. Discarding the fragments inside either sphere leaves exactly the
    // union's outer surface: one covering surface per pixel, and the stick ends
    // on the ball's skin at any viewing angle. Radius 0 (atom hidden or faded
    // out entirely) disables the trim, so a stick with no ball stays whole.
    vec3 toA = hit - vViewCenterA;
    if (dot(toA, toA) < vAtomRadiusA * vAtomRadiusA) discard;
    vec3 toB = hit - vViewCenterB;
    if (dot(toB, toB) < vAtomRadiusB * vAtomRadiusB) discard;

    vec3 normal = normalize((hit - vViewMid) - axial * d);
    if (dot(normal, rd) > 0.0) normal = -normal; // face the camera

    // Split coloring at the midpoint, computed from the true axial position.
    float tAxial = axial / vHalfLen; // -1 at atom A, +1 at atom B
    if (vDashed > 0.5) {
      if (sin(tAxial * 30.0) < 0.0) discard;
    }
    vec3 baseColor = tAxial < 0.0 ? vColorA : vColorB;

    // Correct per-fragment depth from the real surface hit.
    vec4 clipPos = projectionMatrix * vec4(hit, 1.0);
    gl_FragDepth = (clipPos.z / clipPos.w) * 0.5 + 0.5;

    // Hemisphere ambient: sky blue on top, warm brown on bottom
    vec3 skyColor = vec3(0.87, 0.92, 1.0);
    vec3 groundColor = vec3(0.6, 0.47, 0.27);
    float hemiMix = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(groundColor, skyColor, hemiMix) * 0.35;

    // Dual-light diffuse
    vec3 lightDir1 = normalize(vec3(0.5, 0.5, 1.0));
    vec3 lightDir2 = normalize(vec3(-0.3, 0.3, 0.8));
    float diffuse1 = max(dot(normal, lightDir1), 0.0);
    float diffuse2 = max(dot(normal, lightDir2), 0.0);
    float diffuse = diffuse1 * 0.55 + diffuse2 * 0.2;

    // Specular (Blinn-Phong)
    // The immersive view shades against the real view ray, like the atom
    // shader's exact path, so the joint stays seamless there too.
    vec3 viewDir = uExactImpostor == 1 ? -rd : vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir1 + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 64.0);

    // Fresnel rim + edge darkening, unified with the atom shader so the
    // sphere/cylinder joint has no shading discontinuity.
    float facing = max(uExactImpostor == 1 ? dot(normal, -rd) : normal.z, 0.0);
    float fresnel = pow(1.0 - facing, 3.0) * 0.15;
    float edgeFactor = mix(0.7, 1.0, facing);

    vec3 color = baseColor * (ambient + diffuse) * edgeFactor
               + vec3(1.0) * spec * 0.3
               + vec3(0.15) * fresnel;
    float finalOpacity = uOpacity;
    if (uUsePerBondOverrides == 1) {
      finalOpacity *= vBondOpacity;
    }
    fragColor = xrFinish(vec4(color, finalOpacity), hit, coverage);
  }
`;
