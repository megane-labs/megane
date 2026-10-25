import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer, isMeganeTestMode } from "@/renderer/MoleculeRenderer";

/**
 * getStats() feeds the performance HUD. mount() needs a real WebGL context that
 * jsdom does not provide, so — like the camera-state tests — we instantiate the
 * class without mounting and inject minimal stand-ins for the fields
 * getStats() reads.
 */
describe("MoleculeRenderer.getStats", () => {
  it("returns zeros before mount (no renderer, fresh counter)", () => {
    const r = new MoleculeRenderer();
    expect(r.getStats()).toEqual({ fps: 0, drawCalls: 0, bufferBytes: 0 });
  });

  it("reads draw calls from renderer.info, fps from the counter, bytes from the scene", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals.renderer = { info: { render: { calls: 12 } } };
    internals.fpsCounter = { fps: 55 };
    internals.scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    internals.scene.add(new THREE.Mesh(geo));
    expect(r.getStats()).toEqual({ fps: 55, drawCalls: 12, bufferBytes: 48 });
  });
});

describe("isMeganeTestMode", () => {
  it("returns a boolean", () => {
    expect(typeof isMeganeTestMode()).toBe("boolean");
  });
});
