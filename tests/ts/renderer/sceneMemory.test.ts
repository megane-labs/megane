import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { sceneBufferBytes } from "@/renderer/sceneMemory";

describe("sceneBufferBytes", () => {
  it("is 0 for an empty scene", () => {
    expect(sceneBufferBytes(new THREE.Scene())).toBe(0);
  });

  it("counts vertex and index attributes", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(3), 1));
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    expect(sceneBufferBytes(scene)).toBe(9 * 4 + 3 * 2);
  });

  it("counts a geometry shared by several meshes once", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(30), 3));
    const mat = new THREE.MeshBasicMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, mat), new THREE.Mesh(geo, mat));
    expect(sceneBufferBytes(scene)).toBe(30 * 4);
  });

  it("counts an InstancedMesh's instance matrices and colours", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 10);
    mesh.setColorAt(0, new THREE.Color(1, 0, 0));
    const scene = new THREE.Scene();
    scene.add(mesh);
    expect(sceneBufferBytes(scene)).toBe(3 * 4 + 10 * 16 * 4 + 10 * 3 * 4);
  });

  it("counts an interleaved buffer once for all the attributes viewing it", () => {
    const buffer = new THREE.InterleavedBuffer(new Float32Array(24), 6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geo.setAttribute("normal", new THREE.InterleavedBufferAttribute(buffer, 3, 3));
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
    expect(sceneBufferBytes(scene)).toBe(24 * 4);
  });

  it("counts data textures in shader uniforms and canvas textures on materials", () => {
    const data = new THREE.DataTexture(new Float32Array(4 * 8), 8, 1);
    const shader = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: data }, uScale: { value: 1 } },
    });
    const canvas = { width: 16, height: 8 } as unknown as HTMLCanvasElement;
    const basic = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas) });
    const empty = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
    const geo = new THREE.BufferGeometry();
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(geo, shader),
      // A material array, with the shader material repeated: still counted once.
      new THREE.Mesh(geo, [basic, shader, empty]),
    );
    expect(sceneBufferBytes(scene)).toBe(4 * 8 * 4 + 16 * 8 * 4);
  });

  it("walks the whole subtree", () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const group = new THREE.Group();
    group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial()));
    const scene = new THREE.Scene();
    scene.add(group);
    expect(sceneBufferBytes(scene)).toBe(6 * 4);
  });
});
