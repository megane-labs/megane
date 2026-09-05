/**
 * Camera management utilities for the molecular viewer.
 * Handles fit-to-view, frustum insets, and perspective switching.
 */

import * as THREE from "three";
import type { CameraControlsLike } from "./CameraControls";
import type { Snapshot } from "../types";
import { getRadius } from "../constants";
import {
  orientationFromPose,
  screenRight,
  standardOrientation,
  type CameraOrientation,
} from "./cameraOrientation";

export interface ViewExtent {
  /** Largest world-axis-aligned extent; sizes the fit distance and clipping. */
  maxExtent: number;
  /** Extent along screen-right for the orientation the bounds were computed for. */
  extentX: number;
  /** Extent along screen-up for the orientation the bounds were computed for. */
  extentY: number;
}

/**
 * Compute bounding box and center for a snapshot.
 *
 * `extentX` / `extentY` are measured along the screen axes of `orientation`
 * (default: the structure's standard orientation), so the orthographic
 * frustum fit stays tight in any view; `maxExtent` is the world AABB.
 *
 * Without a cell the bounds are those of the atoms' van der Waals spheres,
 * not just their centres: a small molecule seen along its long axis
 * projects to a very short span of centres, and a fit to that alone put
 * the spheres off screen. With a cell the parallelepiped's corners bound
 * the view, as before.
 */
export function computeViewBounds(
  snapshot: Snapshot,
  orientation: CameraOrientation = standardOrientation(snapshot.box),
): {
  center: [number, number, number];
  extent: ViewExtent;
} {
  const { positions, nAtoms } = snapshot;

  let sumX = 0,
    sumY = 0,
    sumZ = 0;
  for (let i = 0; i < nAtoms; i++) {
    sumX += positions[i * 3];
    sumY += positions[i * 3 + 1];
    sumZ += positions[i * 3 + 2];
  }

  let cx: number, cy: number, cz: number;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  // Screen-space extents along the orientation's right / up axes.
  const right = screenRight(orientation);
  const up = orientation.up;
  let minR = Infinity,
    maxR = -Infinity,
    minU = Infinity,
    maxU = -Infinity;
  /** Grow the bounds by a sphere of `radius` at (x, y, z). */
  const track = (x: number, y: number, z: number, radius: number) => {
    minX = Math.min(minX, x - radius);
    minY = Math.min(minY, y - radius);
    minZ = Math.min(minZ, z - radius);
    maxX = Math.max(maxX, x + radius);
    maxY = Math.max(maxY, y + radius);
    maxZ = Math.max(maxZ, z + radius);
    const r = x * right[0] + y * right[1] + z * right[2];
    const u = x * up[0] + y * up[1] + z * up[2];
    minR = Math.min(minR, r - radius);
    maxR = Math.max(maxR, r + radius);
    minU = Math.min(minU, u - radius);
    maxU = Math.max(maxU, u + radius);
  };

  const hasBox = snapshot.box && snapshot.box.some((v) => v !== 0);

  if (hasBox) {
    const box = snapshot.box!;
    // The cell is anchored at its world-space origin (lower corner). Include it
    // so the camera frames the cell where the (absolute) atoms actually are,
    // not at world zero. Null/short origin ⇒ (0,0,0), unchanged behavior.
    const origin =
      snapshot.boxOrigin && snapshot.boxOrigin.length === 3 ? snapshot.boxOrigin : null;
    const ox = origin ? origin[0] : 0;
    const oy = origin ? origin[1] : 0;
    const oz = origin ? origin[2] : 0;
    cx = ox + (box[0] + box[3] + box[6]) / 2;
    cy = oy + (box[1] + box[4] + box[7]) / 2;
    cz = oz + (box[2] + box[5] + box[8]) / 2;

    const va = [box[0], box[1], box[2]];
    const vb = [box[3], box[4], box[5]];
    const vc = [box[6], box[7], box[8]];
    for (let ia = 0; ia <= 1; ia++) {
      for (let ib = 0; ib <= 1; ib++) {
        for (let ic = 0; ic <= 1; ic++) {
          track(
            ox + ia * va[0] + ib * vb[0] + ic * vc[0],
            oy + ia * va[1] + ib * vb[1] + ic * vc[1],
            oz + ia * va[2] + ib * vb[2] + ic * vc[2],
            0,
          );
        }
      }
    }
  } else {
    cx = nAtoms > 0 ? sumX / nAtoms : 0;
    cy = nAtoms > 0 ? sumY / nAtoms : 0;
    cz = nAtoms > 0 ? sumZ / nAtoms : 0;

    const { elements } = snapshot;
    for (let i = 0; i < nAtoms; i++) {
      track(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], getRadius(elements[i]));
    }
  }

  const maxExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

  return {
    center: [cx, cy, cz],
    extent: { maxExtent, extentX: maxR - minR, extentY: maxU - minU },
  };
}

