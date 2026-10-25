/**
 * An export holds the drawing buffer at the export size until it is done.
 *
 * `resizeForCapture` sizes the renderer for a PNG / GIF / video export. The
 * animated exports `await` two animation frames before drawing each frame, and
 * the live render loop runs in between: it must not see the container's size
 * differ from the export size and "fix" the canvas back to the viewport, or
 * every GIF / video frame is drawn at the viewport size and stretched.
 *
 * mount() needs WebGL, so — as in the other MoleculeRenderer tests — the
 * fields `animate` / `onResize` touch are stubbed in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

function renderer(containerW = 800, containerH = 600) {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  const size = new THREE.Vector2(containerW, containerH);
  const setSize = vi.fn((w: number, h: number) => size.set(w, h));
  internals.renderer = {
    setPixelRatio: vi.fn(),
    setSize,
    getSize: (v: THREE.Vector2) => v.copy(size),
    getPixelRatio: () => 1,
    render: vi.fn(),
  };
  internals.container = { clientWidth: containerW, clientHeight: containerH };
  internals.labelOverlay = { resize: vi.fn(), render: vi.fn() };
  const camera = new THREE.OrthographicCamera();
  internals.cameraController = {
    camera,
    controls: { handleResize: vi.fn(), update: vi.fn(), target: new THREE.Vector3() },
    tick: vi.fn(),
    resize: vi.fn(),
    resizeForCapture: vi.fn(),
  };
  internals.fpsCounter = { tick: vi.fn() };
  // The canvas starts in sync with its container.
  internals.lastContainerW = containerW;
  internals.lastContainerH = containerH;
  internals.lastDpr = Math.min(window.devicePixelRatio, 2);
  return { r, internals, size, setSize };
}

describe("MoleculeRenderer.resizeForCapture", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the export size through render-loop ticks until restored", () => {
    const { r, internals, size, setSize } = renderer();
    const restore = r.resizeForCapture(1920, 1080);
    expect(size.toArray()).toEqual([1920, 1080]);
    setSize.mockClear();

    // What the live rAF loop does while captureGif / captureVideo await nextPaint().
    internals.animate(0);
    internals.animate(16);
    expect(setSize).not.toHaveBeenCalled();
    expect(size.toArray()).toEqual([1920, 1080]);

    restore();
    expect(size.toArray()).toEqual([800, 600]);
    expect(internals.lastContainerW).toBe(800);
    expect(internals.lastContainerH).toBe(600);
  });

  it("ignores container resizes during an export and applies them on restore", () => {
    const { r, internals, size } = renderer();
    const restore = r.resizeForCapture(1920, 1080);

    // The window resizes mid-export: ResizeObserver and the next frame both fire.
    internals.container = { clientWidth: 1000, clientHeight: 500 };
    internals.onResize();
    internals.animate(0);
    expect(size.toArray()).toEqual([1920, 1080]);

    restore();
    expect(size.toArray()).toEqual([1000, 500]);
    // Back in sync: the next frame does not resize again.
    const calls = internals.renderer.setSize.mock.calls.length;
    internals.animate(16);
    expect(internals.renderer.setSize.mock.calls.length).toBe(calls);
  });

  it("follows the container again after the export, and restore runs once", () => {
    const { r, internals, size } = renderer();
    const restore = r.resizeForCapture(640, 480);
    restore();
    restore();
    expect(internals.cameraController.resize).toHaveBeenCalledTimes(1);

    internals.container = { clientWidth: 400, clientHeight: 300 };
    internals.animate(0);
    expect(size.toArray()).toEqual([400, 300]);
  });
});
