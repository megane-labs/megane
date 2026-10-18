import { describe, it, expect, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { CameraControls } from "@/renderer/CameraControls";

/**
 * Controls wiring inside MoleculeRenderer (issue #662, trackball controls):
 *   - createControls() builds CameraControls bound to the WebGL canvas and
 *     hooks start → pivot snap, end → camera-change callback
 *   - the capture-phase wheel handler zooms both projection modes around the
 *     controls target with the shared reversible ramp
 *   - setPerspective() recreates the controls for the new camera
 *
 * mount() needs a real WebGL context, so the tests inject the handful of
 * fields those paths read (container, renderer.domElement, camera, controls).
 */

function makeCanvasStub(): HTMLDivElement {
  const el = document.createElement("div");
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  document.body.appendChild(el);
  return el;
}

function makeContainer(width = 800, height = 600): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
  document.body.appendChild(el);
  return el;
}

function makeRenderer(camera: THREE.OrthographicCamera | THREE.PerspectiveCamera) {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  const canvas = makeCanvasStub();
  const container = makeContainer();
  // As in mount(): the WebGL canvas lives inside the container, so the
  // container's capture-phase wheel handler sees canvas-targeted events.
  container.appendChild(canvas);
  internals.container = container;
  internals.renderer = { domElement: canvas, dispose: vi.fn() };
  internals.camera = camera;
  internals.perspectiveMode = camera instanceof THREE.PerspectiveCamera;
  internals.controls = internals.createControls() as CameraControls;
  internals.controls.screen = { left: 0, top: 0, width: 800, height: 600 };
  return { r, internals, canvas, container, controls: internals.controls as CameraControls };
}

function wheel(el: HTMLElement, deltaY: number, deltaMode = 0): WheelEvent {
  const e = new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

describe("MoleculeRenderer.createControls", () => {
  it("returns trackball CameraControls bound to the canvas", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    const { controls, canvas } = makeRenderer(cam);
    expect(controls).toBeInstanceOf(CameraControls);
    expect(controls.domElement).toBe(canvas);
    expect(controls.object).toBe(cam);
    expect(controls.noPan).toBe(true);
  });

  it("fires the camera-change callback when an interaction ends", () => {
    const { r, canvas } = makeRenderer(new THREE.OrthographicCamera());
    const cb = vi.fn();
    r.setCameraChangeCallback(cb);
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }),
    );
    expect(cb).not.toHaveBeenCalled();
    document.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 10, clientY: 10, bubbles: true }),
    );
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("snaps a running pivot animation to its end pose when a drag starts", () => {
    const cam = new THREE.OrthographicCamera();
    const { internals, canvas, controls } = makeRenderer(cam);
    internals.pivotAnim = {
      startTarget: new THREE.Vector3(0, 0, 0),
      endTarget: new THREE.Vector3(5, 6, 7),
      startCameraPos: new THREE.Vector3(0, -10, 0),
      endCameraPos: new THREE.Vector3(5, -4, 7),
      startTime: 0,
      duration: 400,
    };
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }),
    );
    expect(internals.pivotAnim).toBeNull();
    expect(controls.target.toArray()).toEqual([5, 6, 7]);
    expect(cam.position.toArray()).toEqual([5, -4, 7]);
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
  });
});

