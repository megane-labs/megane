import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { ArrowRenderer } from "@/renderer/ArrowRenderer";

function instancedMeshes(ar: ArrowRenderer): THREE.InstancedMesh[] {
  return ar.mesh.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
}

describe("ArrowRenderer", () => {
  it("allocates no instance meshes until vectors arrive", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array(3 * 1000), 1000);
    expect(instancedMeshes(ar)).toHaveLength(0);
    expect(ar.mesh.visible).toBe(false);
  });

  it("sizes the meshes to the vectors and draws one arrow per atom", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array([0, 0, 0, 1, 0, 0]), 2);
    ar.setVectors(new Float32Array([0, 1, 0, 0, 0, 2]));
    const [shaft, head] = instancedMeshes(ar);
    expect(shaft.count).toBe(2);
    expect(head.count).toBe(2);
    expect(shaft.instanceMatrix.count).toBe(2);
    expect(ar.mesh.visible).toBe(true);

    // The second arrow points along +z from (1,0,0); its head sits past the shaft.
    const m = new THREE.Matrix4();
    head.getMatrixAt(1, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(1);
    expect(p.z).toBeGreaterThan(1);
  });

  it("hides zero vectors by scaling their instance to nothing", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array([0, 0, 0]), 1);
    ar.setVectors(new Float32Array([0, 0, 0]));
    const m = new THREE.Matrix4();
    instancedMeshes(ar)[0].getMatrixAt(0, m);
    expect(m.determinant()).toBe(0);
  });

  it("grows the meshes when a larger structure brings vectors", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array(3), 1);
    ar.setVectors(new Float32Array([1, 0, 0]));
    expect(instancedMeshes(ar)[0].instanceMatrix.count).toBe(1);

    ar.setAtomPositions(new Float32Array(3 * 5), 5);
    ar.setVectors(new Float32Array(3 * 5).fill(1));
    const meshes = instancedMeshes(ar);
    expect(meshes).toHaveLength(2);
    expect(meshes[0].instanceMatrix.count).toBe(5);
    expect(meshes[0].count).toBe(5);
  });

  it("never reads past a vector channel shorter than the atom count", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array(3 * 4), 4);
    ar.setVectors(new Float32Array([1, 0, 0, 0, 1, 0]));
    expect(instancedMeshes(ar)[0].count).toBe(2);
  });

  it("frees the meshes when the vectors are cleared, and on dispose", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array(3), 1);
    ar.setVectors(new Float32Array([1, 0, 0]));
    ar.setScale(2);
    ar.setVectors(null);
    expect(instancedMeshes(ar)).toHaveLength(0);
    expect(ar.mesh.visible).toBe(false);

    ar.setVectors(new Float32Array([0, 1, 0]));
    expect(instancedMeshes(ar)).toHaveLength(2);
    ar.dispose();
    expect(instancedMeshes(ar)).toHaveLength(0);
  });

  it("follows the atoms on a new frame", () => {
    const ar = new ArrowRenderer();
    ar.setAtomPositions(new Float32Array([0, 0, 0]), 1);
    ar.setVectors(new Float32Array([1, 0, 0]));
    ar.setAtomPositions(new Float32Array([0, 5, 0]), 1);
    const m = new THREE.Matrix4();
    instancedMeshes(ar)[0].getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(5);
  });
});
