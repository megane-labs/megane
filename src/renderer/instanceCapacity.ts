/**
 * Sizing and upload helpers shared by the instanced impostor meshes.
 *
 * The meshes used to preallocate buffers for 1M atoms / 3M bonds whatever the
 * structure size, which cost ~220 MB of CPU arrays and ~190 MB of GPU buffers
 * per structure layer even for a 20-atom molecule, and made every attribute
 * update re-upload the whole buffer. Instead, buffers now track the data: they
 * start small, grow with headroom, shrink when a much smaller structure is
 * loaded, and uploads cover only the instances actually drawn.
 */

import type * as THREE from "three";

/** Smallest capacity a mesh is sized to; also the default initial capacity. */
export const MIN_INSTANCE_CAPACITY = 1024;

/**
 * Headroom added when (re)allocating, so a count that fluctuates a little
 * between frames (distance-inferred bonds, heterogeneous trajectories) does
 * not reallocate on every frame.
 */
const GROW_HEADROOM = 1.25;

/**
 * Shrink once the buffers are this many times larger than needed. The gap
 * between this and GROW_HEADROOM is the hysteresis that stops a count hovering
 * around a boundary from reallocating back and forth.
 */
const SHRINK_FACTOR = 4;

/**
 * The capacity to reallocate to so that `needed` instances fit, or `null`
 * when the current capacity should be kept.
 */
export function nextInstanceCapacity(
  current: number,
  needed: number,
  min: number = MIN_INSTANCE_CAPACITY,
): number | null {
  const sized = Math.max(min, Math.ceil(needed * GROW_HEADROOM));
  if (needed > current) return sized;
  if (current > min && needed * SHRINK_FACTOR < current) return sized;
  return null;
}

/**
 * Copy `src` into a new typed array of `length` elements (truncating when
 * shrinking). Elements past the copied range are set to `fill`.
 */
export function resizeTypedArray<T extends Float32Array | Uint8Array>(
  src: T,
  length: number,
  fill = 0,
): T {
  const out = new (src.constructor as { new (n: number): T })(length);
  if (fill !== 0) out.fill(fill);
  out.set(src.subarray(0, Math.min(src.length, length)));
  return out;
}

/**
 * Flag `attr` for re-upload of its first `count` instances only. Without an
 * update range Three.js re-uploads the entire buffer. A zero count needs no
 * upload at all, since nothing past it is drawn.
 */
export function markInstancesDirty(attr: THREE.BufferAttribute, count: number): void {
  if (count <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

/**
 * Forget the instance limit Three.js cached for `geo`. It is taken from the
 * attribute sizes the first time the geometry is bound and never refreshed,
 * so after the instance attributes are swapped for larger ones the mesh would
 * keep drawing at most the old capacity. Disposing the geometry also frees its
 * GPU-side buffers; the CPU-side data is re-uploaded on the next render.
 */
export function resetInstanceLimit(geo: THREE.InstancedBufferGeometry): void {
  geo.dispose();
  delete (geo as THREE.InstancedBufferGeometry & { _maxInstanceCount?: number })._maxInstanceCount;
}