describe("MoleculeRenderer wheel zoom", () => {
  let cam: THREE.OrthographicCamera;
  let setup: ReturnType<typeof makeRenderer>;

  beforeEach(() => {
    cam = new THREE.OrthographicCamera(-25, 25, 25, -25, -100, 100);
    cam.position.set(0, -50, 0);
    setup = makeRenderer(cam);
    setup.internals.attachWheelZoomListener();
  });

  it("intercepts the event so the controls never see it", () => {
    const e = wheel(setup.container, -100);
    expect(e.defaultPrevented).toBe(true);
    const onControls = vi.fn();
    setup.canvas.addEventListener("wheel", onControls);
    wheel(setup.canvas, -100);
    // Capture-phase handler on the container stops propagation before the
    // canvas listeners (where TrackballControls listens) run.
    expect(onControls).not.toHaveBeenCalled();
  });

  it("zooms an orthographic camera in on wheel-up and back out on wheel-down", () => {
    wheel(setup.container, -120);
    expect(cam.zoom).toBeGreaterThan(1);
    wheel(setup.container, 120);
    expect(cam.zoom).toBeCloseTo(1, 9);
  });

  it("keeps the orthographic target anchored and books the frustum shift", () => {
    setup.controls.target.set(8, 0, 3);
    setup.controls.syncImmediate();
    cam.updateMatrixWorld(true);
    const before = setup.controls.target.clone().project(cam);
    wheel(setup.container, -300);
    const after = setup.controls.target.clone().project(cam);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(setup.internals._frustumPanX).not.toBe(0);
  });

  it("dollies a perspective camera toward the target", () => {
    const pcam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    pcam.position.set(0, -40, 0);
    const p = makeRenderer(pcam);
    p.internals.attachWheelZoomListener();
    wheel(p.container, -100);
    const d1 = pcam.position.distanceTo(p.controls.target);
    expect(d1).toBeLessThan(40);
    expect(pcam.position.x).toBeCloseTo(0, 9);
    expect(pcam.position.z).toBeCloseTo(0, 9);
    wheel(p.container, 100);
    expect(pcam.position.distanceTo(p.controls.target)).toBeCloseTo(40, 6);
    // Projection zoom is untouched in perspective mode.
    expect(pcam.zoom).toBe(1);
  });

  it("notifies the camera-change callback on every wheel tick", () => {
    const cb = vi.fn();
    setup.r.setCameraChangeCallback(cb);
    wheel(setup.container, -100);
    wheel(setup.container, 100);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("handles line-mode deltas", () => {
    wheel(setup.container, -3, 1);
    expect(cam.zoom).toBeGreaterThan(1);
  });

  it("re-attaching replaces the previous handler instead of stacking", () => {
    setup.internals.attachWheelZoomListener();
    wheel(setup.container, -120);
    const once = cam.zoom;
    // A stacked duplicate handler would have applied the zoom twice.
    cam.zoom = 1;
    setup.internals.attachWheelZoomListener();
    wheel(setup.container, -120);
    expect(cam.zoom).toBeCloseTo(once, 9);
  });
});

describe("MoleculeRenderer.setPerspective controls recreation", () => {
  it("swaps the camera and rebuilds the controls with the target preserved", () => {
    const cam = new THREE.OrthographicCamera(-25, 25, 25, -25, -100, 100);
    cam.position.set(0, -50, 0);
    const { r, internals, canvas } = makeRenderer(cam);
    const oldControls = internals.controls as CameraControls;
    oldControls.target.set(1, 2, 3);
    const disposeSpy = vi.spyOn(oldControls, "dispose");

    r.setPerspective(true);

    expect(disposeSpy).toHaveBeenCalled();
    expect(internals.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(internals.controls).not.toBe(oldControls);
    expect(internals.controls).toBeInstanceOf(CameraControls);
    expect(internals.controls.object).toBe(internals.camera);
    expect(internals.controls.domElement).toBe(canvas);
    expect(internals.controls.target.toArray()).toEqual([1, 2, 3]);
    expect(r.getCameraState()?.mode).toBe("perspective");
  });

  it("is a no-op when the mode does not change", () => {
    const { r, internals } = makeRenderer(new THREE.OrthographicCamera());
    const controls = internals.controls;
    r.setPerspective(false);
    expect(internals.controls).toBe(controls);
  });
});

describe("MoleculeRenderer.dispose after a failed mount", () => {
  it("does not throw when mount() never created the WebGL renderer or controls", () => {
    const r = new MoleculeRenderer();
    expect(() => r.dispose()).not.toThrow();
  });

  it("does not throw when mount() threw after the canvas but before the controls", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    const container = makeContainer();
    const canvas = document.createElement("canvas");
    container.appendChild(canvas);
    const dispose = vi.fn();
    internals.container = container;
    internals.renderer = { domElement: canvas, dispose };
    expect(() => r.dispose()).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(canvas.parentNode).toBeNull();
  });
});

describe("MoleculeRenderer turntable up axis", () => {
  it("builds the controls with +c of the loaded cell as the up axis", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals.renderer = { domElement: makeCanvasStub(), dispose: vi.fn() };
    internals.camera = new THREE.OrthographicCamera();
    // c along +x (a, b span y/z): the turntable must keep x upright.
    internals.snapshot = { box: new Float32Array([0, 5, 0, 0, 0, 5, 5, 0, 0]) };
    const controls = internals.createControls() as CameraControls;
    expect(controls.upAxis.x).toBeCloseTo(1, 9);
    expect(controls.upAxis.y).toBeCloseTo(0, 9);
    expect(controls.upAxis.z).toBeCloseTo(0, 9);
  });

  it("falls back to +z without a snapshot", () => {
    const { controls } = makeRenderer(new THREE.OrthographicCamera());
    expect(controls.upAxis.toArray()).toEqual([0, 0, 1]);
  });
});

describe("MoleculeRenderer.setRotationCenter (OVITO-style orbit center)", () => {
  /** A few world points spread around the scene, to check the image. */
  const probes = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(6, -3, 2),
    new THREE.Vector3(-4, 5, -7),
  ];
  const screenOf = (cam: THREE.Camera) => {
    cam.updateMatrixWorld(true);
    return probes.map((p) => p.clone().project(cam));
  };

  function orthoSetup() {
    const cam = new THREE.OrthographicCamera(-25, 25, 25, -25, -100, 100);
    cam.position.set(3, -50, 8);
    cam.up.set(0, 0, 1);
    const setup = makeRenderer(cam);
    setup.controls.target.set(3, 0, 8);
    setup.controls.syncImmediate();
    return { cam, ...setup };
  }

  it("orthographic: moves the pivot without moving the image", () => {
    const { cam, r, controls, internals } = orthoSetup();
    // Rotate off-axis first so the camera frame is not world-aligned.
    controls.upAxis.set(0, 0, 1);
    cam.position.set(30, -30, 20);
    controls.syncImmediate();
    const before = screenOf(cam);

    r.setRotationCenter(6, -3, 2);

    expect(controls.target.toArray()).toEqual([6, -3, 2]);
    const after = screenOf(cam);
    for (let i = 0; i < probes.length; i++) {
      expect(after[i].x).toBeCloseTo(before[i].x, 6);
      expect(after[i].y).toBeCloseTo(before[i].y, 6);
    }
    // The shift is booked as frustum pan so resize re-applies it.
    expect(internals._frustumPanX).not.toBe(0);
    expect(internals.pivotAnim).toBeNull();
  });

  it("orthographic: the scene then orbits around the new pivot on screen", () => {
    const { cam, r, controls, canvas } = orthoSetup();
    r.setRotationCenter(6, -3, 2);
    const pivotBefore = screenOf(cam)[1];
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { clientX: 400, clientY: 300, bubbles: true }),
    );
    document.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 470, clientY: 260, bubbles: true }),
    );
    controls.update();
    document.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 470, clientY: 260, bubbles: true }),
    );
    const pivotAfter = screenOf(cam)[1];
    expect(pivotAfter.x).toBeCloseTo(pivotBefore.x, 6);
    expect(pivotAfter.y).toBeCloseTo(pivotBefore.y, 6);
    // ...while everything else moved.
    expect(screenOf(cam)[2].distanceTo(pivotAfter)).toBeGreaterThan(0);
  });

  it("perspective: animates the pivot to the screen center by default", () => {
    const pcam = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000);
    pcam.position.set(0, -40, 0);
    const { r, internals, controls } = makeRenderer(pcam);
    r.setRotationCenter(5, 0, 2);
    expect(internals.pivotAnim).not.toBeNull();
    expect(internals.pivotAnim.endTarget.toArray()).toEqual([5, 0, 2]);
    expect(internals.pivotAnim.endCameraPos.toArray()).toEqual([5, -40, 2]);
    // A second pick first snaps the running animation to its end.
    r.setRotationCenter(1, 1, 1);
    expect(controls.target.toArray()).toEqual([5, 0, 2]);
    expect(internals.pivotAnim.startTarget.toArray()).toEqual([5, 0, 2]);
  });

  it("perspective: animate=false re-centres on the spot", () => {
    const pcam = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000);
    pcam.position.set(0, -40, 0);
    const { r, internals, controls } = makeRenderer(pcam);
    r.setRotationCenter(5, 0, 2, false);
    expect(internals.pivotAnim).toBeNull();
    expect(controls.target.toArray()).toEqual([5, 0, 2]);
    expect(pcam.position.toArray()).toEqual([5, -40, 2]);
  });

  it("resetRotationCenter returns to the model center, keeping the image", () => {
    const { cam, r, controls, internals } = orthoSetup();
    internals.snapshot = {
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 2, 4, 6]),
      elements: new Uint8Array([6, 6]),
      box: null,
    };
    // Trajectory frame: the current positions, not the loaded ones, count.
    internals.currentPositions = new Float32Array([10, 0, 0, 12, 4, 6]);
    r.setRotationCenter(6, -3, 2);
    const before = screenOf(cam);
    r.resetRotationCenter();
    expect(controls.target.x).toBeCloseTo(11, 6);
    expect(controls.target.y).toBeCloseTo(2, 6);
    expect(controls.target.z).toBeCloseTo(3, 6);
    const after = screenOf(cam);
    expect(after[2].x).toBeCloseTo(before[2].x, 6);
    expect(after[2].y).toBeCloseTo(before[2].y, 6);
  });

  it("resetRotationCenter is a no-op before a snapshot is loaded", () => {
    const { r, controls } = orthoSetup();
    r.resetRotationCenter();
    expect(controls.target.toArray()).toEqual([3, 0, 8]);
  });
});

