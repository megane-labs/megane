/**
 * Slow, continuous orbit of a `MoleculeRenderer` camera around its target —
 * the decorative auto-rotation used by the docs landing hero and demo embeds.
 *
 * The viewer's camera controls (`CameraControls`) build on three.js
 * `TrackballControls`, which has no `autoRotate` option (that was an
 * `OrbitControls` feature). Each frame this spins the camera position around
 * the target about the camera's own up vector; the controls re-derive their
 * eye vector from `camera.position − target` on every `update()`, so the
 * externally applied rotation persists and stays interaction-free.
 *
 * Only the renderer's public API is touched (`getCamera`, `getCameraState`),
 * and the vectors are cloned from the camera rather than constructed here so
 * an embedder bundling its own copy of three.js never mixes two versions.
 */

type Vec3Like = {
  x: number;
  y: number;
  z: number;
  clone(): Vec3Like;
  set(x: number, y: number, z: number): Vec3Like;
  copy(v: Vec3Like): Vec3Like;
  add(v: Vec3Like): Vec3Like;
  sub(v: Vec3Like): Vec3Like;
  normalize(): Vec3Like;
  applyAxisAngle(axis: Vec3Like, angle: number): Vec3Like;
};

/** The slice of `MoleculeRenderer` this helper relies on. */
export interface AutoRotateRenderer {
  getCamera(): { position: Vec3Like; up: Vec3Like };
  getCameraState(): { target: [number, number, number] } | null;
}

/**
 * Rotate `renderer`'s camera by `angle` radians around its target about the
 * camera up axis. A no-op before the renderer is mounted (`getCameraState()`
 * returns null) or when there is nothing to rotate.
 */
export function rotateCameraAroundTarget(renderer: AutoRotateRenderer, angle: number): void {
  if (!angle) return;
  const state = renderer.getCameraState();
  if (!state) return;
  const camera = renderer.getCamera();
  const target = camera.position.clone().set(...state.target);
  const offset = camera.position.clone().sub(target);
  const axis = camera.up.clone().normalize();
  offset.applyAxisAngle(axis, angle);
  camera.position.copy(target).add(offset);
}

/**
 * Start orbiting the camera at `degreesPerSecond` (frame-rate independent),
 * driven by `requestAnimationFrame`. Returns a function that stops it.
 */
export function startAutoRotate(
  renderer: AutoRotateRenderer,
  degreesPerSecond: number,
  raf: (cb: (t: number) => void) => number = (cb) => window.requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => window.cancelAnimationFrame(id),
): () => void {
  let handle: number | null = null;
  let last: number | null = null;
  const tick = (now: number) => {
    handle = raf(tick);
    // The first frame only establishes the time base; a frame that arrives
    // after a long pause (hidden tab) is clamped so the model never jumps.
    const dt = last == null ? 0 : Math.min((now - last) / 1000, 0.1);
    last = now;
    rotateCameraAroundTarget(renderer, (degreesPerSecond * dt * Math.PI) / 180);
  };
  handle = raf(tick);
  return () => {
    if (handle != null) caf(handle);
    handle = null;
  };
}
