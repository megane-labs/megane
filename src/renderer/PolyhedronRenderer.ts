/**
 * Mesh renderer using Three.js.
 *
 * Draws every MeshData packet the pipeline produces — coordination polyhedra,
 * isosurfaces and alpha-shape surfaces — as semi-transparent face meshes with
 * an optional wireframe edge overlay. Shading comes from
 * {@link createSurfaceMaterial}, which is built so a surface keeps its hue as
 * the opacity slider comes down.
 */

import * as THREE from "three";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { MeshData } from "../pipeline/types";
import { createSurfaceMaterial } from "./surfaceMaterial";

export class PolyhedronRenderer {
  readonly group: THREE.Group;
  /** Back faces first, then front faces — see loadMeshData(). */
  private faceMeshes: THREE.Mesh[] = [];
  private edgeLines: LineSegments2 | null = null;
  private edgeMaterial: LineMaterial | null = null;

  constructor() {
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
  }

  loadMeshData(data: MeshData): void {
    this.clear();

    const nVertices = data.positions.length / 3;
    if (nVertices === 0 || data.indices.length === 0) return;

    // Face mesh
    const faceGeo = new THREE.BufferGeometry();
    faceGeo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    faceGeo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));

    // Convert RGBA vertex colors to separate color + alpha attributes
    const colorRGB = new Float32Array(nVertices * 3);
    for (let i = 0; i < nVertices; i++) {
      colorRGB[i * 3] = data.colors[i * 4];
      colorRGB[i * 3 + 1] = data.colors[i * 4 + 1];
      colorRGB[i * 3 + 2] = data.colors[i * 4 + 2];
    }
    faceGeo.setAttribute("color", new THREE.BufferAttribute(colorRGB, 3));
    faceGeo.setIndex(new THREE.BufferAttribute(data.indices, 1));

    // A closed surface covers each pixel at least twice, and with depth writes
    // off the two layers composite in whatever order the triangles happen to be
    // emitted. Drawing the mesh twice — back faces, then front faces — puts
    // them in back-to-front order instead, which is exact for a convex blob and
    // never worse for a lumpy one.
    for (const [i, side] of [THREE.BackSide, THREE.FrontSide].entries()) {
      const mesh = new THREE.Mesh(faceGeo, createSurfaceMaterial(data.opacity, side));
      mesh.renderOrder = 1 + i;
      this.faceMeshes.push(mesh);
      this.group.add(mesh);
    }

    // Edge wireframe (fat lines via LineSegments2)
    if (data.showEdges && data.edgePositions && data.edgePositions.length > 0) {
      const edgeGeo = new LineSegmentsGeometry();
      edgeGeo.setPositions(data.edgePositions);

      const edgeMat = new LineMaterial({
        color: new THREE.Color(data.edgeColor).getHex(),
        linewidth: data.edgeWidth,
        transparent: true,
        opacity: 0.9,
        depthTest: true,
      });
      this.edgeMaterial = edgeMat;

      this.edgeLines = new LineSegments2(edgeGeo, edgeMat);
      this.edgeLines.renderOrder = 3;
      this.group.add(this.edgeLines);
    }
  }

  /** Update the resolution uniform required by LineMaterial. */
  updateResolution(width: number, height: number): void {
    if (this.edgeMaterial) {
      this.edgeMaterial.resolution.set(width, height);
    }
  }

  clear(): void {
    // The two face passes share one geometry, so dispose it once.
    this.faceMeshes[0]?.geometry.dispose();
    for (const mesh of this.faceMeshes) {
      (mesh.material as THREE.Material).dispose();
      this.group.remove(mesh);
    }
    this.faceMeshes = [];
    if (this.edgeLines) {
      this.edgeLines.geometry.dispose();
      (this.edgeLines.material as THREE.Material).dispose();
      this.group.remove(this.edgeLines);
      this.edgeLines = null;
      this.edgeMaterial = null;
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.clear();
  }
}