describe("MoleculeRenderer Shift+left-drag pan", () => {
  function setupPan() {
    const cam = new THREE.OrthographicCamera(-25, 25, 25, -25, -100, 100);
    cam.position.set(0, -50, 0);
    cam.up.set(0, 0, 1);
    const setup = makeRenderer(cam);
    setup.controls.syncImmediate();
    setup.internals.attachCustomPanListener();
    return { cam, ...setup };
  }
  const press = (el: HTMLElement, type: string, x: number, y: number, init: MouseEventInit = {}) =>
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...init }));

  it("pans the frustum without rotating the camera", () => {
    const { cam, canvas, controls, internals } = setupPan();
    const pos = cam.position.clone();
    press(canvas, "pointerdown", 400, 300, { button: 0, shiftKey: true });
    press(canvas, "pointermove", 480, 300);
    press(document.body, "pointermove", 480, 300);
    controls.update();
    press(canvas, "pointerup", 480, 300);
    // 80 px of 800 px width over a 50-unit frustum = 5 units to the left.
    expect(internals._frustumPanX).toBeCloseTo(-5, 6);
    expect(cam.left).toBeCloseTo(-30, 6);
    expect(cam.position.distanceTo(pos)).toBeLessThan(1e-9);
  });

  it("is suspended while the controls are disabled (box select, Builder drag)", () => {
    const { canvas, r, internals } = setupPan();
    r.setControlsEnabled(false);
    press(canvas, "pointerdown", 400, 300, { button: 0, shiftKey: true });
    press(canvas, "pointermove", 480, 300);
    press(canvas, "pointerup", 480, 300);
    expect(internals._frustumPanX).toBe(0);
  });

  it("yields to a Builder atom drag that disables the controls mid-press", () => {
    const { canvas, r, internals } = setupPan();
    press(canvas, "pointerdown", 400, 300, { button: 0, shiftKey: true });
    r.setControlsEnabled(false);
    press(canvas, "pointermove", 480, 300);
    press(canvas, "pointerup", 480, 300);
    expect(internals._frustumPanX).toBe(0);
  });

  it("plain left drag does not pan", () => {
    const { canvas, internals } = setupPan();
    press(canvas, "pointerdown", 400, 300, { button: 0 });
    press(canvas, "pointermove", 480, 300);
    press(canvas, "pointerup", 480, 300);
    expect(internals._frustumPanX).toBe(0);
  });

  it("right drag still pans", () => {
    const { canvas, internals } = setupPan();
    press(canvas, "pointerdown", 400, 300, { button: 2 });
    press(canvas, "pointermove", 480, 300);
    press(canvas, "pointerup", 480, 300);
    expect(internals._frustumPanX).toBeCloseTo(-5, 6);
  });
});

describe("MoleculeRenderer.resetView after an off-centre pivot", () => {
  it("drops the frustum shift so the fitted model is centred again", () => {
    const cam = new THREE.OrthographicCamera(-25, 25, 25, -25, -100, 100);
    cam.position.set(0, -50, 0);
    const { r, internals } = makeRenderer(cam);
    internals.snapshot = {
      nAtoms: 2,
      positions: new Float32Array([-3, 0, 0, 3, 0, 0]),
      elements: new Uint8Array([6, 6]),
      box: null,
    };
    r.setRotationCenter(3, 0, 0);
    expect(internals._frustumPanX).not.toBe(0);
    r.resetView();
    expect(internals._frustumPanX).toBe(0);
    expect(internals._frustumPanY).toBe(0);
    expect(cam.left + cam.right).toBeCloseTo(0, 6);
  });
});
