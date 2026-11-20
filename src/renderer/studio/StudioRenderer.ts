/**
 * Publication-quality rendering by accumulation.
 *
 * The live viewer lights every atom with the same fixed lamps and draws no
 * shadows. For a figure, `renderStudio` instead averages many rasterized
 * samples. Each sample:
 *
 *  1. shifts the camera by a sub-pixel offset (anti-aliasing),
 *  2. draws the lit part of the scene into a G-buffer — linear albedo and the
 *     view-space normal — with the impostor shaders' `uPass` switch and plain
 *     replacement materials for meshes,
 *  3. draws two shadow maps: one from a direction on the sky dome, one from a
 *     direction inside the key light's cone,
 *  4. lights the G-buffer against them and adds the result to a float sum.
 *
 * Averaged over a few hundred samples the sky's shadows become true ambient
 * occlusion (every pocket darkens with how much sky it sees, not a
 * screen-space guess), the key light's shadows get a soft penumbra, and edges
 * are anti-aliased. Rasterization keeps this as fast as the viewer itself, so
 * it scales to the structures the viewer can show, on every host.
 *
 * Translucent geometry and lines are not lit by the studio; they are drawn
 * over the finished picture with their own materials, behind the atoms where
 * the atoms are in front.
 */

import * as THREE from "three";
import { coneDirection, pixelJitter, seededRandom, sphereDirections, type Vec3 } from "./sampling";
import {
  STUDIO_PRESETS,
  floorNormal,
  skyRadiance,
  type StudioLighting,
  type StudioStyle,
} from "./presets";
import {
  classifyScene,
  isImpostorMesh,
  lightCamera,
  litBoundingSphere,
  litMinAlong,
  type StudioScene,
} from "./sceneSetup";
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
} from "./studioShaders";

export interface StudioRenderOptions {
  /** Number of accumulated samples (more is smoother and slower). */
  samples: number;
  style: StudioStyle;
  /** Override individual lighting parameters of the style. */
  lighting?: Partial<StudioLighting>;
  /** Clear to transparent instead of the scene background. */
  transparent: boolean;
  /** Draw the style's ground shadow (default true; styles without one ignore it). */
  floorShadow?: boolean;
  /** Shadow map edge length in texels (default: `shadowMapSizeFor` the output). */
  shadowMapSize?: number;
  /** Objects never lit by the studio (e.g. the selection highlight). */
  overlayRoots?: THREE.Object3D[];
  /** Seed for the sample order, so a render is reproducible. */
  seed?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /**
   * GPU time (ms) to submit before letting the page breathe. The GL queue is
   * asynchronous, so the renderer waits for the GPU to finish each batch
   * rather than for JavaScript to: queueing hundreds of samples at once would
   * freeze the whole browser until they drain.
   */
  sliceMs?: number;
}

const PASS_SHADED = 0;
const PASS_ALBEDO = 1;
const PASS_NORMAL = 2;
const PASS_TRANSLUCENT = 3;

type ImpostorState = {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  transparent: boolean;
  depthWrite: boolean;
  blending: THREE.Blending;
};

/** Swaps the scene between the studio's passes and puts it back afterwards. */
class PassState {
  private impostors: ImpostorState[];
  private surfaceOriginals = new Map<THREE.Mesh, THREE.Material>();
  private albedoMats = new Map<THREE.Mesh, THREE.RawShaderMaterial>();
  private normalMats = new Map<THREE.Mesh, THREE.MeshNormalMaterial>();
  private overlayVisible = new Map<THREE.Object3D, boolean>();
  private translucentOriginals = new Map<THREE.Mesh, THREE.Material>();
  private translucentMats = new Map<THREE.Mesh, THREE.RawShaderMaterial>();
  private shadowMats = new Map<THREE.Mesh, THREE.RawShaderMaterial>();

