import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";

// Mock three.js exporters before importing RenderCapture
vi.mock("three/examples/jsm/exporters/GLTFExporter.js", () => ({
  GLTFExporter: class {
    parseAsync(_scene: unknown, options: { binary?: boolean }) {
      if (options?.binary) {
        return Promise.resolve(new ArrayBuffer(8));
      }
      return Promise.resolve({ asset: { version: "2.0" } });
    }
  },
}));

vi.mock("three/examples/jsm/exporters/OBJExporter.js", () => ({
  OBJExporter: class {
    parse(_scene: unknown) {
      return "# OBJ file\nv 0 0 0\n";
    }
  },
}));

// Mock gif.js so captureGif can run headlessly. The fake GIF records the
// constructor options (so tests can inspect the workerScript) and fires the
// "finished" handler synchronously when render() is called.
const gifInstances: FakeGif[] = [];
class FakeGif {
  options: Record<string, unknown>;
  handlers: Record<string, (arg?: unknown) => void> = {};
  frames: unknown[] = [];
  constructor(options: Record<string, unknown>) {
    this.options = options;
    gifInstances.push(this);
  }
  addFrame(frame: unknown) {
    this.frames.push(frame);
  }
  on(event: string, cb: (arg?: unknown) => void) {
    this.handlers[event] = cb;
  }
  render() {
    this.handlers["finished"]?.(new Blob([new Uint8Array([71, 73, 70])], { type: "image/gif" }));
  }
  abort() {}
}
vi.mock("gif.js", () => ({ default: FakeGif }));

import {
  compositeCanvases,
  downloadBlob,
  captureGltf,
  captureObj,
  wrapInSVG,
  captureSnapshot,
  captureGif,
  resolveGifWorkerScript,
} from "@/renderer/RenderCapture";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

function makeMockRenderer(scene?: THREE.Scene): MoleculeRenderer {
  const mockScene = scene ?? new THREE.Scene();
  return {
    getScene: () => mockScene,
    getRenderer: () =>
      ({
        getClearAlpha: () => 1,
        getClearColor: (target: THREE.Color) => target.set(0xffffff),
        setClearColor: vi.fn(),
        info: { memory: {} },
      }) as unknown as THREE.WebGLRenderer,
    getCanvas: () => null,
    getLabelOverlay: () => null,
    resizeForCapture: () => () => undefined,
    renderSingleFrame: vi.fn(),
  } as unknown as MoleculeRenderer;
}

