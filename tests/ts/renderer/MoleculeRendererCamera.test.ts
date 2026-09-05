import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer, type MeganeCameraState } from "@/renderer/MoleculeRenderer";

/**
 * Tests for the camera-state persistence API added in PR #392:
 *   - getCameraState()        — read current camera/controls into a snapshot
 *   - applyCameraState()      — restore a previously captured snapshot
 *   - setCameraChangeCallback() — hook user-driven camera changes
 *
 * MoleculeRenderer's full mount() requires a real WebGL context and DOM, which
 * jsdom does not supply. These tests instead instantiate the class without
 * mounting and inject minimal stand-ins for `camera` and `controls`. The new
 * methods only touch those two fields, so this is sufficient to exercise the
 * branches added by the patch.
 */

interface ControlsStub {
  target: THREE.Vector3;
  update: ReturnType<typeof vi.fn>;
  syncImmediate: ReturnType<typeof vi.fn>;
}

function makeControls(): ControlsStub {
  return {
    target: new THREE.Vector3(),
    update: vi.fn(),
    syncImmediate: vi.fn(),
  };
}

/**
 * Build a renderer instance with just enough state for the camera-state API.
 * We bypass mount() (which needs WebGL) by directly assigning the private
 * `camera`/`controls`/`perspectiveMode` fields via a typed cast.
 */
function makeRenderer(opts: {
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  controls: ControlsStub;
  perspectiveMode: boolean;
}): MoleculeRenderer {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  internals.camera = opts.camera;
  internals.controls = opts.controls;
  internals.perspectiveMode = opts.perspectiveMode;
  return r;
}

describe("MoleculeRenderer.getCameraState", () => {
  it("returns null when camera is missing", () => {
    const r = new MoleculeRenderer();
    expect(r.getCameraState()).toBeNull();
  });

  it("returns null when controls are missing", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).camera = new THREE.OrthographicCamera();
    // controls is still undefined
    expect(r.getCameraState()).toBeNull();
  });

  it("captures orthographic camera position, target, zoom, and up", () => {
    const cam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    cam.position.set(1, 2, 3);
    cam.zoom = 2.5;
    cam.up.set(0, 1, 0);
    const ctrls = makeControls();
    ctrls.target.set(4, 5, 6);
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });

    const state = r.getCameraState();
    expect(state).toEqual({
      mode: "orthographic",
      position: [1, 2, 3],
      target: [4, 5, 6],
      zoom: 2.5,
      up: [0, 1, 0],
    });
  });

  it("testGetCameraState mirrors getCameraState (including up)", () => {
    const cam = new THREE.OrthographicCamera();
    cam.up.set(0, 0, -1);
    const r = makeRenderer({ camera: cam, controls: makeControls(), perspectiveMode: false });
    expect(r.testGetCameraState()).toEqual(r.getCameraState());
    expect(r.testGetCameraState()?.up).toEqual([0, 0, -1]);
  });

  it("reports perspective mode when perspectiveMode flag is true", () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, -10, 0);
    cam.zoom = 1;
    const r = makeRenderer({ camera: cam, controls: makeControls(), perspectiveMode: true });
    expect(r.getCameraState()?.mode).toBe("perspective");
  });
});

