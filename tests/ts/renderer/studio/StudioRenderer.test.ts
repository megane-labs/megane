/**
 * The studio renderer's pass sequence, driven through a recording stand-in
 * for THREE.WebGLRenderer: render targets and materials are plain objects
 * until they are drawn, so what each pass sets up — and that everything is put
 * back afterwards — can be checked without WebGL.
 */

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import {
  nextBatchSize,
  renderStudio,
  resolveLighting,
  shadowMapSizeFor,
  waitForGpu,
} from "@/renderer/studio/StudioRenderer";
import { STUDIO_PRESETS } from "@/renderer/studio/presets";

interface Draw {
  target: THREE.WebGLRenderTarget | null;
  camera: THREE.Camera;
  kind: "scene" | "composite" | "floor" | "resolve";
  atomPass: number;
  glassPass: number;
  glassVisible: boolean;
  surfaceMaterial: string;
  surfaceVisible: boolean;
  lineVisible: boolean;
  atomDepthWrite: boolean;
  view: { offsetX: number; offsetY: number } | null;
}

function impostor(transparent: boolean): THREE.Mesh {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute(
    "instanceCenter",
    new THREE.InstancedBufferAttribute(new Float32Array([0, 0, 0, 4, 0, 0]), 3),
  );
  geo.setAttribute(
    "instanceRadius",
    new THREE.InstancedBufferAttribute(new Float32Array([1, 1]), 1),
  );
  geo.instanceCount = 2;
  const mat = new THREE.RawShaderMaterial({
    uniforms: { uPass: { value: 0 }, uScaleMultiplier: { value: 1 } },
    transparent,
    depthWrite: !transparent,
  });
  return new THREE.Mesh(geo, mat);
}

function setup(opts: { floatExt?: boolean; withGl?: boolean } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x336699);
  const atoms = impostor(false);
  const glass = impostor(true);
  const surfaceMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
  const surface = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), surfaceMat);
  surface.position.set(0, 5, 0);
  const line = new THREE.LineSegments();
  const selection = new THREE.Group();
  const highlight = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  selection.add(highlight);
  scene.add(atoms, glass, surface, line, selection);

  const camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 1000);
  camera.position.set(0, 0, 30);
  camera.updateMatrixWorld(true);
  const projectionBefore = camera.projectionMatrix.clone();

  const draws: Draw[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const clearColor = new THREE.Color(0xabcdef);
  const gl = opts.withGl
    ? {
        SYNC_GPU_COMMANDS_COMPLETE: 1,
        TIMEOUT_EXPIRED: 2,
        fenceSync: vi.fn(() => ({})),
        flush: vi.fn(),
        clientWaitSync: vi.fn(() => 3),
        deleteSync: vi.fn(),
      }
    : null;
  const renderer = {
    autoClear: true,
    extensions: { has: (n: string) => (opts.floatExt ?? true) && n === "EXT_color_buffer_float" },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(8, 6),
    getRenderTarget: () => target,
    setRenderTarget: vi.fn((t: THREE.WebGLRenderTarget | null) => {
      target = t;
    }),
    getClearColor: (c: THREE.Color) => c.copy(clearColor),
    getClearAlpha: () => 0.5,
    setClearColor: vi.fn(),
    clear: vi.fn(),
    ...(gl ? { getContext: () => gl } : {}),
    render: vi.fn((s: THREE.Object3D, cam: THREE.Camera) => {
      let kind: Draw["kind"] = "scene";
      const src = (
        (s.children[0] as THREE.Mesh | undefined)?.material as THREE.RawShaderMaterial | undefined
      )?.fragmentShader;
      if (cam instanceof THREE.OrthographicCamera && src?.includes("vUv")) {
        kind = src.includes("tAccum")
          ? "resolve"
          : src.includes("FLOOR_PASS 1")
            ? "floor"
            : "composite";
      }
      const am = atoms.material as THREE.RawShaderMaterial;
      draws.push({
        target,
        camera: cam,
        kind,
        atomPass: am.uniforms.uPass.value,
        glassPass: (glass.material as THREE.RawShaderMaterial).uniforms.uPass.value,
        glassVisible: glass.visible,
        surfaceMaterial: (surface.material as THREE.Material).type,
        surfaceVisible: surface.visible,
        lineVisible: line.visible,
        atomDepthWrite: am.depthWrite,
        view: camera.view?.enabled
          ? { offsetX: camera.view.offsetX, offsetY: camera.view.offsetY }
          : null,
      });
    }),
  };
  return {
    scene,
    atoms,
    glass,
    surface,
    surfaceMat,
    line,
    selection,
    highlight,
    camera,
    projectionBefore,
    renderer: renderer as unknown as THREE.WebGLRenderer & typeof renderer,
    draws,
    gl,
  };
}

