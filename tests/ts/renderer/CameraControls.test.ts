import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import {
  CameraControls,
  TRACKBALL_ROTATE_SPEED,
  TRACKBALL_ZOOM_SPEED,
} from "@/renderer/CameraControls";

/**
 * Trackball camera controls (issue #662).
 *
 * The controls are driven with real pointer events on a jsdom element so the
 * rotation math is exercised end-to-end. jsdom has no PointerEvent or
 * pointer-capture support, so plain MouseEvents are dispatched under the
 * pointer event names and capture is stubbed on the element.
 */

const SCREEN = { left: 0, top: 0, width: 800, height: 600 };

function makeElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  document.body.appendChild(el);
  return el;
}

function makeCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-25, 25, 25, -25, 0.1, 1000);
  cam.position.set(0, -50, 0);
  cam.up.set(0, 0, 1);
  return cam;
}

function pointer(type: string, x: number, y: number, button = 0): MouseEvent {
  return new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true });
}

/**
 * Drag from (x0, y0) to (x1, y1) in `steps`, calling `controls.update()` after
 * every move so each segment is applied (the trackball consumes the pending
 * move on update).
 */
function drag(
  controls: CameraControls,
  el: HTMLElement,
  from: [number, number],
  to: [number, number],
  steps = 20,
): void {
  el.dispatchEvent(pointer("pointerdown", from[0], from[1]));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    document.dispatchEvent(pointer("pointermove", x, y));
    controls.update();
  }
  document.dispatchEvent(pointer("pointerup", to[0], to[1]));
}

describe("CameraControls defaults", () => {
  let el: HTMLDivElement;
  beforeEach(() => {
    el = makeElement();
  });

  it("applies the viewer's trackball tuning", () => {
    const controls = new CameraControls(makeCamera(), el);
    expect(controls.rotateSpeed).toBe(TRACKBALL_ROTATE_SPEED);
    expect(controls.zoomSpeed).toBe(TRACKBALL_ZOOM_SPEED);
    // Static motion: no inertial glide after release.
    expect(controls.staticMoving).toBe(true);
    controls.dispose();
  });

  it("disables built-in pan (right-drag pan lives in MoleculeRenderer)", () => {
    const controls = new CameraControls(makeCamera(), el);
    expect(controls.noPan).toBe(true);
    controls.dispose();
  });

  it("unbinds the A/S/D modifier keys so typing never latches a mode", () => {
    const controls = new CameraControls(makeCamera(), el);
    expect(controls.keys.every((k) => k === "")).toBe(true);
    // Pressing the stock TrackballControls keys must leave keyState untouched.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
    expect((controls as unknown as { keyState: number }).keyState).toBe(-1);
    controls.dispose();
  });

  it("can be constructed without a DOM element (headless / capture paths)", () => {
    const controls = new CameraControls(makeCamera());
    expect(controls.noPan).toBe(true);
    expect(controls.target.toArray()).toEqual([0, 0, 0]);
  });
});

