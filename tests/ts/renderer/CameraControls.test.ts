import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import {
  CameraControls,
  ORBIT_SPEED,
  TRACKBALL_ZOOM_SPEED,
  isPanGesture,
  isShiftPanGesture,
} from "@/renderer/CameraControls";

/**
 * Turntable (OVITO orbit-mode) camera controls.
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

function pointer(type: string, x: number, y: number, button = 0, shiftKey = false): MouseEvent {
  return new MouseEvent(type, { clientX: x, clientY: y, button, shiftKey, bubbles: true });
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
  shiftKey = false,
): void {
  el.dispatchEvent(pointer("pointerdown", from[0], from[1], 0, shiftKey));
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

  it("applies the viewer's tuning", () => {
    const controls = new CameraControls(makeCamera(), el);
    expect(controls.zoomSpeed).toBe(TRACKBALL_ZOOM_SPEED);
    expect(controls.upAxis.toArray()).toEqual([0, 0, 1]);
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

  /** Angle (rad) of the camera around the target in the plane ⟂ to z. */
  const azimuth = () => Math.atan2(camera.position.x, -camera.position.y);

  it("rotates ORBIT_SPEED radians per viewport height of travel", () => {
    // 120 px up of 600 px height → 1 rad of tilt. Dragging up rolls the
    // near side of the model upward, so the camera swings below it.
    drag(controls, el, [400, 400], [400, 280], 12);
    const tilt = Math.atan2(-camera.position.z, -camera.position.y);
    expect(tilt).toBeCloseTo((ORBIT_SPEED * 120) / SCREEN.height, 6);
    // Horizontal travel uses the same per-pixel rate.
    const h = makeCamera();
    const hc = new CameraControls(h, makeElement());
    hc.screen = { ...SCREEN };
    drag(hc, hc.domElement as HTMLElement, [400, 300], [460, 300], 6);
    expect(Math.abs(Math.atan2(h.position.x, -h.position.y))).toBeCloseTo(
      (ORBIT_SPEED * 60) / SCREEN.height,
      6,
    );
    hc.dispose();
  });

  it("rotates continuously across the pole instead of clamping there", () => {
    // Camera starts on -y looking along +y with z up. A vertical drag tilts
    // the view over the +z pole; OrbitControls would clamp the polar angle
    // so camera.position.y could never become positive.
    const target = controls.target.clone();
    const startDistance = camera.position.distanceTo(target);

    // 200 px = 5/3 rad ≈ 95°: just past the pole.
    drag(controls, el, [400, 500], [400, 300], 20);
    controls.syncImmediate();

    expect(camera.position.y).toBeGreaterThan(0);
    expect(camera.position.z).toBeLessThan(0);
    // Upside down now: screen-up points away from world +z.
    expect(camera.up.z).toBeLessThan(0);
    // Distance to the pivot is preserved by a pure rotation.
    expect(camera.position.distanceTo(target)).toBeCloseTo(startDistance, 5);
  });

  it("never rolls: screen-up stays in the plane of the up axis and the view", () => {
    // A diagonal scribble rolls a free trackball; a turntable keeps screen
    // right horizontal (⟂ to the up axis) whatever the path.
    drag(controls, el, [200, 500], [600, 100], 25);
    drag(controls, el, [600, 100], [300, 400], 25);
    drag(controls, el, [300, 400], [500, 200], 25);
    controls.syncImmediate();
    const eye = camera.position.clone().sub(controls.target).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, eye);
    expect(Math.abs(right.dot(controls.upAxis))).toBeLessThan(1e-9);
    expect(camera.up.length()).toBeCloseTo(1, 6);
    expect(Math.abs(camera.up.dot(eye))).toBeLessThan(1e-6);
  });

  it("a horizontal drag spins around the up axis", () => {
    drag(controls, el, [300, 300], [360, 300], 20);
    controls.syncImmediate();
    expect(camera.position.z).toBeCloseTo(0, 6);
    expect(camera.up.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-6);
    // Dragging right turns the model right: the camera swings toward -x.
    expect(azimuth()).toBeLessThan(0);
  });

  it("honours a custom up axis", () => {
    camera.position.set(0, 0, 50);
    camera.up.set(0, 1, 0);
    controls.upAxis.set(0, 1, 0);
    controls.update();
    drag(controls, el, [200, 300], [600, 300], 20);
    controls.syncImmediate();
    expect(camera.position.y).toBeCloseTo(0, 6);
    expect(camera.up.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-6);
  });

  it("keeps the horizontal direction under the pointer when upside down", () => {
    // Flip over the pole first (camera.up now points down world z).
    drag(controls, el, [400, 500], [400, 300], 20);
    controls.syncImmediate();
    expect(camera.up.z).toBeLessThan(0);
    // The model must still turn right on a rightward drag, i.e. the camera
    // moves toward screen-left. Measure it in the camera's own frame.
    const eye = camera.position.clone().sub(controls.target);
    const screenLeft = new THREE.Vector3().crossVectors(eye, camera.up).normalize();
    const before = camera.position.clone();
    drag(controls, el, [400, 300], [420, 300], 4);
    controls.syncImmediate();
    expect(camera.position.clone().sub(before).dot(screenLeft)).toBeGreaterThan(0);
  });

  it("latches the horizontal direction for the whole drag across a pole", () => {
    // One drag: over the pole, then sideways. Same travel split into two
    // drags flips the yaw for the second one (it starts upside down).
    drag(controls, el, [400, 500], [400, 300], 20);
    const single = makeCamera();
    const sc = new CameraControls(single, makeElement());
    sc.screen = { ...SCREEN };
    const sel = sc.domElement as HTMLElement;
    sel.dispatchEvent(pointer("pointerdown", 400, 500));
    for (let i = 1; i <= 20; i++) {
      document.dispatchEvent(pointer("pointermove", 400, 500 - 10 * i));
      sc.update();
    }
    for (let i = 1; i <= 4; i++) {
      document.dispatchEvent(pointer("pointermove", 400 + 5 * i, 300));
      sc.update();
    }
    document.dispatchEvent(pointer("pointerup", 420, 300));
    drag(controls, el, [400, 300], [420, 300], 4);
    // Same pole crossing, opposite horizontal turn.
    expect(Math.sign(single.position.x)).toBe(-Math.sign(camera.position.x));
    sc.dispose();
  });

  it("Shift+left drag is left to the renderer's pan and does not rotate", () => {
    const start = vi.fn();
    const end = vi.fn();
    controls.addEventListener("start", start);
    controls.addEventListener("end", end);
    const before = camera.position.clone();
    drag(controls, el, [400, 500], [200, 100], 10, true);
    controls.update();
    expect(camera.position.distanceTo(before)).toBeLessThan(1e-9);
    // start/end still fire so pivot snapping and persistence keep working.
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
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

describe("isShiftPanGesture", () => {
  it("matches only Shift + left button", () => {
    expect(isShiftPanGesture({ button: 0, shiftKey: true })).toBe(true);
    expect(isShiftPanGesture({ button: 0, shiftKey: false })).toBe(false);
    expect(isShiftPanGesture({ button: 2, shiftKey: true })).toBe(false);
    expect(isShiftPanGesture({ button: 1, shiftKey: true })).toBe(false);
  });
});

describe("isPanGesture", () => {
  it("pans with right or Shift + left in the viewer, middle or Shift + right in the Builder", () => {
    expect(isPanGesture("viewer", { button: 2, shiftKey: false })).toBe(true);
    expect(isPanGesture("viewer", { button: 0, shiftKey: true })).toBe(true);
    expect(isPanGesture("viewer", { button: 1, shiftKey: false })).toBe(false);
    expect(isPanGesture("builder", { button: 1, shiftKey: false })).toBe(true);
    expect(isPanGesture("builder", { button: 2, shiftKey: true })).toBe(true);
    expect(isPanGesture("builder", { button: 2, shiftKey: false })).toBe(false);
    expect(isPanGesture("builder", { button: 0, shiftKey: true })).toBe(false);
  });
});

describe("CameraControls mouse scheme", () => {
  it("rotates with a right drag in the Builder's scheme, and leaves Shift + right to the pan", () => {
    const el = makeElement();
    const camera = makeCamera();
    const controls = new CameraControls(camera, el);
    controls.screen = { ...SCREEN };
    controls.setMouseScheme("builder");
    expect(controls.mouseButtons).toEqual({
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: -1,
      RIGHT: THREE.MOUSE.ROTATE,
    });
    const rightDrag = (shiftKey: boolean) => {
      const before = camera.position.clone();
      el.dispatchEvent(pointer("pointerdown", 400, 300, 2, shiftKey));
      document.dispatchEvent(pointer("pointermove", 500, 300, 2, shiftKey));
      controls.update();
      document.dispatchEvent(pointer("pointerup", 500, 300, 2, shiftKey));
      return camera.position.distanceTo(before);
    };
    expect(rightDrag(false)).toBeGreaterThan(1);
    expect(rightDrag(true)).toBeLessThan(1e-9);
    controls.setMouseScheme("viewer");
    expect(controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.PAN);
    controls.dispose();
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

  it("drops any glide so subsequent updates hold the pose", () => {
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
