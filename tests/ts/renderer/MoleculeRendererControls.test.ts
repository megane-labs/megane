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
