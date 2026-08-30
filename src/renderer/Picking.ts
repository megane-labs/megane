/**
 * Screen-space atom and bond picking.
 * Pure functions that project 3D positions to screen coordinates
 * and perform hit-testing against mouse position.
 */

import * as THREE from "three";
import type { Snapshot, HoverInfo } from "../types";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { getElementSymbol, getRadius, BALL_STICK_ATOM_SCALE } from "../constants";

// Temporary vector for screen-space projection (avoids allocation per atom)
const _projVec = new THREE.Vector4();

/** Project a 3D point to screen coordinates. Returns {sx, sy, depth} in pixels. */
export function projectToScreen(
  camera: THREE.Camera,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
): { sx: number; sy: number; depth: number } {
  _projVec.set(x, y, z, 1);
  _projVec.applyMatrix4(camera.matrixWorldInverse);
  const depth = -_projVec.z; // camera-space depth (positive = in front)
  _projVec.applyMatrix4(camera.projectionMatrix);
  // NDC to pixels
  const sx = ((_projVec.x / _projVec.w) * 0.5 + 0.5) * w;
  const sy = ((-_projVec.y / _projVec.w) * 0.5 + 0.5) * h;
  return { sx, sy, depth };
}

/** Estimate the screen-space radius (in pixels) of a sphere at the given depth. */
export function screenRadius(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  worldRadius: number,
  depth: number,
  h: number,
): number {
  if (camera instanceof THREE.OrthographicCamera) {
    // Orthographic: size is independent of depth
    const frustumHeight = (camera.top - camera.bottom) / camera.zoom;
    const pxPerUnit = h / frustumHeight;
    return worldRadius * pxPerUnit;
  }
  const fovRad = (camera.fov * Math.PI) / 180;
  const pxPerUnit = h / (2 * depth * Math.tan(fovRad / 2));
  return worldRadius * pxPerUnit;
}

/** Perform a pick at the given screen coordinates using CPU screen-space projection. */
export function pickAtPixel(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  container: HTMLElement,
  snapshot: Snapshot,
  currentPositions: Float32Array,
  atomScale: number,
  clientX: number,
  clientY: number,
  drawingBoundary: DrawingBoundaryData | null = null,
  periodicImages: PeriodicAtomImageData | null = null,
  /**
   * Fraction of the vdW radius the atoms are drawn at. Must track the active
   * representation (SPACEFILL_ATOM_SCALE under "illustrative"), or the pick
   * radius stops matching the sphere the user is actually clicking on.
   */
  radiusScale: number = BALL_STICK_ATOM_SCALE,
): HoverInfo {
  const rect = container.getBoundingClientRect();
  const mx = clientX - rect.left; // mouse in pixels relative to container
  const my = clientY - rect.top;
  const w = rect.width;
  const h = rect.height;

  const pos = currentPositions;
  const elements = snapshot.elements;
  const nAtoms = snapshot.nAtoms;

  // --- Atom picking ---
  let bestAtomIdx = -1;
  let bestAtomDepth = Infinity;
  let bestAtomPosition: [number, number, number] | null = null;

  for (let i = 0; i < nAtoms; i++) {
    if (drawingBoundary && !drawingBoundary.sourceVisibleMask[i]) continue;
    const { sx, sy, depth } = projectToScreen(
      camera,
      pos[i * 3],
      pos[i * 3 + 1],
      pos[i * 3 + 2],
      w,
      h,
    );
    if (depth <= 0) continue; // behind camera

    const worldR = getRadius(elements[i]) * radiusScale * atomScale;
    const screenR = screenRadius(camera, worldR, depth, h);
    const dx = mx - sx;
    const dy = my - sy;
    const distSq = dx * dx + dy * dy;

    if (distSq <= screenR * screenR && depth < bestAtomDepth) {
      bestAtomIdx = i;
      bestAtomDepth = depth;
      bestAtomPosition = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    }
  }

  for (const images of [drawingBoundary?.images, periodicImages]) {
    if (!images) continue;
    for (let image = 0; image < images.sourceIndices.length; image++) {
      const source = images.sourceIndices[image];
      const i3 = image * 3;
      const { sx, sy, depth } = projectToScreen(
        camera,
        images.positions[i3],
        images.positions[i3 + 1],
        images.positions[i3 + 2],
        w,
        h,
      );
      if (depth <= 0) continue;
      const worldR = getRadius(elements[source]) * radiusScale * atomScale;
      const screenR = screenRadius(camera, worldR, depth, h);
      const dx = mx - sx;
      const dy = my - sy;
      if (dx * dx + dy * dy <= screenR * screenR && depth < bestAtomDepth) {
        bestAtomIdx = source;
        bestAtomDepth = depth;
        bestAtomPosition = [
          images.positions[i3],
          images.positions[i3 + 1],
          images.positions[i3 + 2],
        ];
      }
    }
  }

  if (bestAtomIdx >= 0) {
    const idx = bestAtomIdx;
    const atomicNum = elements[idx];
    return {
      kind: "atom",
      atomIndex: idx,
      elementSymbol: getElementSymbol(atomicNum),
      atomicNumber: atomicNum,
      position: bestAtomPosition ?? [pos[idx * 3], pos[idx * 3 + 1], pos[idx * 3 + 2]],
      screenX: clientX,
      screenY: clientY,
    };
  }

  // --- Bond picking ---
  const BOND_PICK_THRESHOLD_PX = 8;
  const bonds = snapshot.bonds;
  const nBonds = snapshot.nBonds;
  const bondOrders = snapshot.bondOrders;
  let bestBondIdx = -1;
  let bestBondDepth = Infinity;

  for (let b = 0; b < nBonds; b++) {
    const ai = bonds[b * 2];
    const bi = bonds[b * 2 + 1];
    // midpoint
    const midX = (pos[ai * 3] + pos[bi * 3]) * 0.5;
    const midY = (pos[ai * 3 + 1] + pos[bi * 3 + 1]) * 0.5;
    const midZ = (pos[ai * 3 + 2] + pos[bi * 3 + 2]) * 0.5;
    const { sx, sy, depth } = projectToScreen(camera, midX, midY, midZ, w, h);
    if (depth <= 0) continue;
    const dx = mx - sx;
    const dy = my - sy;
    const distSq = dx * dx + dy * dy;
    if (distSq <= BOND_PICK_THRESHOLD_PX * BOND_PICK_THRESHOLD_PX && depth < bestBondDepth) {
      bestBondIdx = b;
      bestBondDepth = depth;
    }
  }

  if (bestBondIdx >= 0) {
    const ai = bonds[bestBondIdx * 2];
    const bi = bonds[bestBondIdx * 2 + 1];
    const dxw = pos[bi * 3] - pos[ai * 3];
    const dyw = pos[bi * 3 + 1] - pos[ai * 3 + 1];
    const dzw = pos[bi * 3 + 2] - pos[ai * 3 + 2];
    const bondLength = Math.sqrt(dxw * dxw + dyw * dyw + dzw * dzw);
    const bondOrder = bondOrders ? bondOrders[bestBondIdx] : 1;
    return {
      kind: "bond",
      atomA: ai,
      atomB: bi,
      bondOrder,
      bondLength,
      screenX: clientX,
      screenY: clientY,
    };
  }

  return null;
}

