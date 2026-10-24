import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { BACKGROUND_LOAD_FRAME_MS, beginBackgroundLoad } from "@/renderer/backgroundLoad";

/**
 * The render loop draws on demand (see MoleculeRendererOnDemand.test.ts), and
 * while a file is still loading in the background it also spaces out the
 * frames something asked for: it redraws when the camera moves and otherwise
 * only every BACKGROUND_LOAD_FRAME_MS. mount() needs WebGL, so — as in the
 * other MoleculeRenderer tests — the fields `animate` touches are stubbed in.
 */
function renderer() {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  const camera = new THREE.PerspectiveCamera();
  const render = vi.fn();
  internals.container = null;
  internals.cameraController = { camera, tick: vi.fn() };
  internals.renderer = {
    render,
    getSize: (v: THREE.Vector2) => v.set(10, 10),
    getPixelRatio: () => 1,
  };
  internals.fpsCounter = { tick: vi.fn() };
  const frame = (t: number) => internals.animate(t);
  return { r, frame, render, camera };
}

describe("MoleculeRenderer render loop during a background load", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws every requested frame when nothing loads in the background", () => {
    const { r, frame, render } = renderer();
    frame(0);
    r.requestRender();
    frame(16);
    r.requestRender();
    frame(32);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("spaces out requested frames but redraws at once when the camera moves", () => {
    const { r, frame, render, camera } = renderer();
    frame(0); // first frame is always drawn
    const end = beginBackgroundLoad();
    try {
      r.requestRender();
      frame(16);
      frame(32);
      expect(render).toHaveBeenCalledTimes(1);
      camera.position.x += 1; // the user drags
      frame(48);
      expect(render).toHaveBeenCalledTimes(2);
      r.requestRender();
      frame(64);
      expect(render).toHaveBeenCalledTimes(2);
      frame(48 + BACKGROUND_LOAD_FRAME_MS); // the interval has passed: the request is served
      expect(render).toHaveBeenCalledTimes(3);
      frame(48 + 2 * BACKGROUND_LOAD_FRAME_MS); // nothing was asked for since
      expect(render).toHaveBeenCalledTimes(3);
    } finally {
      end();
    }
    r.requestRender();
    frame(1000);
    r.requestRender();
    frame(1016);
    expect(render).toHaveBeenCalledTimes(5);
  });
});
