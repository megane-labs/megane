import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  buildAlphaSdf,
  geometryToMeshData,
  buildSurfaceMeshData,
  hexColorToRgb,
  DEFAULT_ALPHA_RADIUS,
  DEFAULT_ALPHA_SURFACE_RESOLUTION,
} from "@/renderer/alphaSurface";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePositions(...coords: number[]): Float32Array {
  return new Float32Array(coords);
}

// ─── buildAlphaSdf ────────────────────────────────────────────────────────────

describe("buildAlphaSdf – empty structure", () => {
  it("returns a grid of the requested resolution when nAtoms=0", () => {
    const res = 8;
    const result = buildAlphaSdf(new Float32Array(0), 0, 2.0, res);
    expect(result.res).toBe(res);
    expect(result.sdf.length).toBe(res * res * res);
  });

  it("fills the empty grid with positive values (all outside)", () => {
    const result = buildAlphaSdf(new Float32Array(0), 0, 2.0, 8);
    expect(result.sdf.every((v) => v > 0)).toBe(true);
  });
});

describe("buildAlphaSdf – single atom", () => {
  it("returns valid grid metadata", () => {
    const result = buildAlphaSdf(makePositions(0, 0, 0), 1, 2.0, 16);
    expect(result.res).toBe(16);
    expect(result.cellSize).toBeGreaterThan(0);
    expect(Number.isFinite(result.originX)).toBe(true);
    expect(Number.isFinite(result.originY)).toBe(true);
    expect(Number.isFinite(result.originZ)).toBe(true);
  });

  it("centre voxel is inside the alpha envelope (negative SDF)", () => {
    const res = 16;
    const result = buildAlphaSdf(makePositions(0, 0, 0), 1, 2.0, res);
    const mid = Math.floor(res / 2);
    const idx = mid * res * res + mid * res + mid;
    expect(result.sdf[idx]).toBeLessThan(0);
  });

  it("corner voxels are outside the alpha envelope (positive SDF)", () => {
    const res = 16;
    const result = buildAlphaSdf(makePositions(0, 0, 0), 1, 2.0, res);
    const cornerIdx = 0;
    expect(result.sdf[cornerIdx]).toBeGreaterThan(0);
  });

  it("larger alpha radius gives a more negative centre SDF", () => {
    const positions = makePositions(0, 0, 0);
    const res = 24;
    const small = buildAlphaSdf(positions, 1, 1.0, res);
    const large = buildAlphaSdf(positions, 1, 4.0, res);
    const mid = Math.floor(res / 2);
    const idx = mid * res * res + mid * res + mid;
    expect(large.sdf[idx]).toBeLessThan(small.sdf[idx]);
  });

  it("sdf values at the atom centre equal -alphaRadius (approximately)", () => {
    const alphaRadius = 3.0;
    const res = 32;
    const result = buildAlphaSdf(makePositions(0, 0, 0), 1, alphaRadius, res);
    const mid = Math.floor(res / 2);
    const idx = mid * res * res + mid * res + mid;
    // The centre voxel should be close to -alphaRadius (within one cell width).
    expect(result.sdf[idx]).toBeCloseTo(-alphaRadius, 0);
  });
});

describe("buildAlphaSdf – two atoms", () => {
  it("midpoint is inside both envelopes when atoms overlap", () => {
    // Two atoms 1 Å apart with alpha=2 → both envelopes cover the midpoint.
    const positions = makePositions(0, 0, 0, 1, 0, 0);
    const res = 24;
    const result = buildAlphaSdf(positions, 2, 2.0, res);
    const { originX, originY, originZ, cellSize } = result;
    const gx = Math.round((0.5 - originX) / cellSize);
    const gy = Math.round((0 - originY) / cellSize);
    const gz = Math.round((0 - originZ) / cellSize);
    const idx = gz * res * res + gy * res + gx;
    expect(result.sdf[idx]).toBeLessThan(0);
  });

  it("grid has at least some inside voxels", () => {
    const result = buildAlphaSdf(makePositions(0, 0, 0, 5, 0, 0), 2, 3.0, 24);
    const insideCount = Array.from(result.sdf).filter((v) => v < 0).length;
    expect(insideCount).toBeGreaterThan(0);
  });
});