/** Mock canvas 2D context to avoid "Not implemented: getContext" errors in jsdom. */
function mockCanvas2dContext() {
  const ctx = { drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  return ctx;
}

describe("compositeCanvases", () => {
  let ctx: { drawImage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ctx = mockCanvas2dContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an offscreen canvas with the given dimensions", () => {
    const webgl = document.createElement("canvas");
    webgl.width = 100;
    webgl.height = 50;
    const result = compositeCanvases(webgl, null, 100, 50);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it("draws the webgl canvas onto the offscreen context", () => {
    const webgl = document.createElement("canvas");
    webgl.width = 80;
    webgl.height = 60;
    compositeCanvases(webgl, null, 80, 60);
    expect(ctx.drawImage).toHaveBeenCalledWith(webgl, 0, 0, 80, 60);
  });

  it("also draws the label canvas when provided", () => {
    const webgl = document.createElement("canvas");
    const label = document.createElement("canvas");
    compositeCanvases(webgl, label, 80, 60);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(ctx.drawImage).toHaveBeenCalledWith(label, 0, 0, 80, 60);
  });

  it("skips the label canvas draw when label is null", () => {
    const webgl = document.createElement("canvas");
    compositeCanvases(webgl, null, 80, 60);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });
});

describe("downloadBlob", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    clickSpy = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(clickSpy);
    // Prevent removeChild errors by mocking both append/remove
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);
    vi.spyOn(document.body, "removeChild").mockImplementation((node) => node);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an object URL and triggers a click", () => {
    const blob = new Blob(["test"], { type: "text/plain" });
    downloadBlob(blob, "test.txt");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("revokes the object URL after downloading", () => {
    const blob = new Blob(["test"], { type: "text/plain" });
    downloadBlob(blob, "test.txt");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("sets the download attribute to the given filename", () => {
    const capturedNodes: HTMLAnchorElement[] = [];
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      capturedNodes.push(node as HTMLAnchorElement);
      return node;
    });
    const blob = new Blob(["data"], { type: "application/octet-stream" });
    downloadBlob(blob, "megane-render.glb");
    expect(capturedNodes[0].download).toBe("megane-render.glb");
  });

  describe("__MEGANE_SAVE_BLOB__ host hook", () => {
    afterEach(() => {
      delete (globalThis as { __MEGANE_SAVE_BLOB__?: unknown }).__MEGANE_SAVE_BLOB__;
    });

    it("routes the blob to the hook instead of the anchor path", () => {
      const hook = vi.fn();
      (globalThis as { __MEGANE_SAVE_BLOB__?: unknown }).__MEGANE_SAVE_BLOB__ = hook;

      const blob = new Blob(["test"], { type: "image/png" });
      downloadBlob(blob, "megane-render.png");

      expect(hook).toHaveBeenCalledExactlyOnceWith(blob, "megane-render.png");
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("falls back to the anchor path when the hook is not a function", () => {
      (globalThis as { __MEGANE_SAVE_BLOB__?: unknown }).__MEGANE_SAVE_BLOB__ = "not a function";

      const blob = new Blob(["test"], { type: "text/plain" });
      downloadBlob(blob, "test.txt");

      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("captureGltf", () => {
  it("returns a Blob with model/gltf-binary MIME type", async () => {
    const renderer = makeMockRenderer();
    const blob = await captureGltf(renderer);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("model/gltf-binary");
  });

  it("returns a non-empty Blob", async () => {
    const renderer = makeMockRenderer();
    const blob = await captureGltf(renderer);
    expect(blob.size).toBeGreaterThan(0);
  });

  it("uses the scene from the renderer", async () => {
    const scene = new THREE.Scene();
    const renderer = makeMockRenderer(scene);
    const getScene = vi.spyOn(renderer, "getScene");
    await captureGltf(renderer);
    expect(getScene).toHaveBeenCalledOnce();
  });
});

/** Helper to read a Blob as text via FileReader (works in jsdom). */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("wrapInSVG", () => {
  it("returns a Blob with image/svg+xml MIME type", async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const result = await wrapInSVG(png, 100, 80);
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe("image/svg+xml");
  });

  it("returns a non-empty Blob", async () => {
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const result = await wrapInSVG(png, 100, 80);
    expect(result.size).toBeGreaterThan(0);
  });

  it("embeds correct width and height in the SVG", async () => {
    const png = new Blob([new Uint8Array([0, 1, 2])], { type: "image/png" });
    const result = await wrapInSVG(png, 320, 240);
    const text = await readBlobText(result);
    expect(text).toContain('width="320"');
    expect(text).toContain('height="240"');
  });

  it("contains an <image> element with a data URI", async () => {
    const png = new Blob([new Uint8Array([0, 1, 2])], { type: "image/png" });
    const result = await wrapInSVG(png, 10, 10);
    const text = await readBlobText(result);
    expect(text).toContain("data:");
    expect(text).toContain("<image");
  });

  it("produces valid SVG XML with correct root element", async () => {
    const png = new Blob([new Uint8Array([0])], { type: "image/png" });
    const result = await wrapInSVG(png, 50, 50);
    const text = await readBlobText(result);
    expect(text).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain("</svg>");
  });

  it("includes viewBox matching width and height", async () => {
    const png = new Blob([new Uint8Array([0])], { type: "image/png" });
    const result = await wrapInSVG(png, 400, 300);
    const text = await readBlobText(result);
    expect(text).toContain('viewBox="0 0 400 300"');
  });
});

describe("captureSnapshot (svg format)", () => {
  let restore2d: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(16) }),
    };
    restore2d = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D) as ReturnType<typeof vi.fn>;

    // Mock toBlob to return a minimal PNG blob
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an SVG blob when format is svg", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const renderer = {
      ...makeMockRenderer(),
      getCanvas: () => canvas,
    } as unknown as MoleculeRenderer;

    const blob = await captureSnapshot(renderer, {
      width: 8,
      height: 8,
      transparent: false,
      format: "svg",
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/svg+xml");
  });
});

describe("captureObj", () => {
  it("returns a Blob with text/plain MIME type", () => {
    const renderer = makeMockRenderer();
    const blob = captureObj(renderer);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain");
  });

  it("returns a non-empty Blob", () => {
    const renderer = makeMockRenderer();
    const blob = captureObj(renderer);
    expect(blob.size).toBeGreaterThan(0);
  });

  it("uses the scene from the renderer", () => {
    const scene = new THREE.Scene();
    const renderer = makeMockRenderer(scene);
    const getScene = vi.spyOn(renderer, "getScene");
    captureObj(renderer);
    expect(getScene).toHaveBeenCalledOnce();
  });
});

// Regression coverage for issues #497 (JupyterLab) and #599 (VSCode): GIF
// export freezes at 80% and never produces a file because gif.js cannot load
// its Web Worker and hangs silently during encode instead of erroring. Both
// hosts failed on the *URL* — a labextension base path in #497, Vite's default
// `base: "/"` emitting `/gif.worker.js` for the VSCode webview in #599 — so the
// worker source is inlined at build time and only ever handed to gif.js as a
// blob: URL built in-process.
describe("resolveGifWorkerScript (issues #497, #599)", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let blobs: BlobPart[][];

  beforeEach(() => {
    blobs = [];
    createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return "blob:gif-worker-url";
    });
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });

    // Capture what gets wrapped: asserting on the Blob's contents is the only
    // way to prove the real worker source (not an HTML error page) is used.
    const RealBlob = globalThis.Blob;
    vi.stubGlobal(
      "Blob",
      class extends RealBlob {
        constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
          super(parts, options);
          blobs.push(parts);
        }
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns a blob: URL built from the bundled worker source", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const script = resolveGifWorkerScript();

    expect(script).toBe("blob:gif-worker-url");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // The bug in both #497 and #599 was a worker URL resolved against a host
    // base path. Nothing may be fetched over the network: a URL that has to be
    // retrieved is a URL that a host can serve a 404 page for.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps the real gif.js worker source, not a placeholder", () => {
    resolveGifWorkerScript();

    const source = String(blobs.at(-1)?.[0] ?? "");
    expect(source).toContain("gif.worker.js");
    expect(source).toContain("onmessage");
    // Bundled as source text, so it must be substantially larger than any
    // stub — the real worker is ~16 KB.
    expect(source.length).toBeGreaterThan(5000);
  });

  it("throws instead of hanging when the bundled source is unusable", () => {
    // A bundler that resolved `?raw` to an empty string or an HTML error page
    // would otherwise reproduce the original silent freeze at 80%.
    expect(() => resolveGifWorkerScript("")).toThrow(/gif\.js worker source/);
    expect(() => resolveGifWorkerScript("<!DOCTYPE html><html></html>")).toThrow(
      /gif\.js worker source/,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("captureGif (issues #497, #599)", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gifInstances.length = 0;

    // Composite step draws onto a 2D context — stub it out for jsdom.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    // requestAnimationFrame: run the callback on the next microtask so the
    // per-frame awaits resolve quickly.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      Promise.resolve().then(() => cb(0));
      return 0;
    });

    createObjectURL = vi.fn().mockReturnValue("blob:gif-worker-url");
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });

    // No fetch stub: the worker source is inlined at build time, so an encode
    // that reaches the network at all is the #497 / #599 bug coming back.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("captureGif must not fetch the gif.js worker");
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function makeGifRenderer(): MoleculeRenderer {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    return {
      ...makeMockRenderer(),
      getCanvas: () => canvas,
    } as unknown as MoleculeRenderer;
  }

  it("hands gif.js a blob: worker script rather than the raw URL", async () => {
    const blob = await captureGif(makeGifRenderer(), {
      width: 16,
      height: 16,
      transparent: false,
      startFrame: 0,
      endFrame: 1,
      fps: 10,
      seekFrame: vi.fn(),
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(gifInstances).toHaveLength(1);
    expect(gifInstances[0].options.workerScript).toBe("blob:gif-worker-url");
  });

  it("reports progress through 0.8 (frame capture) up to 1 (encode done)", async () => {
    const progress: number[] = [];
    await captureGif(makeGifRenderer(), {
      width: 16,
      height: 16,
      transparent: false,
      startFrame: 0,
      endFrame: 1,
      fps: 10,
      seekFrame: vi.fn(),
      onProgress: (p) => progress.push(p),
    });

    // Frame-capture phase tops out at 0.8, and the encode resolves to 1.
    expect(progress).toContain(0.8);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it("revokes the worker blob URL once encoding finishes", async () => {
    await captureGif(makeGifRenderer(), {
      width: 16,
      height: 16,
      transparent: false,
      startFrame: 0,
      endFrame: 0,
      fps: 10,
      seekFrame: vi.fn(),
    });

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:gif-worker-url");
  });
});

describe("capture state restore", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ) {
      callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeThemedRenderer(canvas: HTMLCanvasElement | null) {
    const scene = new THREE.Scene();
    const dark = new THREE.Color(0x0f172a);
    scene.background = dark;
    let clear = { color: new THREE.Color(0x0f172a), alpha: 1 };
    const webgl = {
      getClearAlpha: () => clear.alpha,
      getClearColor: (target: THREE.Color) => target.copy(clear.color),
      setClearColor: vi.fn((color: THREE.ColorRepresentation, alpha: number) => {
        clear = { color: new THREE.Color(color), alpha };
      }),
    };
    const unresize = vi.fn();
    const renderer = {
      getScene: () => scene,
      getRenderer: () => webgl,
      getCanvas: () => canvas,
      getLabelOverlay: () => null,
      resizeForCapture: vi.fn(() => unresize),
      renderSingleFrame: vi.fn(),
    } as unknown as MoleculeRenderer;
    return { renderer, scene, dark, unresize, clear: () => clear };
  }

  it("puts back the theme's clear colour after a transparent export", async () => {
    const canvas = document.createElement("canvas");
    const { renderer, scene, dark, unresize, clear } = makeThemedRenderer(canvas);
    await captureSnapshot(renderer, { width: 4, height: 4, transparent: true, format: "png" });
    expect(scene.background).toBe(dark);
    // Used to be reset to white, whatever the theme.
    expect(clear().color.getHex()).toBe(0x0f172a);
    expect(clear().alpha).toBe(1);
    expect(unresize).toHaveBeenCalledTimes(1);
  });

  it("restores the viewer when the capture throws", async () => {
    const { renderer, scene, dark, unresize, clear } = makeThemedRenderer(null);
    // The capture's own render fails; the one after the restore does not.
    vi.mocked(renderer.renderSingleFrame).mockImplementationOnce(() => {
      throw new Error("context lost");
    });
    await expect(
      captureSnapshot(renderer, { width: 4, height: 4, transparent: true, format: "png" }),
    ).rejects.toThrow("context lost");
    expect(scene.background).toBe(dark);
    expect(clear().alpha).toBe(1);
    expect(unresize).toHaveBeenCalledTimes(1);
  });
});
