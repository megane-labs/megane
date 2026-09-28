/**
 * OVITO-style surface mesh utilities.
 *
 * Computes a geometric envelope around a set of particle positions using a
 * uniform probe sphere (alpha value) rather than element-specific VDW radii.
 * This is appropriate for generic point clouds (LAMMPS, materials science)
 * where atoms should be treated uniformly rather than by chemical identity.
 *
 * The algorithm builds a signed-distance field (SDF) where every grid point
 * stores the minimum distance to any particle minus the alpha radius.  The
 * zero-crossing isosurface (extracted via the Three.js MarchingCubes kernel)
 * is the alpha-shape envelope.
 */

import * as THREE from "three";
import { sdfToGeometry } from "./SurfaceRenderer";
import type { MeshData } from "../pipeline/types";
import { hexToRgb } from "../pipeline/colorWriter";

/** Default alpha (probe sphere) radius in Å. */
export const DEFAULT_ALPHA_RADIUS = 3.0;

/** Default surface mesh marching-cubes grid resolution (cells per axis). */
export const DEFAULT_ALPHA_SURFACE_RESOLUTION = 48;

// ─── SDF construction ─────────────────────────────────────────────────────────

/** Layout-compatible subset of SdfResult so we can reuse sdfToGeometry. */
export interface AlphaSdfResult {
  sdf: Float32Array;
  originX: number;
  originY: number;
  originZ: number;
  cellSize: number;
  res: number;
}

/**
 * Build a signed-distance field for the alpha-shape of the given particle
 * positions using a UNIFORM probe sphere radius for every particle.
 *
 * Values are negative inside the envelope and positive outside.
 * Compatible with sdfToGeometry() for isosurface extraction.
 */
export function buildAlphaSdf(
  positions: Float32Array,
  nAtoms: number,
  alphaRadius = DEFAULT_ALPHA_RADIUS,
  res = DEFAULT_ALPHA_SURFACE_RESOLUTION,
): AlphaSdfResult {
  if (nAtoms === 0) {
    return {
      sdf: new Float32Array(res * res * res).fill(1),
      originX: 0,
      originY: 0,
      originZ: 0,
      cellSize: 1,
      res,
    };
  }

  // Compute bounding box expanded by alphaRadius.
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (let a = 0; a < nAtoms; a++) {
    const x = positions[a * 3];
    const y = positions[a * 3 + 1];
    const z = positions[a * 3 + 2];
    if (x - alphaRadius < minX) minX = x - alphaRadius;
    if (x + alphaRadius > maxX) maxX = x + alphaRadius;
    if (y - alphaRadius < minY) minY = y - alphaRadius;
    if (y + alphaRadius > maxY) maxY = y + alphaRadius;
    if (z - alphaRadius < minZ) minZ = z - alphaRadius;
    if (z + alphaRadius > maxZ) maxZ = z + alphaRadius;
  }

  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const cellSize = span / (res - 1);

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const halfGrid = ((res - 1) * cellSize) / 2;
  const originX = cx - halfGrid;
  const originY = cy - halfGrid;
  const originZ = cz - halfGrid;

  const sdf = new Float32Array(res * res * res).fill(Infinity);

  for (let a = 0; a < nAtoms; a++) {
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];

    const gxMin = Math.max(0, Math.floor((ax - alphaRadius - originX) / cellSize) - 1);
    const gxMax = Math.min(res - 1, Math.ceil((ax + alphaRadius - originX) / cellSize) + 1);
    const gyMin = Math.max(0, Math.floor((ay - alphaRadius - originY) / cellSize) - 1);
    const gyMax = Math.min(res - 1, Math.ceil((ay + alphaRadius - originY) / cellSize) + 1);
    const gzMin = Math.max(0, Math.floor((az - alphaRadius - originZ) / cellSize) - 1);
    const gzMax = Math.min(res - 1, Math.ceil((az + alphaRadius - originZ) / cellSize) + 1);

    for (let gz = gzMin; gz <= gzMax; gz++) {
      const wz = originZ + gz * cellSize;
      const dz = wz - az;
      const dz2 = dz * dz;
      for (let gy = gyMin; gy <= gyMax; gy++) {
        const wy = originY + gy * cellSize;
        const dy = wy - ay;
        const dy2 = dy * dy;
        for (let gx = gxMin; gx <= gxMax; gx++) {
          const wx = originX + gx * cellSize;
          const dx = wx - ax;
          const dist = Math.sqrt(dx * dx + dy2 + dz2) - alphaRadius;
          const idx = gz * res * res + gy * res + gx;
          if (dist < sdf[idx]) sdf[idx] = dist;
        }
      }
    }
  }

  return { sdf, originX, originY, originZ, cellSize, res };
}