  /**
   * `lighting` holds the uniforms the composite updates every sample; each
   * translucent mesh's studio material shares those objects, so it is lit by
   * the same sample.
   */
  constructor(
    private readonly studio: StudioScene,
    lighting: Record<string, THREE.IUniform> = {},
  ) {
    this.impostors = studio.impostors.map((mesh) => {
      const material = mesh.material as THREE.ShaderMaterial;
      return {
        mesh,
        material,
        transparent: material.transparent,
        depthWrite: material.depthWrite,
        blending: material.blending,
      };
    });
    for (const mesh of studio.surfaces) {
      const original = mesh.material as THREE.MeshStandardMaterial;
      this.surfaceOriginals.set(mesh, original);
      const color = original.color ?? new THREE.Color(0xffffff);
      this.albedoMats.set(
        mesh,
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: surfaceAlbedoVertexShader,
          fragmentShader: surfaceAlbedoFragmentShader,
          uniforms: {
            uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
            uVertexColors: {
              value: original.vertexColors && mesh.geometry.getAttribute("color") ? 1 : 0,
            },
          },
          side: original.side,
        }),
      );
      this.normalMats.set(
        mesh,
        new THREE.MeshNormalMaterial({ side: original.side, flatShading: original.flatShading }),
      );
    }
    for (const mesh of studio.translucent) {
      const original = mesh.material as THREE.MeshPhongMaterial;
      this.translucentOriginals.set(mesh, original);
      const color = original.color ?? new THREE.Color(0xffffff);
      const geo = mesh.geometry;
      this.translucentMats.set(
        mesh,
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: translucentVertexShader,
          fragmentShader: translucentFragmentShader,
          uniforms: {
            ...lighting,
            uColor: { value: new THREE.Vector3(color.r, color.g, color.b) },
            uOpacity: { value: original.opacity },
            uVertexColors: { value: original.vertexColors && geo.getAttribute("color") ? 1 : 0 },
            uHasNormals: { value: geo.getAttribute("normal") && !original.flatShading ? 1 : 0 },
          },
          side: original.side,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: THREE.NormalBlending,
        }),
      );
      this.shadowMats.set(
        mesh,
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: shadowCasterVertexShader,
          fragmentShader: stochasticShadowFragmentShader,
          uniforms: { uOpacity: { value: original.opacity }, uSeed: { value: 0 } },
          side: THREE.DoubleSide,
        }),
      );
    }
    for (const obj of studio.overlay) this.overlayVisible.set(obj, obj.visible);
  }

  /**
   * Shadow pass: the G-buffer's opaque geometry plus the translucent meshes as
   * stochastic casters, drawn with a fresh pattern per map (`seed`).
   */
  enterShadow(seed: number): void {
    this.enterGBuffer(PASS_ALBEDO);
    for (const [mesh, mat] of this.shadowMats) {
      mat.uniforms.uSeed.value = seed;
      mesh.material = mat;
      mesh.visible = true;
    }
  }

  /** Translucent pass: only the translucent meshes, with their studio materials. */
  enterTranslucent(): void {
    for (const s of this.impostors) s.mesh.visible = false;
    for (const mesh of this.studio.surfaces) mesh.visible = false;
    for (const obj of this.studio.overlay) obj.visible = false;
    for (const [mesh, mat] of this.translucentMats) {
      mesh.material = mat;
      mesh.visible = true;
    }
  }

  /** G-buffer / shadow pass: only lit geometry, opaque, with pass materials. */
  enterGBuffer(pass: typeof PASS_ALBEDO | typeof PASS_NORMAL): void {
    for (const s of this.impostors) {
      s.mesh.visible = true;
      s.material.uniforms.uPass.value = pass;
      s.material.transparent = false;
      s.material.depthWrite = true;
      s.material.blending = THREE.NoBlending;
    }
    for (const mesh of this.studio.surfaces) {
      mesh.material =
        pass === PASS_ALBEDO ? this.albedoMats.get(mesh)! : this.normalMats.get(mesh)!;
      mesh.visible = true;
    }
    for (const mesh of this.studio.translucent) mesh.visible = false;
    for (const obj of this.studio.overlay) obj.visible = false;
  }

  /** Overlay pass: translucent impostor fragments and the overlay objects. */
  enterOverlay(): void {
    for (const s of this.impostors) {
      s.material.uniforms.uPass.value = PASS_TRANSLUCENT;
      s.material.transparent = s.transparent;
      s.material.depthWrite = s.depthWrite;
      s.material.blending = s.blending;
      // A material that never had translucent fragments has nothing to add.
      s.mesh.visible = s.transparent;
    }
    for (const mesh of this.studio.surfaces) mesh.visible = false;
    for (const mesh of this.studio.translucent) mesh.visible = false;
    for (const [obj, visible] of this.overlayVisible) obj.visible = visible;
  }

  restore(): void {
    for (const s of this.impostors) {
      s.material.uniforms.uPass.value = PASS_SHADED;
      s.material.transparent = s.transparent;
      s.material.depthWrite = s.depthWrite;
      s.material.blending = s.blending;
      s.mesh.visible = true;
    }
    for (const [mesh, original] of this.surfaceOriginals) {
      mesh.material = original;
      mesh.visible = true;
    }
    for (const [mesh, original] of this.translucentOriginals) {
      mesh.material = original;
      mesh.visible = true;
    }
    for (const [obj, visible] of this.overlayVisible) obj.visible = visible;
  }

  dispose(): void {
    for (const m of this.albedoMats.values()) m.dispose();
    for (const m of this.normalMats.values()) m.dispose();
    for (const m of this.translucentMats.values()) m.dispose();
    for (const m of this.shadowMats.values()) m.dispose();
  }
}