describe("buildAlphaSdf – uses uniform radius (no element-specific VDW)", () => {
  it("produces identical grids for two atoms with the same position regardless of element", () => {
    // buildAlphaSdf doesn't take element array – radius is uniform.
    const pos = makePositions(0, 0, 0);
    const res = 16;
    const r1 = buildAlphaSdf(pos, 1, 2.5, res);
    const r2 = buildAlphaSdf(pos, 1, 2.5, res);
    expect(r1.sdf).toEqual(r2.sdf);
  });
});

// ─── hexColorToRgb ────────────────────────────────────────────────────────────

describe("hexColorToRgb", () => {
  it("parses a 6-digit hex color", () => {
    const [r, g, b] = hexColorToRgb("#ff0000");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });

  it("parses a 3-digit hex color", () => {
    const [r, g, b] = hexColorToRgb("#f00");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });

  it("parses white (#ffffff)", () => {
    const [r, g, b] = hexColorToRgb("#ffffff");
    expect(r).toBeCloseTo(1);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(1);
  });

  it("parses black (#000000)", () => {
    const [r, g, b] = hexColorToRgb("#000000");
    expect(r).toBeCloseTo(0);
    expect(g).toBeCloseTo(0);
    expect(b).toBeCloseTo(0);
  });

  it("returns fallback blue for invalid input", () => {
    const [r, g, b] = hexColorToRgb("notacolor");
    expect(r).toBeGreaterThan(0);
    expect(g).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it("falls back to blue, not NaN, for six characters that are not hex", () => {
    expect(hexColorToRgb("#zzzzzz")).toEqual([0.267, 0.533, 1.0]);
  });
});

// ─── geometryToMeshData ───────────────────────────────────────────────────────

describe("geometryToMeshData – empty geometry", () => {
  it("returns zero-length MeshData for empty geometry", () => {
    const geom = new THREE.BufferGeometry();
    const md = geometryToMeshData(geom, "#ff0000", 0.5);
    expect(md.type).toBe("mesh");
    expect(md.positions.length).toBe(0);
    expect(md.indices.length).toBe(0);
    expect(md.normals.length).toBe(0);
    expect(md.colors.length).toBe(0);
  });

  it("sets opacity in the empty case", () => {
    const md = geometryToMeshData(new THREE.BufferGeometry(), "#000000", 0.3);
    expect(md.opacity).toBeCloseTo(0.3);
  });
});

describe("geometryToMeshData – geometry with vertices", () => {
  function makeGeometry(nTriangles: number) {
    const nVerts = nTriangles * 3;
    const positions = new Float32Array(nVerts * 3);
    const normals = new Float32Array(nVerts * 3);
    for (let i = 0; i < nVerts; i++) {
      positions[i * 3] = i;
      positions[i * 3 + 1] = i + 1;
      positions[i * 3 + 2] = i + 2;
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 1;
      normals[i * 3 + 2] = 0;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    return geom;
  }

  it("positions array has length nVertices * 3", () => {
    const geom = makeGeometry(4);
    const md = geometryToMeshData(geom, "#4488ff", 0.5);
    expect(md.positions.length).toBe(12 * 3);
  });

  it("normals array has length nVertices * 3", () => {
    const geom = makeGeometry(4);
    const md = geometryToMeshData(geom, "#4488ff", 0.5);
    expect(md.normals.length).toBe(12 * 3);
  });

  it("colors array has length nVertices * 4 (RGBA)", () => {
    const geom = makeGeometry(4);
    const md = geometryToMeshData(geom, "#4488ff", 0.5);
    expect(md.colors.length).toBe(12 * 4);
  });

  it("indices form a sequential 0..nVerts-1 array", () => {
    const geom = makeGeometry(2);
    const md = geometryToMeshData(geom, "#4488ff", 0.5);
    expect(md.indices.length).toBe(6);
    for (let i = 0; i < 6; i++) {
      expect(md.indices[i]).toBe(i);
    }
  });

  it("colors encode the supplied hex color", () => {
    const geom = makeGeometry(1);
    const md = geometryToMeshData(geom, "#ff0000", 1.0);
    // First vertex should be red (1, 0, 0, 1).
    expect(md.colors[0]).toBeCloseTo(1);
    expect(md.colors[1]).toBeCloseTo(0);
    expect(md.colors[2]).toBeCloseTo(0);
    expect(md.colors[3]).toBeCloseTo(1);
  });

  it("colors alpha channel equals opacity", () => {
    const geom = makeGeometry(1);
    const md = geometryToMeshData(geom, "#ff0000", 0.4);
    expect(md.colors[3]).toBeCloseTo(0.4);
  });

  it("showEdges is false, edgePositions is null", () => {
    const geom = makeGeometry(1);
    const md = geometryToMeshData(geom, "#ff0000", 0.5);
    expect(md.showEdges).toBe(false);
    expect(md.edgePositions).toBeNull();
  });
});

// ─── buildSurfaceMeshData ─────────────────────────────────────────────────────

describe("buildSurfaceMeshData", () => {
  it("returns a MeshData with type 'mesh'", () => {
    const md = buildSurfaceMeshData(makePositions(0, 0, 0), 1, 2.0, "#4488ff", 0.5);
    expect(md.type).toBe("mesh");
  });

  it("produces non-empty geometry for a single atom", () => {
    const md = buildSurfaceMeshData(makePositions(0, 0, 0), 1, 2.0, "#4488ff", 0.5);
    expect(md.positions.length).toBeGreaterThan(0);
    expect(md.indices.length).toBeGreaterThan(0);
  });

  it("produces non-empty geometry for two atoms", () => {
    const md = buildSurfaceMeshData(makePositions(0, 0, 0, 5, 0, 0), 2, 2.5, "#ff8800", 0.7);
    expect(md.positions.length).toBeGreaterThan(0);
  });

  it("returns empty MeshData for zero atoms", () => {
    const md = buildSurfaceMeshData(new Float32Array(0), 0, 2.0, "#4488ff", 0.5);
    expect(md.positions.length).toBe(0);
  });

  it("encodes the supplied color in vertex colors", () => {
    const md = buildSurfaceMeshData(makePositions(0, 0, 0), 1, 2.0, "#ff0000", 0.5);
    // First vertex R should be close to 1 (red).
    expect(md.colors[0]).toBeCloseTo(1.0, 1);
    expect(md.colors[1]).toBeCloseTo(0.0, 1);
    expect(md.colors[2]).toBeCloseTo(0.0, 1);
  });

  it("encodes the supplied opacity in vertex colors alpha channel", () => {
    const md = buildSurfaceMeshData(makePositions(0, 0, 0), 1, 2.0, "#4488ff", 0.3);
    expect(md.colors[3]).toBeCloseTo(0.3, 2);
  });

  it("opacity field matches supplied opacity", () => {
    const md = buildSurfaceMeshData(makePositions(0, 0, 0), 1, 2.0, "#4488ff", 0.6);
    expect(md.opacity).toBeCloseTo(0.6);
  });
});

// ─── constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("DEFAULT_ALPHA_RADIUS is a positive number", () => {
    expect(DEFAULT_ALPHA_RADIUS).toBeGreaterThan(0);
  });

  it("DEFAULT_ALPHA_SURFACE_RESOLUTION is a positive integer", () => {
    expect(DEFAULT_ALPHA_SURFACE_RESOLUTION).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_ALPHA_SURFACE_RESOLUTION)).toBe(true);
  });
});