// ─── Geometry → MeshData conversion ──────────────────────────────────────────

/** The neutral blue a surface falls back to when its colour does not parse. */
const DEFAULT_SURFACE_RGB = [0.267, 0.533, 1.0] as const;

/**
 * Parse a CSS/hex color string (#rrggbb or #rgb) to an [r, g, b] triple in
 * [0, 1] range.  Falls back to a neutral blue on invalid input.
 */
export function hexColorToRgb(hex: string): [number, number, number] {
  return hexToRgb(hex, DEFAULT_SURFACE_RGB);
}

/**
 * Convert a Three.js BufferGeometry (non-indexed, position + normal attributes)
 * into the MeshData format used by the pipeline's PolyhedronRenderer.
 *
 * The input geometry is expected to come from sdfToGeometry() and therefore
 * carries smooth vertex normals and non-indexed triangles.
 */
export function geometryToMeshData(
  geom: THREE.BufferGeometry,
  color: string,
  opacity: number,
): MeshData {
  const posAttr = geom.attributes.position as THREE.BufferAttribute | undefined;
  const normAttr = geom.attributes.normal as THREE.BufferAttribute | undefined;

  if (!posAttr || posAttr.count === 0) {
    return {
      type: "mesh",
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      opacity,
      showEdges: false,
      edgePositions: null,
      edgeColor: "#888888",
      edgeWidth: 1,
    };
  }

  const nVertices = posAttr.count;
  const positions = new Float32Array(nVertices * 3);
  const normals = new Float32Array(nVertices * 3);
  const colors = new Float32Array(nVertices * 4);

  for (let i = 0; i < nVertices; i++) {
    positions[i * 3] = posAttr.getX(i);
    positions[i * 3 + 1] = posAttr.getY(i);
    positions[i * 3 + 2] = posAttr.getZ(i);
  }

  if (normAttr && normAttr.count === nVertices) {
    for (let i = 0; i < nVertices; i++) {
      normals[i * 3] = normAttr.getX(i);
      normals[i * 3 + 1] = normAttr.getY(i);
      normals[i * 3 + 2] = normAttr.getZ(i);
    }
  }

  const [r, g, b] = hexColorToRgb(color);
  for (let i = 0; i < nVertices; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = opacity;
  }

  // Sequential indices for non-indexed geometry.
  const indices = new Uint32Array(nVertices);
  for (let i = 0; i < nVertices; i++) indices[i] = i;

  return {
    type: "mesh",
    positions,
    indices,
    normals,
    colors,
    opacity,
    showEdges: false,
    edgePositions: null,
    edgeColor: "#888888",
    edgeWidth: 1,
  };
}

/**
 * High-level helper: build the surface MeshData for an array of particle
 * positions in a single call.
 *
 * @param positions  Flat xyz array (length = nAtoms * 3).
 * @param nAtoms     Number of atoms.
 * @param alphaRadius  Probe sphere radius in Å (alpha value).
 * @param color      Hex color string (e.g. "#4488ff").
 * @param opacity    Surface opacity [0, 1].
 * @param res        Marching-cubes grid resolution per axis.
 */
export function buildSurfaceMeshData(
  positions: Float32Array,
  nAtoms: number,
  alphaRadius: number,
  color: string,
  opacity: number,
  res = DEFAULT_ALPHA_SURFACE_RESOLUTION,
): MeshData {
  const sdfResult = buildAlphaSdf(positions, nAtoms, alphaRadius, res);
  const geom = sdfToGeometry(sdfResult);
  return geometryToMeshData(geom, color, opacity);
}