describe("CameraControls rotation", () => {
  let el: HTMLDivElement;
  let camera: THREE.OrthographicCamera;
  let controls: CameraControls;

  beforeEach(() => {
    el = makeElement();
    camera = makeCamera();
    controls = new CameraControls(camera, el);
    // jsdom reports a zero-size rect; give the trackball a real screen.
    controls.screen = { ...SCREEN };
  });

  it("dispatches start/end around a drag", () => {
    const start = vi.fn();
    const end = vi.fn();
    controls.addEventListener("start", start);
    controls.addEventListener("end", end);
    drag(controls, el, [400, 300], [400, 250], 5);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("rotates continuously across the pole instead of clamping there", () => {
    // Camera starts below the target on -y, looking along +y with z up.
    // A vertical drag tilts the view over the ±z pole. OrbitControls clamps
    // the polar angle so camera.position.y could never become positive; a
    // trackball keeps going and comes out on the far side.
    const target = controls.target.clone();
    const startDistance = camera.position.distanceTo(target);

    // 600 px of vertical travel = 1.5 trackball units × rotateSpeed rad,
    // comfortably more than the 90° needed to reach the pole.
    drag(controls, el, [400, 550], [400, 250], 30);
    drag(controls, el, [400, 550], [400, 250], 30);
    controls.syncImmediate();

    expect(camera.position.y).toBeGreaterThan(0);
    // Distance to the pivot is preserved by a pure rotation.
    expect(camera.position.distanceTo(target)).toBeCloseTo(startDistance, 5);
  });

  it("keeps camera.up unit-length and perpendicular to the view direction", () => {
    drag(controls, el, [200, 500], [600, 100], 25);
    controls.syncImmediate();
    const eye = camera.position.clone().sub(controls.target).normalize();
    expect(camera.up.length()).toBeCloseTo(1, 6);
    expect(Math.abs(camera.up.dot(eye))).toBeLessThan(1e-6);
    // The roll is free: `up` is no longer pinned to world z.
    expect(camera.up.distanceTo(new THREE.Vector3(0, 0, 1))).toBeGreaterThan(1e-3);
  });

  it("a horizontal drag orbits around the current up axis", () => {
    drag(controls, el, [200, 300], [600, 300], 20);
    controls.syncImmediate();
    // Rotation about world z leaves z untouched and keeps up at +z.
    expect(camera.position.z).toBeCloseTo(0, 6);
    expect(camera.up.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-6);
    expect(camera.position.x).not.toBeCloseTo(0, 3);
  });

  it("accumulates every pointermove between two updates (lossless drag)", () => {
    // Reference: one move per update.
    const perFrame = makeCamera();
    const perFrameControls = new CameraControls(perFrame, makeElement());
    perFrameControls.screen = { ...SCREEN };
    drag(perFrameControls, perFrameControls.domElement as HTMLElement, [400, 500], [400, 200], 30);

    // Same travel, but all 30 moves land before a single update — as when
    // a high-rate mouse outruns the render loop.
    el.dispatchEvent(pointer("pointerdown", 400, 500));
    for (let i = 1; i <= 30; i++) {
      document.dispatchEvent(pointer("pointermove", 400, 500 - 10 * i));
    }
    controls.update();
    document.dispatchEvent(pointer("pointerup", 400, 200));

    // Stock TrackballControls would only rotate by the last 10 px segment.
    expect(camera.position.distanceTo(perFrame.position)).toBeLessThan(1e-6);
    expect(camera.position.y).not.toBeCloseTo(-50, 1);
    perFrameControls.dispose();
  });

  it("stops exactly where the pointer stops (no glide after release)", () => {
    drag(controls, el, [400, 500], [400, 300], 10);
    const afterRelease = camera.position.clone();
    for (let i = 0; i < 5; i++) controls.update();
    expect(camera.position.distanceTo(afterRelease)).toBeLessThan(1e-9);
  });

  it("does not rotate while disabled", () => {
    controls.enabled = false;
    const before = camera.position.clone();
    drag(controls, el, [400, 500], [400, 100], 10);
    controls.update();
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-9);
  });
});

describe("CameraControls.syncImmediate", () => {
  let el: HTMLDivElement;
  let camera: THREE.OrthographicCamera;
  let controls: CameraControls;

  beforeEach(() => {
    el = makeElement();
    camera = makeCamera();
    controls = new CameraControls(camera, el);
    controls.screen = { ...SCREEN };
  });

  it("with damping enabled, momentum keeps turning the camera after release", () => {
    controls.staticMoving = false;
    drag(controls, el, [400, 500], [400, 300], 10);
    const afterRelease = camera.position.clone();
    controls.update();
    expect(camera.position.distanceTo(afterRelease)).toBeGreaterThan(1e-6);
  });

  it("drops that momentum so subsequent updates hold the pose", () => {
    controls.staticMoving = false;
    drag(controls, el, [400, 500], [400, 300], 10);
    controls.syncImmediate();
    const synced = camera.position.clone();
    for (let i = 0; i < 5; i++) controls.update();
    expect(camera.position.distanceTo(synced)).toBeLessThan(1e-9);
    // The flag itself is left as the caller had it.
    expect(controls.staticMoving).toBe(false);
  });

  it("restores the previous staticMoving flag", () => {
    controls.staticMoving = false;
    controls.syncImmediate();
    expect(controls.staticMoving).toBe(false);
    controls.staticMoving = true;
    controls.syncImmediate();
    expect(controls.staticMoving).toBe(true);
  });

  it("applies a programmatic target/position write on the spot", () => {
    controls.target.set(10, 0, 0);
    camera.position.set(10, -30, 0);
    controls.syncImmediate();
    // update() re-derives the eye vector from position - target and calls
    // lookAt, so the camera faces the new target immediately.
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(1, 6);
    expect(camera.position.toArray()).toEqual([10, -30, 0]);
  });
});