describe("renderStudio", () => {
  it("runs the G-buffer, two shadow maps and the composites per sample, then resolves", async () => {
    const t = setup();
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 3,
      style: "studio",
      transparent: false,
      overlayRoots: [t.selection],
    });
    const kinds = t.draws.map((d) => d.kind);
    // per sample: albedo, normal, sky shadow, key shadow, composite, floor
    const perSample = ["scene", "scene", "scene", "scene", "composite", "floor"];
    expect(kinds).toEqual([...perSample, ...perSample, ...perSample, "scene", "resolve", "scene"]);

    const [albedo, normal, sky, key] = t.draws;
    expect(albedo.atomPass).toBe(1);
    expect(albedo.surfaceMaterial).toBe("MeshBasicMaterial");
    expect(albedo.lineVisible).toBe(false);
    expect(albedo.atomDepthWrite).toBe(true);
    expect(normal.atomPass).toBe(2);
    expect(normal.surfaceMaterial).toBe("MeshNormalMaterial");
    expect(sky.camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(key.camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(sky.atomPass).toBe(1);

    // The overlay: translucent impostor fragments and lines over the picture.
    const overlay = t.draws[t.draws.length - 1];
    expect(overlay.target).toBeNull();
    expect(overlay.atomPass).toBe(3);
    expect(overlay.glassPass).toBe(3);
    expect(overlay.glassVisible).toBe(true);
    expect(overlay.surfaceVisible).toBe(false);
    expect(overlay.lineVisible).toBe(true);
    expect(t.draws[t.draws.length - 2].target).toBeNull();
  });

  it("jitters the camera per sample, from the pixel centre, and resolves unjittered", async () => {
    const t = setup();
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 4,
      style: "studio",
      transparent: false,
    });
    const albedos = t.draws.filter((_, i) => i % 6 === 0).slice(0, 4);
    expect(albedos[0].view).toEqual({ offsetX: 0, offsetY: 0 });
    const offsets = new Set(albedos.map((d) => `${d.view!.offsetX},${d.view!.offsetY}`));
    expect(offsets.size).toBe(4);
    const finalDepth = t.draws[t.draws.length - 3];
    expect(finalDepth.view).toBeNull();
  });

  it("puts the scene, materials, renderer state and camera back", async () => {
    const t = setup();
    const background = t.scene.background;
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 2,
      style: "dramatic",
      transparent: true,
    });
    expect((t.atoms.material as THREE.RawShaderMaterial).uniforms.uPass.value).toBe(0);
    expect((t.glass.material as THREE.RawShaderMaterial).transparent).toBe(true);
    expect((t.glass.material as THREE.RawShaderMaterial).depthWrite).toBe(false);
    expect(t.surface.material).toBe(t.surfaceMat);
    expect(t.surface.visible && t.glass.visible && t.atoms.visible && t.line.visible).toBe(true);
    expect(t.scene.background).toBe(background);
    expect(t.renderer.autoClear).toBe(true);
    expect(t.renderer.setClearColor).toHaveBeenLastCalledWith(expect.any(THREE.Color), 0.5);
    expect(t.renderer.getRenderTarget()).toBeNull();
    expect(t.camera.view?.enabled ?? false).toBe(false);
    expect(t.camera.projectionMatrix.equals(t.projectionBefore)).toBe(true);
  });

  it("keeps a view offset the camera already had", async () => {
    const t = setup();
    t.camera.setViewOffset(100, 80, 10, 5, 50, 40);
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 2,
      style: "soft",
      transparent: false,
    });
    expect(t.camera.view).toMatchObject({
      enabled: true,
      fullWidth: 100,
      offsetX: 10,
      offsetY: 5,
      width: 50,
    });
  });

  it("skips the key light's shadow and the ground for the illustrative style", async () => {
    const t = setup();
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 2,
      style: "illustrative",
      transparent: false,
    });
    // albedo, normal, sky shadow, composite — no key shadow, no floor pass
    expect(t.draws.slice(0, 4).map((d) => d.kind)).toEqual([
      "scene",
      "scene",
      "scene",
      "composite",
    ]);
    expect(t.draws.filter((d) => d.kind === "floor")).toHaveLength(0);
  });

  it("drops the ground when floorShadow is false", async () => {
    const t = setup();
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 1,
      style: "studio",
      transparent: false,
      floorShadow: false,
    });
    expect(t.draws.filter((d) => d.kind === "floor")).toHaveLength(0);
  });

  it("falls back to half-float sums without EXT_color_buffer_float", async () => {
    const t = setup({ floatExt: false });
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 1,
      style: "studio",
      transparent: false,
    });
    const composite = t.draws.find((d) => d.kind === "composite")!;
    expect(composite.target!.texture.type).toBe(THREE.HalfFloatType);
    const t2 = setup();
    await renderStudio(t2.renderer, t2.scene, t2.camera, {
      samples: 1,
      style: "studio",
      transparent: false,
    });
    expect(t2.draws.find((d) => d.kind === "composite")!.target!.texture.type).toBe(
      THREE.FloatType,
    );
  });

  it("reports progress up to 1 and waits for the GPU between batches", async () => {
    const t = setup({ withGl: true });
    const progress: number[] = [];
    await renderStudio(t.renderer, t.scene, t.camera, {
      samples: 5,
      style: "studio",
      transparent: false,
      onProgress: (f) => progress.push(f),
    });
    expect(progress).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    expect(t.gl!.fenceSync).toHaveBeenCalled();
    expect(t.gl!.deleteSync).toHaveBeenCalledTimes(t.gl!.fenceSync.mock.calls.length);
  });

  it("stops on abort and still restores the scene", async () => {
    const t = setup();
    const controller = new AbortController();
    const run = renderStudio(t.renderer, t.scene, t.camera, {
      samples: 50,
      style: "studio",
      transparent: false,
      signal: controller.signal,
      onProgress: (f) => {
        if (f > 0.05) controller.abort();
      },
    });
    await expect(run).rejects.toThrow(/aborted/);
    expect((t.atoms.material as THREE.RawShaderMaterial).uniforms.uPass.value).toBe(0);
    expect(t.surface.material).toBe(t.surfaceMat);
    expect(t.draws.some((d) => d.kind === "resolve")).toBe(false);
  });

  it("renders an empty scene without throwing", async () => {
    const t = setup();
    const scene = new THREE.Scene();
    await renderStudio(t.renderer, scene, t.camera, {
      samples: 1,
      style: "studio",
      transparent: false,
    });
    expect(t.draws.some((d) => d.kind === "resolve")).toBe(true);
  });

  it("uses a scene without a background as a transparent export", async () => {
    const t = setup();
    t.scene.background = null;
    await expect(
      renderStudio(t.renderer, t.scene, t.camera, {
        samples: 1,
        style: "studio",
        transparent: false,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveLighting", () => {
  it("is the preset, with overrides on top", () => {
    expect(resolveLighting("soft")).toEqual(STUDIO_PRESETS.soft);
    const l = resolveLighting("studio", { exposure: 1.5, floor: null });
    expect(l.exposure).toBe(1.5);
    expect(l.floor).toBeNull();
    expect(l.key).toBe(STUDIO_PRESETS.studio.key);
  });
});

describe("nextBatchSize", () => {
  it("scales toward the target, at most doubling, within 1..64", () => {
    expect(nextBatchSize(1, 5, 30)).toBe(2);
    expect(nextBatchSize(4, 30, 30)).toBe(4);
    expect(nextBatchSize(8, 120, 30)).toBe(2);
    expect(nextBatchSize(1, 500, 30)).toBe(1);
    expect(nextBatchSize(64, 0, 30)).toBe(64);
  });
});

describe("waitForGpu", () => {
  it("polls the fence until the GPU has caught up", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const gl = {
        SYNC_GPU_COMMANDS_COMPLETE: 1,
        TIMEOUT_EXPIRED: 2,
        fenceSync: vi.fn(() => ({})),
        flush: vi.fn(),
        clientWaitSync: vi.fn(() => (++polls < 3 ? 2 : 3)),
        deleteSync: vi.fn(),
      };
      const done = vi.fn();
      void waitForGpu(gl as unknown as WebGL2RenderingContext).then(done);
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toHaveBeenCalled();
      expect(gl.clientWaitSync).toHaveBeenCalledTimes(3);
      expect(gl.flush).toHaveBeenCalled();
      expect(gl.deleteSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("just yields without a fence-capable context", async () => {
    await expect(waitForGpu(null)).resolves.toBeUndefined();
    const gl = { fenceSync: () => null } as unknown as WebGL2RenderingContext;
    await expect(waitForGpu(gl)).resolves.toBeUndefined();
  });
});

describe("shadowMapSizeFor", () => {
  it("is a power of two near 1.5 texels per output pixel, within 1024..4096", () => {
    expect(shadowMapSizeFor(320, 240)).toBe(1024);
    expect(shadowMapSizeFor(1280, 720)).toBe(2048);
    expect(shadowMapSizeFor(1920, 1080)).toBe(4096);
    expect(shadowMapSizeFor(1080, 1920)).toBe(4096);
    expect(shadowMapSizeFor(7680, 4320)).toBe(4096);
  });
});
