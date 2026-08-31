import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PolyhedronRenderer } from "@/renderer/PolyhedronRenderer";
import type { MeshData } from "@/pipeline/types";

function meshData(overrides: Partial<MeshData> = {}): MeshData {
  return {
    type: "mesh",
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([0.1, 0.2, 0.9, 0.3, 0.1, 0.2, 0.9, 0.3, 0.1, 0.2, 0.9, 0.3]),
    opacity: 0.3,
    showEdges: false,
    edgePositions: null,
    edgeColor: "#dddddd",
    edgeWidth: 1,
    ...overrides,
  };
}

/**
 * The face passes, in draw order. LineSegments2 also extends Mesh, so identify
 * the face passes by the surface shader's uniforms rather than by `isMesh`.
 */
function faceMeshes(renderer: PolyhedronRenderer): THREE.Mesh[] {
  return renderer.group.children.filter(
    (c): c is THREE.Mesh =>
      (c as THREE.Mesh).isMesh === true &&
      "uOpacity" in (((c as THREE.Mesh).material as THREE.ShaderMaterial).uniforms ?? {}),
  );
}

describe("PolyhedronRenderer transparent face passes", () => {
  it("draws back faces before front faces so the two layers composite in order", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(meshData());

    const meshes = faceMeshes(renderer);
    expect(meshes).toHaveLength(2);

    const [back, front] = meshes;
    expect((back.material as THREE.Material).side).toBe(THREE.BackSide);
    expect((front.material as THREE.Material).side).toBe(THREE.FrontSide);
    expect(back.renderOrder).toBeLessThan(front.renderOrder);
  });

  it("shares one geometry between the passes and gives each its own opacity uniform", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(meshData({ opacity: 0.42 }));

    const [back, front] = faceMeshes(renderer);
    expect(back.geometry).toBe(front.geometry);
    for (const mesh of [back, front]) {
      const mat = mesh.material as THREE.ShaderMaterial;
      expect(mat.uniforms.uOpacity.value).toBeCloseTo(0.42);
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
    }
  });

  it("feeds the RGB of each vertex colour through as a colour attribute", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(meshData());

    const attr = faceMeshes(renderer)[0].geometry.getAttribute("color");
    expect(attr.itemSize).toBe(3);
    expect(attr.count).toBe(3);
    const expected = [0.1, 0.2, 0.9, 0.1, 0.2, 0.9, 0.1, 0.2, 0.9];
    (attr.array as Float32Array).forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
  });

  it("keeps the edge overlay on top of both face passes", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(
      meshData({
        showEdges: true,
        edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      }),
    );

    const meshes = faceMeshes(renderer);
    const edges = renderer.group.children.find((c) => !meshes.includes(c as THREE.Mesh));
    expect(edges).toBeDefined();
    expect(edges!.renderOrder).toBeGreaterThan(Math.max(...meshes.map((m) => m.renderOrder)));
  });

  it("disposes both passes and the shared geometry on clear", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(meshData());

    const [back, front] = faceMeshes(renderer);
    let geometryDisposals = 0;
    back.geometry.addEventListener("dispose", () => geometryDisposals++);
    const materialDisposals: THREE.Material[] = [];
    for (const mesh of [back, front]) {
      const mat = mesh.material as THREE.Material;
      mat.addEventListener("dispose", () => materialDisposals.push(mat));
    }

    renderer.clear();

    expect(renderer.group.children).toHaveLength(0);
    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toHaveLength(2);

    // A second clear is a no-op rather than a double dispose.
    renderer.clear();
    expect(geometryDisposals).toBe(1);
  });

  it("pushes the viewport size into the edge line material", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(
      meshData({ showEdges: true, edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]) }),
    );

    renderer.updateResolution(1280, 720);
    const meshes = faceMeshes(renderer);
    const edges = renderer.group.children.find((c) => !meshes.includes(c as THREE.Mesh))!;
    const mat = (edges as THREE.Mesh).material as THREE.ShaderMaterial & {
      resolution: THREE.Vector2;
    };
    expect(mat.resolution.x).toBe(1280);
    expect(mat.resolution.y).toBe(720);

    // No edges, no material to size — must not throw.
    renderer.loadMeshData(meshData());
    expect(() => renderer.updateResolution(800, 600)).not.toThrow();
  });

  it("disposes the edge overlay along with the faces", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(
      meshData({ showEdges: true, edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]) }),
    );

    const meshes = faceMeshes(renderer);
    const edges = renderer.group.children.find((c) => !meshes.includes(c as THREE.Mesh)) as
      | THREE.Mesh
      | undefined;
    expect(edges).toBeDefined();
    let disposals = 0;
    edges!.geometry.addEventListener("dispose", () => disposals++);
    (edges!.material as THREE.Material).addEventListener("dispose", () => disposals++);

    renderer.dispose();

    expect(disposals).toBe(2);
    expect(renderer.group.children).toHaveLength(0);
  });

  it("toggles the whole group's visibility", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(meshData());
    renderer.setVisible(false);
    expect(renderer.group.visible).toBe(false);
    renderer.setVisible(true);
    expect(renderer.group.visible).toBe(true);
  });

  it("emits nothing for an empty mesh", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(
      meshData({ positions: new Float32Array(0), indices: new Uint32Array(0) }),
    );
    expect(renderer.group.children).toHaveLength(0);
  });
});
