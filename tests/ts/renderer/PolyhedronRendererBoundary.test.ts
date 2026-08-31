import { describe, expect, it } from "vitest";
import { PolyhedronRenderer } from "@/renderer/PolyhedronRenderer";
import type { MeshData } from "@/pipeline/types";

function meshData(): MeshData {
  return {
    type: "mesh",
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 1, 0.5]),
    opacity: 0.5,
    showEdges: false,
    edgePositions: null,
    edgeColor: "#dddddd",
    edgeWidth: 1,
  };
}

describe("PolyhedronRenderer responsibility", () => {
  it("renders mesh geometry only; periodic atoms belong to the particle/bond path", () => {
    const renderer = new PolyhedronRenderer();
    renderer.loadMeshData(meshData());

    // Two children: the back-face and front-face passes of the same mesh.
    expect(renderer.group.children).toHaveLength(2);

    renderer.clear();
    expect(renderer.group.children).toHaveLength(0);
  });
});
