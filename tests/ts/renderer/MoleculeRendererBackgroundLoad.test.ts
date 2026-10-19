import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { BACKGROUND_LOAD_FRAME_MS, beginBackgroundLoad } from "@/renderer/backgroundLoad";

/**
 * The render loop draws every frame, except while a file is still loading in
 * the background: then it redraws when the camera moves and otherwise only
 * every BACKGROUND_LOAD_FRAME_MS. mount() needs WebGL, so — as in the other
 * MoleculeRenderer tests — the fields `animate` touches are stubbed in.
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
  return { frame, render, camera };
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

  it("draws every frame when nothing loads in the background", () => {
    const { frame, render } = renderer();
    frame(0);
    frame(16);
    frame(32);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("skips idle frames but redraws at once when the camera moves", () => {
    const { frame, render, camera } = renderer();
    frame(0); // first frame is always drawn
    const end = beginBackgroundLoad();
    try {
      frame(16);
      frame(32);
      expect(render).toHaveBeenCalledTimes(1);
      camera.position.x += 1; // the user drags
      frame(48);
      expect(render).toHaveBeenCalledTimes(2);
      frame(48 + BACKGROUND_LOAD_FRAME_MS); // idle, but the interval has passed
      expect(render).toHaveBeenCalledTimes(3);
    } finally {
      end();
    }
    frame(1000);
    frame(1016);
    expect(render).toHaveBeenCalledTimes(5);
  });
});