/** A rubber-band rectangle in client coordinates (any corner order). */
export interface ClientRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Return the indices of every atom whose projected center falls inside `rect`
 * (a screen-space rubber-band box in client coordinates). Atoms behind the
 * camera are ignored. Uses the same CPU projection as `pickAtPixel`, so it is
 * consistent with click picking.
 */
export function atomsInRect(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  container: HTMLElement,
  snapshot: Snapshot,
  currentPositions: Float32Array,
  rect: ClientRect,
  drawingBoundary: DrawingBoundaryData | null = null,
  periodicImages: PeriodicAtomImageData | null = null,
): number[] {
  const bounds = container.getBoundingClientRect();
  const w = bounds.width;
  const h = bounds.height;
  const minX = Math.min(rect.x0, rect.x1) - bounds.left;
  const maxX = Math.max(rect.x0, rect.x1) - bounds.left;
  const minY = Math.min(rect.y0, rect.y1) - bounds.top;
  const maxY = Math.max(rect.y0, rect.y1) - bounds.top;

  const pos = currentPositions;
  const result: number[] = [];
  const selected = new Set<number>();
  for (let i = 0; i < snapshot.nAtoms; i++) {
    if (drawingBoundary && !drawingBoundary.sourceVisibleMask[i]) continue;
    const { sx, sy, depth } = projectToScreen(
      camera,
      pos[i * 3],
      pos[i * 3 + 1],
      pos[i * 3 + 2],
      w,
      h,
    );
    if (depth <= 0) continue; // behind camera
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
      result.push(i);
      selected.add(i);
    }
  }
  for (const images of [drawingBoundary?.images, periodicImages]) {
    if (!images) continue;
    for (let image = 0; image < images.sourceIndices.length; image++) {
      const source = images.sourceIndices[image];
      if (selected.has(source)) continue;
      const i3 = image * 3;
      const { sx, sy, depth } = projectToScreen(
        camera,
        images.positions[i3],
        images.positions[i3 + 1],
        images.positions[i3 + 2],
        w,
        h,
      );
      if (depth <= 0) continue;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        result.push(source);
        selected.add(source);
      }
    }
  }
  return result;
}