describe("MoleculeRenderer.applyCameraState", () => {
  it("is a no-op when camera is missing", () => {
    const r = new MoleculeRenderer();
    // Should not throw even though camera/controls are undefined.
    expect(() =>
      r.applyCameraState({
        mode: "orthographic",
        position: [1, 1, 1],
        target: [0, 0, 0],
        zoom: 1,
      }),
    ).not.toThrow();
  });

  it("writes position, target, up, and zoom into camera/controls", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });

    const state: MeganeCameraState = {
      mode: "orthographic",
      position: [9, 8, 7],
      target: [1, 2, 3],
      zoom: 3.25,
      up: [0, 1, 0],
    };
    r.applyCameraState(state);

    expect(cam.position.toArray()).toEqual([9, 8, 7]);
    expect(ctrls.target.toArray()).toEqual([1, 2, 3]);
    expect(cam.up.toArray()).toEqual([0, 1, 0]);
    expect(cam.zoom).toBe(3.25);
  });

  it("syncs the controls immediately so drag momentum cannot drift the restored pose", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });

    r.applyCameraState({
      mode: "orthographic",
      position: [0, 0, 0],
      target: [0, 0, 0],
      zoom: 1,
    });

    expect(ctrls.syncImmediate).toHaveBeenCalledTimes(1);
  });

  it("keeps the current up vector when a legacy state has no `up`", () => {
    const cam = new THREE.OrthographicCamera();
    cam.up.set(0, 0, 1);
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });

    r.applyCameraState({
      mode: "orthographic",
      position: [0, -10, 0],
      target: [0, 0, 0],
      zoom: 1,
    });

    expect(cam.up.toArray()).toEqual([0, 0, 1]);
  });

  it("round-trips through getCameraState → applyCameraState", () => {
    const camA = new THREE.OrthographicCamera();
    camA.position.set(3, -20, 4);
    camA.up.set(0.6, 0, 0.8);
    camA.zoom = 1.75;
    const ctrlsA = makeControls();
    ctrlsA.target.set(3, 1, 4);
    const rA = makeRenderer({ camera: camA, controls: ctrlsA, perspectiveMode: false });
    const saved = rA.getCameraState()!;

    const camB = new THREE.OrthographicCamera();
    const ctrlsB = makeControls();
    const rB = makeRenderer({ camera: camB, controls: ctrlsB, perspectiveMode: false });
    rB.applyCameraState(saved);

    expect(camB.position.toArray()).toEqual(camA.position.toArray());
    expect(camB.up.toArray()).toEqual(camA.up.toArray());
    expect(ctrlsB.target.toArray()).toEqual(ctrlsA.target.toArray());
    expect(camB.zoom).toBe(camA.zoom);
  });

  it("resets accumulated frustum pan offsets", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals._frustumPanX = 12;
    internals._frustumPanY = -7;

    r.applyCameraState({
      mode: "orthographic",
      position: [0, 0, 0],
      target: [0, 0, 0],
      zoom: 1,
    });

    expect(internals._frustumPanX).toBe(0);
    expect(internals._frustumPanY).toBe(0);
  });

  it("calls setPerspective when the requested mode differs from the current mode", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;

    // Without a container set, setPerspective() flips the flag and early-returns
    // before touching renderer/controls — safe to invoke from an unmounted instance.
    r.applyCameraState({
      mode: "perspective",
      position: [0, 0, 0],
      target: [0, 0, 0],
      zoom: 1,
    });

    expect(internals.perspectiveMode).toBe(true);
  });

  it("skips setPerspective when the requested mode matches the current mode", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });
    const setPerspectiveSpy = vi.spyOn(r, "setPerspective");

    r.applyCameraState({
      mode: "orthographic",
      position: [0, 0, 0],
      target: [0, 0, 0],
      zoom: 1,
    });

    expect(setPerspectiveSpy).not.toHaveBeenCalled();
  });
});

describe("MoleculeRenderer.setCameraChangeCallback", () => {
  it("stores the callback so subsequent camera ops can fire it", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });

    const cb = vi.fn();
    r.setCameraChangeCallback(cb);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((r as any)._cameraChangeCallback).toBe(cb);
  });

  it("setCameraMode fires the registered callback", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    // Start in orthographic; setCameraMode("orthographic") must still fire the
    // callback because the patch invokes it unconditionally after setPerspective.
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });
    const cb = vi.fn();
    r.setCameraChangeCallback(cb);

    r.setCameraMode("orthographic");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("clearing the callback prevents future invocations", () => {
    const cam = new THREE.OrthographicCamera();
    const ctrls = makeControls();
    const r = makeRenderer({ camera: cam, controls: ctrls, perspectiveMode: false });
    const cb = vi.fn();
    r.setCameraChangeCallback(cb);
    r.setCameraChangeCallback(null);

    r.setCameraMode("orthographic");
    expect(cb).not.toHaveBeenCalled();
  });
});
