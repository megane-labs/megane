import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { XRHeadLights } from "@/renderer/xr/xrLights";

/** The renderer's desktop light rig: a hemisphere and three directionals. */
function scene() {
  const s = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.4);
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(50, 50, 50);
  const rim = new THREE.DirectionalLight(0xffffff, 0.3);
  rim.position.set(0, -30, -50);
  const mesh = new THREE.Mesh();
  s.add(hemi, key, rim, mesh);
  return { s, hemi, key, rim, mesh };
}

describe("XRHeadLights", () => {
  it("moves the lights and the directional targets onto the rig", () => {
    const { s, hemi, key, rim, mesh } = scene();
    const rig = new THREE.Group();
    s.add(rig);
    const lights = new XRHeadLights();
    lights.attach(s, rig);
    expect(hemi.parent).toBe(rig);
    expect(key.parent).toBe(rig);
    expect(key.target.parent).toBe(rig);
    expect(rim.target.parent).toBe(rig);
    // Everything else stays in the scene.
    expect(mesh.parent).toBe(s);
    // A second attach while attached is a no-op.
    lights.attach(s, rig);
    expect(rig.children.filter((c) => (c as THREE.Light).isLight)).toHaveLength(3);
  });

  it("turns the directional lights with the head", () => {
    const { s, key, rim } = scene();
    const rig = new THREE.Group();
    const lights = new XRHeadLights();
    lights.attach(s, rig);
    lights.update(new THREE.Quaternion());
    // Looking down −z, the key light keeps its view-space direction:
    // upper right, from the viewer's side.
    const k = key.position.clone().sub(key.target.position);
    expect(k.length()).toBeCloseTo(1, 9);
    expect(k.x).toBeCloseTo(1 / Math.sqrt(3), 9);
    expect(k.z).toBeGreaterThan(0);
    // Turned around, the light comes from behind the head again.
    const behind = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    lights.update(behind);
    expect(key.position.z).toBeLessThan(0);
    expect(key.position.x).toBeCloseTo(-1 / Math.sqrt(3), 9);
    expect(rim.position.z).toBeGreaterThan(0);
  });

  it("puts every light back on detach", () => {
    const { s, hemi, key } = scene();
    const target = new THREE.Vector3(1, 2, 3);
    key.target.position.copy(target);
    const rig = new THREE.Group();
    const lights = new XRHeadLights();
    lights.attach(s, rig);
    lights.update(new THREE.Quaternion(0, 1, 0, 0));
    lights.detach();
    expect(hemi.parent).toBe(s);
    expect(key.parent).toBe(s);
    expect(key.position.toArray()).toEqual([50, 50, 50]);
    expect(key.target.parent).toBeNull();
    expect(key.target.position.toArray()).toEqual([1, 2, 3]);
    expect(new THREE.Vector3().setFromMatrixPosition(key.target.matrixWorld).toArray()).toEqual([
      1, 2, 3,
    ]);
    expect(rig.children).toHaveLength(0);
    // Detaching again does nothing.
    expect(() => lights.detach()).not.toThrow();
  });

  it("gives a directional light on its own target a default direction", () => {
    const s = new THREE.Scene();
    const flat = new THREE.DirectionalLight();
    flat.position.set(0, 0, 0);
    s.add(flat);
    const lights = new XRHeadLights();
    lights.attach(s, new THREE.Group());
    lights.update(new THREE.Quaternion());
    expect(flat.position.toArray()).toEqual([0, 0, 1]);
  });
});
