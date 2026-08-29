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

export const atomVertexShader = /* glsl */ `precision highp float;
  precision highp int;

  // Three.js built-in uniforms (must declare explicitly for RawShaderMaterial)
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform float uScaleMultiplier;
  uniform int uUsePerAtomOverrides;

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

  void main() {
    vColor = instanceColor;
    vUv = position.xy;
    vOpacityOverride = instanceOpacityOverride;
    float effectiveScale = uScaleMultiplier;
    if (uUsePerAtomOverrides == 1) {
      effectiveScale *= instanceScaleOverride;
    }
    float scaledRadius = instanceRadius * effectiveScale;
    vRadius = scaledRadius;

    vec4 viewCenter = modelViewMatrix * vec4(instanceCenter, 1.0);
    vViewCenter = viewCenter.xyz;

    vec3 viewPos = viewCenter.xyz;
    viewPos.xy += position.xy * scaledRadius;

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

  uniform mat4 projectionMatrix;
  uniform float uOpacity;
  uniform int uUsePerAtomOverrides;
  // Illustrative (Mol*-style) mode: flat unlit color plus a constant-width
  // silhouette outline. 0 = off (lit ball-and-stick shading).
  uniform int uIllustrative;
  uniform float uOutlineWidth;
  uniform vec3 uOutlineColor;
  uniform float uAmbientDarkening;

  out vec4 fragColor;

  void main() {
    float dist2 = dot(vUv, vUv);
    // Screen-space derivative of the normalized silhouette distance, taken
    // BEFORE the discard below: derivatives are undefined once a fragment in
    // the 2x2 quad has terminated, which would make the outline flicker along
    // the very edge it is supposed to trace.
    float rim = sqrt(dist2);
    float rimWidth = fwidth(rim) * uOutlineWidth;
    if (dist2 > 1.0) discard;

    float z = sqrt(1.0 - dist2);
    vec3 normal = vec3(vUv, z);

    // Correct depth
    vec3 fragViewPos = vViewCenter + normal * vRadius;
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
      fragColor = vec4(mix(shaded, uOutlineColor, edge), finalOpacity);
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
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir1 + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 64.0);

    // Fresnel rim
    float fresnel = pow(1.0 - z, 3.0) * 0.15;

    // Edge darkening
    float edgeFactor = mix(0.7, 1.0, z);

    vec3 color = vColor * (ambient + diffuse) * edgeFactor
               + vec3(1.0) * spec * 0.3
               + vec3(0.15) * fresnel;
    fragColor = vec4(color, finalOpacity);
  }
`;

export const bondVertexShader = /* glsl */ `precision highp float;

  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  uniform float uBondScaleMultiplier;
  uniform sampler2D uPositionTex;
  uniform int uPositionTexWidth;

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

  vec3 getAtomPos(int idx) {
    int tx = idx % uPositionTexWidth;
    int ty = idx / uPositionTexWidth;
    return texelFetch(uPositionTex, ivec2(tx, ty), 0).rgb;
  }

  void main() {
    vColorA = instanceColorA;
    vColorB = instanceColorB;
    vDashed = instanceDashed;
    vBondOpacity = instanceBondOpacity;

    int atomA = int(instanceAtomA + 0.5);
    int atomB = int(instanceAtomB + 0.5);
    vec3 posA = getAtomPos(atomA);
    vec3 posB = getAtomPos(atomB);

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

    float radius = instanceRadius * uBondScaleMultiplier;

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

  uniform mat4 projectionMatrix;
  uniform float uOpacity;
  uniform int uUsePerBondOverrides;

  out vec4 fragColor;

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
    if (disc < 0.0 || a < 1e-8) discard;
    float sq = sqrt(disc);
    // Near (entry) root first; fall back to the far root if the camera is inside.
    float t = (-b - sq) / (2.0 * a);
    if (t < 0.0) t = (-b + sq) / (2.0 * a);
    if (t < 0.0) discard;

    vec3 hit = ro + t * rd;
    float axial = dot(hit - vViewMid, d);
    if (abs(axial) > vHalfLen) discard; // beyond the stick ends; the spheres cap it

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
    vec3 viewDir = vec3(0.0, 0.0, 1.0);
    vec3 halfDir = normalize(lightDir1 + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 64.0);

    // Fresnel rim + edge darkening, unified with the atom shader so the
    // sphere/cylinder joint has no shading discontinuity.
    float facing = max(normal.z, 0.0);
    float fresnel = pow(1.0 - facing, 3.0) * 0.15;
    float edgeFactor = mix(0.7, 1.0, facing);

    vec3 color = baseColor * (ambient + diffuse) * edgeFactor
               + vec3(1.0) * spec * 0.3
               + vec3(0.15) * fresnel;
    float finalOpacity = uOpacity;
    if (uUsePerBondOverrides == 1) {
      finalOpacity *= vBondOpacity;
    }
    fragColor = vec4(color, finalOpacity);
  }
`;