function depthTarget(width: number, height: number, colorType: THREE.TextureDataType) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: colorType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  const depth = new THREE.DepthTexture(width, height, THREE.FloatType);
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  target.depthTexture = depth;
  return target;
}

function colorTarget(width: number, height: number, type: THREE.TextureDataType) {
  return new THREE.WebGLRenderTarget(width, height, {
    type,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
  });
}

function toVector3(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

/**
 * Shadow map edge length for an output of `width` × `height` pixels: about
 * 1.5 texels per output pixel across the longer side (the map also covers the
 * ground around the structure), as a power of two between 1024 and 4096.
 */
export function shadowMapSizeFor(width: number, height: number): number {
  const want = Math.max(width, height) * 1.5;
  let size = 1024;
  while (size < want && size < 4096) size *= 2;
  return size;
}

/** Resolve a style plus overrides into the lighting actually used. */
export function resolveLighting(
  style: StudioStyle,
  overrides: Partial<StudioLighting> = {},
): StudioLighting {
  return { ...STUDIO_PRESETS[style], ...overrides };
}

function yieldToPage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Resolve once the GPU has finished everything submitted so far, polling a
 * WebGL2 fence between tasks so the page stays responsive meanwhile. Without
 * fences (or a context) it only yields to the page.
 */
export function waitForGpu(gl: WebGL2RenderingContext | null | undefined): Promise<void> {
  const sync =
    gl && typeof gl.fenceSync === "function"
      ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      : null;
  if (!gl || !sync) return yieldToPage();
  gl.flush();
  return new Promise((resolve) => {
    const poll = () => {
      if (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
        setTimeout(poll, 1);
        return;
      }
      gl.deleteSync(sync);
      resolve();
    };
    poll();
  });
}

/**
 * Samples to submit before the next wait, so one batch takes about
 * `targetMs`: scaled from how long the last `batch` took, at most doubling per
 * step (no oscillation), between 1 and 64.
 */
export function nextBatchSize(batch: number, elapsedMs: number, targetMs: number): number {
  const ideal = Math.round((batch * targetMs) / Math.max(elapsedMs, 1));
  return Math.max(1, Math.min(64, batch * 2, ideal));
}

/**
 * Render `scene` through `camera` at the renderer's current size with the
 * studio lighting and leave the finished picture on the renderer's canvas
 * (default framebuffer). Resolves once the canvas holds the final image.
 */
export async function renderStudio(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  options: StudioRenderOptions,
): Promise<void> {
  const samples = Math.max(1, Math.floor(options.samples));
  const lighting = resolveLighting(options.style, options.lighting);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const width = Math.max(1, Math.floor(size.x));
  const height = Math.max(1, Math.floor(size.y));
  const shadowSize = options.shadowMapSize ?? shadowMapSizeFor(width, height);
  const sliceMs = options.sliceMs ?? 30;
  const gl = typeof renderer.getContext === "function" ? renderer.getContext() : null;

  const studio = classifyScene(scene, options.overlayRoots ?? []);
  const sphere = litBoundingSphere(studio) ?? new THREE.Sphere(new THREE.Vector3(), 1);

  const floatType = renderer.extensions.has("EXT_color_buffer_float")
    ? THREE.FloatType
    : THREE.HalfFloatType;
  const gAlbedo = depthTarget(width, height, THREE.HalfFloatType);
  const gNormal = depthTarget(width, height, THREE.HalfFloatType);
  const shadowSky = depthTarget(shadowSize, shadowSize, THREE.UnsignedByteType);
  const shadowKey = depthTarget(shadowSize, shadowSize, THREE.UnsignedByteType);
  // With translucent meshes each light gets a second map that includes them
  // as stochastic casters. Atoms and opaque surfaces read only the opaque map:
  // a see-through envelope or polyhedron is drawn to be seen through, not to
  // darken what it contains. The translucent meshes themselves and the ground
  // read the second one, so faces shade each other and the ground gets their
  // shadow.
  const hasTranslucent = studio.translucent.length > 0;
  const shadowSkyAll = hasTranslucent
    ? depthTarget(shadowSize, shadowSize, THREE.UnsignedByteType)
    : shadowSky;
  const shadowKeyAll = hasTranslucent
    ? depthTarget(shadowSize, shadowSize, THREE.UnsignedByteType)
    : shadowKey;
  const withTranslucentShadows = (uniforms: Record<string, THREE.IUniform>) => ({
    ...uniforms,
    tShadowSky: { value: shadowSkyAll.depthTexture },
    tShadowKey: { value: shadowKeyAll.depthTexture },
  });
  // Running sums, ping-ponged: radiance + coverage, and the ground shadow.
  let accRead = colorTarget(width, height, floatType);
  let accWrite = colorTarget(width, height, floatType);
  let floorRead = colorTarget(width, height, floatType);
  let floorWrite = colorTarget(width, height, floatType);
  // One sample before it is added: the lit opaque scene, translucent over it.
  const sampleTarget = colorTarget(width, height, floatType);
  const floor = options.floorShadow === false ? null : lighting.floor;
  // A ground shadow lands beside the structure, so the shadow maps look wider.
  const lightFrame = floor ? 1.6 : 1;

  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const composite = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertexShader,
    fragmentShader: compositeFragmentShader(false),
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tPrev: { value: null },
      tAlbedo: { value: gAlbedo.texture },
      tNormal: { value: gNormal.texture },
      tDepth: { value: gAlbedo.depthTexture },
      tShadowSky: { value: shadowSky.depthTexture },
      tShadowKey: { value: shadowKey.depthTexture },
      uInvProj: { value: new THREE.Matrix4() },
      uOrtho: { value: (camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0 },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uViewToSky: { value: new THREE.Matrix4() },
      uViewToKey: { value: new THREE.Matrix4() },
      uSkyBias: { value: new THREE.Vector2() },
      uKeyBias: { value: new THREE.Vector2() },
      uShadowTexel: { value: 1 / shadowSize },
      uSkyDir: { value: new THREE.Vector3() },
      uSkyRadiance: { value: new THREE.Vector3() },
      uKeyDir: { value: new THREE.Vector3() },
      uKeyRadiance: { value: new THREE.Vector3() },
      uRimDir: { value: new THREE.Vector3() },
      uRimRadiance: { value: new THREE.Vector3() },
      uFloor: { value: floor ? 1 : 0 },
      uFloorNormal: { value: new THREE.Vector3() },
      uFloorD: { value: 0 },
      uFloorCenter: { value: new THREE.Vector3() },
      uFloorFade: { value: sphere.radius * 1.6 },
      uFloorNorm: { value: 1 },
      uSpecular: { value: lighting.specular },
      uShininess: { value: lighting.shininess },
      uOutline: { value: lighting.outline ? 1 : 0 },
      uOutlineWidth: { value: lighting.outline?.width ?? 0 },
      uOutlineThreshold: { value: lighting.outline?.threshold ?? 0 },
      uOutlineColor: { value: toVector3(lighting.outline?.color ?? [0, 0, 0]) },
    },
  });

  // Same uniforms, ground-shadow output (see compositeFragmentShader).
  const floorComposite = floor
    ? new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: fullscreenVertexShader,
        fragmentShader: compositeFragmentShader(true),
        depthTest: false,
        depthWrite: false,
        uniforms: withTranslucentShadows(composite.uniforms),
      })
    : null;

  const accumulate = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertexShader,
    fragmentShader: accumulateFragmentShader,
    depthTest: false,
    depthWrite: false,
    uniforms: { tPrev: { value: null }, tSample: { value: sampleTarget.texture } },
  });

  const background = new THREE.Color(0xffffff);
  let backgroundAlpha = options.transparent ? 0 : 1;
  if (!options.transparent) {
    if (scene.background instanceof THREE.Color) background.copy(scene.background);
    else if (scene.background == null) backgroundAlpha = 0;
  }
  const resolve = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: fullscreenVertexShader,
    fragmentShader: resolveFragmentShader,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    uniforms: {
      tAccum: { value: null },
      tFloor: { value: null },
      uFloorStrength: { value: floor?.strength ?? 0 },
      tDepth: { value: gAlbedo.depthTexture },
      uInvSamples: { value: 1 / samples },
      uExposure: { value: lighting.exposure },
      // THREE.Color holds linear RGB under three's colour management.
      uBackground: { value: new THREE.Vector3(background.r, background.g, background.b) },
      uBackgroundAlpha: { value: backgroundAlpha },
    },
  });

  const rand = seededRandom(options.seed ?? 1);
  // Each direction jittered inside its own patch of the lattice (radius about
  // 2/sqrt(n) rad): the sky's separate shadows turn into noise that averages
  // out, instead of copies of the structure's shadow.
  const skyCell = 2 / Math.sqrt(samples);
  const skyDirs = sphereDirections(samples, rand).map((d) =>
    coneDirection(d, skyCell, rand(), rand()),
  );
  const jitter = pixelJitter(samples);
  const rim = lighting.rim;
  const rimRadiance = rim
    ? toVector3(rim.color).multiplyScalar(rim.intensity)
    : new THREE.Vector3();
  const keyRadiance = toVector3(lighting.key.color).multiplyScalar(lighting.key.intensity);
  const keyHalfAngle = (lighting.key.softness * Math.PI) / 180;

  // Bias in world units, from the size of one shadow-map texel.
  const texelWorld = (2 * sphere.radius * lightFrame) / shadowSize;
  const depthRange = 2 * Math.max(sphere.radius, 1e-3) * 1.02 + 1;
  const bias = new THREE.Vector2(1.5 * texelWorld, (0.75 * texelWorld) / depthRange);

  const passes = new PassState(studio, withTranslucentShadows(composite.uniforms));
  const savedBackground = scene.background;
  const savedTarget = renderer.getRenderTarget();
  const savedClear = renderer.getClearColor(new THREE.Color());
  const savedClearAlpha = renderer.getClearAlpha();
  const savedAutoClear = renderer.autoClear;
  const savedView = camera.view?.enabled ? { ...camera.view } : null;
  const lightCam = new THREE.OrthographicCamera();
  const camWorld = new THREE.Matrix4();
  const tmpDir = new THREE.Vector3();

  const drawGBuffer = (cam: THREE.Camera) => {
    passes.enterGBuffer(PASS_ALBEDO);
    renderer.setRenderTarget(gAlbedo);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    passes.enterGBuffer(PASS_NORMAL);
    renderer.setRenderTarget(gNormal);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
  };

  let shadowSeed = 0;
  const drawShadow = (
    target: THREE.WebGLRenderTarget,
    targetAll: THREE.WebGLRenderTarget,
    toLightView: THREE.Vector3,
  ) => {
    tmpDir.copy(toLightView).transformDirection(camWorld);
    lightCamera(sphere, tmpDir, lightCam, lightFrame);
    passes.enterGBuffer(PASS_ALBEDO);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    renderer.render(scene, lightCam);
    if (targetAll !== target) {
      passes.enterShadow((shadowSeed = (shadowSeed + 1) % 4096) * 7.31);
      renderer.setRenderTarget(targetAll);
      renderer.clear(true, true, false);
      renderer.render(scene, lightCam);
    }
    // view -> world -> light view -> light clip
    return new THREE.Matrix4()
      .multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse)
      .multiply(camWorld);
  };

  const luminance = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  /** Place the ground under the structure, in view space, for this camera. */
  const setupFloor = () => {
    const nView = new THREE.Vector3(...floorNormal(floor!.tilt));
    const nWorld = nView.clone().transformDirection(camWorld);
    const lowest = litMinAlong(studio, nWorld) ?? sphere.center.dot(nWorld) - sphere.radius;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camWorld);
    const u = composite.uniforms;
    u.uFloorNormal.value.copy(nView);
    u.uFloorD.value = lowest - nWorld.dot(camPos);
    const centerOnFloor = sphere.center
      .clone()
      .addScaledVector(nWorld, lowest - sphere.center.dot(nWorld))
      .applyMatrix4(camera.matrixWorldInverse);
    u.uFloorCenter.value.copy(centerOnFloor);
    // The ground's unshadowed irradiance with the same estimator the shader
    // uses, so a ground in the open reads exactly the background colour.
    const n: Vec3 = [nView.x, nView.y, nView.z];
    let sky = 0;
    for (const d of skyDirs) {
      const cos = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
      if (cos > 0) sky += luminance(skyRadiance(lighting.sky, d)) * 4 * cos;
    }
    sky /= skyDirs.length;
    const k = lighting.key.direction;
    const keyCos = Math.max(0, n[0] * k[0] + n[1] * k[1] + n[2] * k[2]);
    u.uFloorNorm.value = sky + luminance(lighting.key.color) * lighting.key.intensity * keyCos;
  };

  try {
    scene.background = null;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);
    camera.updateMatrixWorld(true);
    camWorld.copy(camera.matrixWorld);

    renderer.setRenderTarget(accRead);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(floorRead);
    renderer.clear(true, false, false);
    if (floor) setupFloor();

    let sliceStart = performance.now();
    let batch = 1;
    let inBatch = 0;
    for (let i = 0; i < samples; i++) {
      if (options.signal?.aborted) throw new DOMException("Render aborted", "AbortError");

      const [jx, jy] = jitter[i];
      camera.setViewOffset(width, height, jx, jy, width, height);
      camera.updateProjectionMatrix();

      drawGBuffer(camera);

      const skyView = new THREE.Vector3(...skyDirs[i]);
      const keyView = new THREE.Vector3(
        ...coneDirection(lighting.key.direction, keyHalfAngle, rand(), rand()),
      );
      const viewToSky = drawShadow(shadowSky, shadowSkyAll, skyView);
      const viewToKey =
        lighting.key.intensity > 0 ? drawShadow(shadowKey, shadowKeyAll, keyView) : viewToSky;

      const u = composite.uniforms;
      u.tPrev.value = accRead.texture;
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uViewToSky.value.copy(viewToSky);
      u.uViewToKey.value.copy(viewToKey);
      u.uSkyBias.value.copy(bias);
      u.uKeyBias.value.copy(bias);
      u.uSkyDir.value.copy(skyView);
      u.uSkyRadiance.value.copy(toVector3(skyRadiance(lighting.sky, skyDirs[i])));
      u.uKeyDir.value.copy(keyView);
      u.uKeyRadiance.value.copy(keyRadiance);
      u.uRimDir.value.copy(rim ? toVector3(rim.direction) : new THREE.Vector3());
      u.uRimRadiance.value.copy(rimRadiance);
      quad.material = composite;
      renderer.setRenderTarget(sampleTarget);
      renderer.render(quadScene, quadCamera);
      if (studio.translucent.length > 0) {
        passes.enterTranslucent();
        renderer.render(scene, camera);
      }
      accumulate.uniforms.tPrev.value = accRead.texture;
      quad.material = accumulate;
      renderer.setRenderTarget(accWrite);
      renderer.render(quadScene, quadCamera);
      [accRead, accWrite] = [accWrite, accRead];
      if (floorComposite) {
        u.tPrev.value = floorRead.texture;
        quad.material = floorComposite;
        renderer.setRenderTarget(floorWrite);
        renderer.render(quadScene, quadCamera);
        [floorRead, floorWrite] = [floorWrite, floorRead];
      }

      if (savedView) {
        camera.setViewOffset(
          savedView.fullWidth,
          savedView.fullHeight,
          savedView.offsetX,
          savedView.offsetY,
          savedView.width,
          savedView.height,
        );
      } else {
        camera.clearViewOffset();
      }

      options.onProgress?.((i + 1) / samples);
      inBatch++;
      if (inBatch >= batch && i < samples - 1) {
        await waitForGpu(gl as WebGL2RenderingContext | null);
        const now = performance.now();
        batch = nextBatchSize(batch, now - sliceStart, sliceMs);
        inBatch = 0;
        sliceStart = now;
        // The page may have redrawn (or moved the camera) meanwhile.
        camera.updateMatrixWorld(true);
        camWorld.copy(camera.matrixWorld);
      }
    }

    // Unjittered depth for the overlay, then the resolve onto the canvas.
    camera.updateProjectionMatrix();
    passes.enterGBuffer(PASS_ALBEDO);
    renderer.setRenderTarget(gAlbedo);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    resolve.uniforms.tAccum.value = accRead.texture;
    resolve.uniforms.tFloor.value = floorRead.texture;
    quad.material = resolve;
    renderer.render(quadScene, quadCamera);

    passes.enterOverlay();
    renderer.render(scene, camera);
  } finally {
    passes.restore();
    passes.dispose();
    scene.background = savedBackground;
    renderer.autoClear = savedAutoClear;
    renderer.setClearColor(savedClear, savedClearAlpha);
    renderer.setRenderTarget(savedTarget);
    if (savedView) {
      camera.setViewOffset(
        savedView.fullWidth,
        savedView.fullHeight,
        savedView.offsetX,
        savedView.offsetY,
        savedView.width,
        savedView.height,
      );
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
    for (const t of [
      gAlbedo,
      gNormal,
      shadowSky,
      shadowKey,
      ...(hasTranslucent ? [shadowSkyAll, shadowKeyAll] : []),
      accRead,
      accWrite,
      floorRead,
      floorWrite,
      sampleTarget,
    ]) {
      t.depthTexture?.dispose();
      t.dispose();
    }
    composite.dispose();
    floorComposite?.dispose();
    accumulate.dispose();
    resolve.dispose();
    quad.geometry.dispose();
  }
}

export { isImpostorMesh };