/**
 * Fit the camera to show all atoms (or simulation cell if present).
 *
 * Restores `orientation` — by default the structure's standard orientation
 * (VESTA's "Standard orientation of crystal shape", see `cameraOrientation.ts`).
 * The trackball controls rotate `camera.up` freely, so without resetting it a
 * re-fit after a few drags would keep the current roll.
 */
export function fitCameraToView(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  controls: CameraControlsLike,
  snapshot: Snapshot,
  orientation: CameraOrientation = standardOrientation(snapshot.box),
): ViewExtent {
  const { center, extent } = computeViewBounds(snapshot, orientation);
  const [cx, cy, cz] = center;

  controls.target.set(cx, cy, cz);

  const distance = Math.max(extent.maxExtent * 1.2, 0.1);
  const [ex, ey, ez] = orientation.eye;
  camera.position.set(cx + ex * distance, cy + ey * distance, cz + ez * distance);
  camera.up.set(...orientation.up);

  if (camera instanceof THREE.OrthographicCamera) {
    camera.near = -distance * 10;
    camera.far = distance * 10;
    camera.zoom = 1;
  } else {
    camera.near = distance * 0.01;
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
  }
  controls.update();

  return extent;
}

/**
 * Turn the camera to `orientation` around the current target, keeping its
 * distance (perspective) and zoom (orthographic) so only the viewing
 * direction changes — the "align with axis" operation, as opposed to the
 * full re-fit of {@link fitCameraToView}.
 *
 * A camera sitting exactly on its target has no distance to keep; it is
 * backed off by 1 unit so the orientation is still applied.
 */
export function orientCamera(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  controls: CameraControlsLike,
  orientation: CameraOrientation,
): void {
  const target = controls.target;
  const distance = camera.position.distanceTo(target) || 1;
  const [ex, ey, ez] = orientation.eye;
  camera.position.set(target.x + ex * distance, target.y + ey * distance, target.z + ez * distance);
  camera.up.set(...orientation.up);
  controls.update();
}

/** The orientation a camera currently has relative to its controls target. */
export function currentOrientation(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  controls: Pick<CameraControlsLike, "target">,
): CameraOrientation | null {
  return orientationFromPose(
    camera.position.toArray(),
    controls.target.toArray(),
    camera.up.toArray(),
  );
}

/**
 * Keep a perspective camera's near/far planes tracking the current dolly
 * distance so the model's bounding sphere always stays inside the frustum.
 *
 * Perspective wheel zoom dollies the camera (changing its distance to the
 * target) but never touches near/far.
 * Without this, zooming out past the initial `far` (set once in
 * fitCameraToView) pushes the whole model behind the far plane and nothing is
 * drawn until "Reset view" re-fits. Recomputing per frame fixes that.
 *
 * No-op for orthographic cameras (their fixed slab never clips on zoom).
 * Returns true if near/far changed (and the projection matrix was updated).
 */
export function updatePerspectiveClipping(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  controls: Pick<CameraControlsLike, "target">,
  extent: ViewExtent,
): boolean {
  if (!(camera instanceof THREE.PerspectiveCamera)) return false;

  const distance = camera.position.distanceTo(controls.target);
  // Bounding-sphere radius from the model extent, padded for rotation so a
  // corner atom (space diagonal) never leaves the frustum.
  const radius = Math.max(extent.maxExtent, 0.1) * 0.72;
  const margin = radius * 0.5 + 0.1;

  const far = distance + radius + margin;
  // Keep near strictly positive and bounded away from zero for z-buffer
  // precision: floor at far*1e-4 (caps the far/near ratio at 1e4) and an
  // absolute 0.01 for the degenerate small/very-close case.
  const near = Math.max(distance - radius - margin, far * 1e-4, 0.01);

  if (camera.near === near && camera.far === far) return false;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
  return true;
}

/**
 * Convert a wheel event into a multiplicative zoom factor (> 1 zooms in).
 *
 * Normalises `deltaY` across `deltaMode` (pixel / line / page) and applies
 * the same exponential ramp OrbitControls used (`0.95^(zoomSpeed * |delta| / 100)`)
 * so wheel zoom feels identical in both projection modes and is exactly
 * reversible: N ticks in followed by N ticks out return to the start.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, zoomSpeed: number): number {
  let delta = deltaY;
  if (deltaMode === 1 /* DOM_DELTA_LINE */) delta *= 40;
  else if (deltaMode === 2 /* DOM_DELTA_PAGE */) delta *= 800;
  const scale = Math.pow(0.95, zoomSpeed * Math.abs(delta) * 0.01);
  return delta < 0 ? 1 / scale : scale;
}

