/**
 * MoleculeRenderer.dispose() must release what mount() attached to the host
 * page. React StrictMode mounts, disposes and remounts every Viewport, so a
 * leftover ResizeObserver keeps calling into the disposed renderer (and keeps
 * it, its scene and its buffers alive) for as long as the container exists.
 *
 * jsdom has no WebGL, 2D canvas, ResizeObserver or matchMedia, so those are
 * stubbed; everything else in mount() is the real code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class FakeWebGLRenderer {
    domElement = document.createElement("canvas");
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    setClearColor = vi.fn();
    render = vi.fn();
    getSize = (v: InstanceType<typeof actual.Vector2>) => v.set(100, 100);
    getPixelRatio = () => 1;
    dispose = vi.fn();
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

vi.mock("@/renderer/LabelOverlay", () => ({
  LabelOverlay: class {
    private canvas = document.createElement("canvas");
    getCanvas() {
      return this.canvas;
    }
    resize() {}
    render() {}
    dispose() {}
  },
}));

import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  /** Deliver a notification, as the browser would after a layout change. */
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function makeContainer(): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
  document.body.appendChild(el);
  return el;
}

/** The fake WebGLRenderer the mounted renderer drew with. */
function gl(renderer: MoleculeRenderer): { setSize: ReturnType<typeof vi.fn> } {
  return (renderer as unknown as { renderer: { setSize: ReturnType<typeof vi.fn> } }).renderer;
}

describe("MoleculeRenderer dispose", () => {
  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("observes the container on mount and disconnects the observer on dispose", () => {
    const container = makeContainer();
    const renderer = new MoleculeRenderer();
    renderer.mount(container);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    const [observer] = FakeResizeObserver.instances;
    expect(observer.observe).toHaveBeenCalledWith(container);

    renderer.dispose();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("ignores a resize delivered after dispose (StrictMode mount → dispose → mount)", () => {
    const container = makeContainer();
    const first = new MoleculeRenderer();
    first.mount(container);
    const firstObserver = FakeResizeObserver.instances[0];
    first.dispose();

    const second = new MoleculeRenderer();
    second.mount(container);
    expect(FakeResizeObserver.instances).toHaveLength(2);

    // A layout change: only the live renderer may react to it.
    Object.defineProperty(container, "clientWidth", { value: 200, configurable: true });
    const before = gl(first).setSize.mock.calls.length;
    firstObserver.fire();
    expect(gl(first).setSize.mock.calls.length).toBe(before);

    FakeResizeObserver.instances[1].fire();
    expect(gl(second).setSize).toHaveBeenLastCalledWith(200, 100, false);
    second.dispose();
  });

  it("disposes a renderer that never mounted without throwing", () => {
    expect(() => new MoleculeRenderer().dispose()).not.toThrow();
  });
});