/**
 * Dolly a perspective camera along its view axis so its distance to `target`
 * is divided by `zoomFactor` (> 1 moves closer). The distance is floored at
 * `minDistance` so the camera can never pass through the pivot, which would
 * flip the view.
 */
export function dollyPerspectiveTowardTarget(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  zoomFactor: number,
  minDistance = 0.01,
): void {
  const eye = camera.position.clone().sub(target);
  const distance = Math.max(eye.length() / zoomFactor, minDistance);
  if (eye.lengthSq() === 0) return;
  camera.position.copy(target).addScaledVector(eye.normalize(), distance);
}

/**
 * Zoom an orthographic camera by `zoomFactor` while keeping `target`'s screen
 * position fixed, mutating the camera in place. Returns the frustum shift (in
 * world units) applied to keep the target anchored, so the caller can
 * accumulate it into its pan bookkeeping.
 *
 * `project()` returns zoom-scaled NDC, so an NDC delta maps to a world-space
 * frustum shift via the *visible* half-extent (right-left)/(2*zoom) — not
 * (right-left)/2. Omitting the /zoom over-shifts at high zoom and accumulates
 * irreversibly, stranding the model off-screen when zooming back out (only
 * "Reset view" recovered it). With the /zoom factor the target's NDC is
 * preserved across the call, making zoom fully reversible.
 */
export function zoomOrthographicAroundTarget(
  camera: THREE.OrthographicCamera,
  target: THREE.Vector3,
  zoomFactor: number,
): { shiftX: number; shiftY: number } {
  const ndcBefore = target.clone().project(camera);

  camera.zoom = Math.max(0.01, camera.zoom * zoomFactor);
  camera.updateProjectionMatrix();

  const ndcAfter = target.clone().project(camera);
  const zoom = camera.zoom;
  const shiftX = ((ndcAfter.x - ndcBefore.x) * (camera.right - camera.left)) / (2 * zoom);
  const shiftY = ((ndcAfter.y - ndcBefore.y) * (camera.top - camera.bottom)) / (2 * zoom);
  if (Math.abs(shiftX) > 1e-9 || Math.abs(shiftY) > 1e-9) {
    camera.left += shiftX;
    camera.right += shiftX;
    camera.top += shiftY;
    camera.bottom += shiftY;
    camera.updateProjectionMatrix();
  }
  return { shiftX, shiftY };
}

/**
 * Recalculate the orthographic frustum so the model fits within the
 * visible area (accounting for overlay insets) and appears centered.
 */
export function applyFrustumInsets(
  camera: THREE.OrthographicCamera,
  containerWidth: number,
  containerHeight: number,
  insetLeft: number,
  insetRight: number,
  extent: ViewExtent,
): void {
  if (containerWidth === 0 || containerHeight === 0) return;

  const minVisible = Math.max(containerWidth * 0.3, 100);
  const effectiveWidth = Math.max(containerWidth - insetLeft - insetRight, minVisible);
  const effectiveAspect = effectiveWidth / containerHeight;

  const padding = 1.2;
  const halfH = Math.max(extent.extentY / 2, extent.extentX / (2 * effectiveAspect)) * padding;
  const frustumHeight = Math.max(halfH * 2, 0.1);

  const fullAspect = containerWidth / containerHeight;
  const halfW = (frustumHeight * fullAspect) / 2;

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = frustumHeight / 2;
  camera.bottom = -frustumHeight / 2;

  const frustumWidth = 2 * halfW;
  const shift = ((insetLeft - insetRight) / (2 * containerWidth)) * frustumWidth;
  camera.left -= shift;
  camera.right -= shift;

  camera.updateProjectionMatrix();
}

/**
 * Create a new camera for switching between orthographic and perspective projection.
 * Returns the new camera with position/up preserved from the old one.
 * Caller is responsible for recreating the camera controls.
 */
export function createSwitchedCamera(
  currentCamera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  enabled: boolean,
  containerWidth: number,
  containerHeight: number,
): THREE.OrthographicCamera | THREE.PerspectiveCamera {
  const pos = currentCamera.position.clone();
  const up = currentCamera.up.clone();
  const aspect = containerWidth / containerHeight;

  let newCamera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  if (enabled) {
    newCamera = new THREE.PerspectiveCamera(50, aspect, 0.1, 10000);
  } else {
    const frustumSize = 50;
    newCamera = new THREE.OrthographicCamera(
      (-frustumSize * aspect) / 2,
      (frustumSize * aspect) / 2,
      frustumSize / 2,
      -frustumSize / 2,
      0.1,
      10000,
    );
  }

  newCamera.position.copy(pos);
  newCamera.up.copy(up);

  return newCamera;
}
