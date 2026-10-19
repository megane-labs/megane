import { describe, it, expect, vi, afterEach } from "vitest";
import * as THREE from "three";
import { CameraController, type CameraHost } from "@/renderer/CameraController";
import { CameraControls } from "@/renderer/CameraControls";
import type { Snapshot } from "@/types";

/**
 * Direct tests for CameraController (the camera / interaction half split out
 * of MoleculeRenderer). The renderer-level behaviour — wheel zoom, pan, pivot
 * moves, camera-state round trips — is covered through MoleculeRenderer in
 * MoleculeRendererControls / MoleculeRendererCamera; these cover the
 * controller's own entry points: mount, the render-loop tick, resize and
 * capture sizing, reset / extent bookkeeping and teardown.
 */

function makeContainer(width = 800, height = 600): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width });
  Object.defineProperty(el, "clientHeight", { value: height });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function makeCanvas(container: HTMLElement): HTMLDivElement {
  const el = document.createElement("div");
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  container.appendChild(el);
  return el;
}

function makeSnapshot(positions: number[], box: number[] | null = null): Snapshot {
  return {
    nAtoms: positions.length / 3,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(positions),
    elements: new Uint8Array(positions.length / 3).fill(6),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: box ? new Float32Array(box) : null,
    boxOrigin: null,
  } as Snapshot;
}

interface Setup {
  ctl: CameraController;
  container: HTMLDivElement;
  canvas: HTMLDivElement;
  host: { snapshot: Snapshot | null; positions: Float32Array | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  internals: any;
}

function setup(opts: { width?: number; height?: number; mount?: boolean } = {}): Setup {
  const container = makeContainer(opts.width, opts.height);
  const canvas = makeCanvas(container);
  const host = { snapshot: null as Snapshot | null, positions: null as Float32Array | null };
  const cameraHost: CameraHost = {
    getContainer: () => container,
    getCanvas: () => canvas,
    getSnapshot: () => host.snapshot,
    getCurrentPositions: () => host.positions ?? host.snapshot!.positions,
  };
  const ctl = new CameraController(cameraHost);
  if (opts.mount !== false) {
    ctl.mount();
    ctl.controls.screen = { left: 0, top: 0, width: opts.width ?? 800, height: opts.height ?? 600 };
  }
  return { ctl, container, canvas, host, internals: ctl };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("CameraController.mount", () => {
  it("creates an orthographic camera sized to the container aspect, looking along +y", () => {
    const { ctl } = setup({ width: 800, height: 400 });
    expect(ctl.camera).toBeInstanceOf(THREE.OrthographicCamera);
    const cam = ctl.camera as THREE.OrthographicCamera;
    expect(cam.right - cam.left).toBeCloseTo(100, 9);
    expect(cam.top - cam.bottom).toBeCloseTo(50, 9);
    expect(cam.position.toArray()).toEqual([0, -50, 0]);
    expect(cam.up.toArray()).toEqual([0, 0, 1]);
  });

  it("binds turntable controls to the canvas", () => {
    const { ctl, canvas } = setup();
    expect(ctl.controls).toBeInstanceOf(CameraControls);
    expect(ctl.controls.domElement).toBe(canvas);
    expect(ctl.controls.object).toBe(ctl.camera);
  });

  it("starts in orthographic mode", () => {
    const { ctl } = setup();
    expect(ctl.getCameraState()?.mode).toBe("orthographic");
  });
});

describe("CameraController.syncUpAxis", () => {
  it("keeps +c of the cell upright", () => {
    const { ctl } = setup();
    ctl.syncUpAxis(new Float32Array([0, 5, 0, 0, 0, 5, 5, 0, 0]));
    expect(ctl.controls.upAxis.x).toBeCloseTo(1, 9);
  });

  it("falls back to +z without a cell, and is a no-op before mount", () => {
    const { ctl } = setup();
    ctl.syncUpAxis(new Float32Array([0, 5, 0, 0, 0, 5, 5, 0, 0]));
    ctl.syncUpAxis(null);
    expect(ctl.controls.upAxis.toArray()).toEqual([0, 0, 1]);
    const unmounted = setup({ mount: false }).ctl;
    expect(() => unmounted.syncUpAxis(undefined)).not.toThrow();
  });
});

describe("CameraController.tick", () => {
  it("lets the controls apply momentum when no pivot animation runs", () => {
    const { ctl } = setup();
    const update = vi.spyOn(ctl.controls, "update");
    ctl.tick();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("eases a perspective pivot animation to its end pose and then clears it", () => {
    const { ctl, internals } = setup();
    ctl.setPerspective(true);
    ctl.camera.position.set(0, -40, 0);
    ctl.controls.target.set(0, 0, 0);
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    ctl.setRotationCenter(4, 0, 2);
    expect(internals.pivotAnim).not.toBeNull();

    now.mockReturnValue(1000 + CameraController.PIVOT_ANIM_DURATION_MS / 2);
    ctl.tick();
    // ease-out cubic at t = 0.5 → 0.875 of the way.
    expect(ctl.controls.target.x).toBeCloseTo(3.5, 6);
    expect(internals.pivotAnim).not.toBeNull();

    now.mockReturnValue(1000 + CameraController.PIVOT_ANIM_DURATION_MS);
    ctl.tick();
    expect(ctl.controls.target.toArray()).toEqual([4, 0, 2]);
    expect(ctl.camera.position.toArray()).toEqual([4, -40, 2]);
    expect(internals.pivotAnim).toBeNull();
  });

  it("keeps the perspective clipping planes around the model", () => {
    const { ctl, host } = setup();
    host.snapshot = makeSnapshot([0, 0, 0, 10, 0, 0]);
    ctl.setPerspective(true);
    const cam = ctl.camera as THREE.PerspectiveCamera;
    cam.position.set(0, -5000, 0);
    ctl.tick();
    expect(cam.far).toBeGreaterThan(5000);
  });
});

describe("CameraController.resize", () => {
  it("re-fits the orthographic frustum to a new aspect, keeping zoom", () => {
    const { ctl } = setup({ width: 800, height: 400 });
    const cam = ctl.camera as THREE.OrthographicCamera;
    cam.zoom = 2;
    ctl.resize(800, 400);
    expect(cam.zoom).toBe(2);
    expect((cam.right - cam.left) / (cam.top - cam.bottom)).toBeCloseTo(2, 6);
  });

  it("re-applies an accumulated orthographic pan so the view does not jump", () => {
    const { ctl, internals } = setup();
    ctl.resize(800, 600);
    const cam = ctl.camera as THREE.OrthographicCamera;
    const left = cam.left;
    const bottom = cam.bottom;
    internals._frustumPanX = 3;
    internals._frustumPanY = -2;
    ctl.resize(800, 600);
    expect(cam.left).toBeCloseTo(left + 3, 9);
    expect(cam.bottom).toBeCloseTo(bottom - 2, 9);
  });

  it("only updates the aspect of a perspective camera", () => {
    const { ctl } = setup();
    ctl.setPerspective(true);
    ctl.resize(300, 100);
    expect((ctl.camera as THREE.PerspectiveCamera).aspect).toBeCloseTo(3, 9);
  });
});

describe("CameraController.resizeForCapture", () => {
  it("keeps the orthographic vertical frustum and widens to the capture aspect", () => {
    const { ctl } = setup();
    const cam = ctl.camera as THREE.OrthographicCamera;
    const height = cam.top - cam.bottom;
    ctl.resizeForCapture(1000, 250);
    expect(cam.top - cam.bottom).toBeCloseTo(height, 9);
    expect(cam.right).toBeCloseTo((height / 2) * 4, 9);
    expect(cam.left).toBeCloseTo((-height / 2) * 4, 9);
  });

  it("sets the perspective aspect", () => {
    const { ctl } = setup();
    ctl.setPerspective(true);
    ctl.resizeForCapture(500, 250);
    expect((ctl.camera as THREE.PerspectiveCamera).aspect).toBeCloseTo(2, 9);
  });
});

describe("CameraController view fitting", () => {
  it("setViewInsets shifts the orthographic frustum away from an occluded edge", () => {
    const { ctl, host } = setup();
    host.snapshot = makeSnapshot([-3, 0, 0, 3, 0, 0]);
    ctl.fitToView(host.snapshot);
    const cam = ctl.camera as THREE.OrthographicCamera;
    const centred = cam.left + cam.right;
    ctl.setViewInsets(200, 0);
    expect(cam.left + cam.right).not.toBeCloseTo(centred, 6);
  });

  it("resetCamera re-fits, clears the frustum pan and notifies", () => {
    const { ctl, host, internals } = setup();
    host.snapshot = makeSnapshot([-3, 0, 0, 3, 0, 0]);
    const cb = vi.fn();
    ctl.setCameraChangeCallback(cb);
    internals._frustumPanX = 9;
    internals._frustumPanY = -4;
    ctl.resetCamera();
    expect(internals._frustumPanX).toBe(0);
    expect(internals._frustumPanY).toBe(0);
    const cam = ctl.camera as THREE.OrthographicCamera;
    expect(cam.left + cam.right).toBeCloseTo(0, 6);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("resetCamera is a no-op without a snapshot", () => {
    const { ctl } = setup();
    const cb = vi.fn();
    ctl.setCameraChangeCallback(cb);
    ctl.resetCamera();
    expect(cb).not.toHaveBeenCalled();
  });

  it("resetCamera fits a perspective camera without touching a frustum", () => {
    const { ctl, host } = setup();
    ctl.setPerspective(true);
    host.snapshot = makeSnapshot([-3, 0, 0, 3, 0, 0]);
    ctl.resetCamera();
    expect(ctl.controls.target.x).toBeCloseTo(0, 6);
  });

  it("syncExtent re-measures the extent without moving the camera", () => {
    const { ctl, internals } = setup();
    const pos = ctl.camera.position.clone();
    ctl.syncExtent(makeSnapshot([0, 0, 0, 40, 0, 0]));
    expect(internals.lastExtent.maxExtent).toBeGreaterThan(40);
    expect(ctl.camera.position.toArray()).toEqual(pos.toArray());
  });

  it("setPerspective refits to the loaded snapshot", () => {
    const { ctl, host } = setup();
    host.snapshot = makeSnapshot([10, 0, 0, 14, 0, 0]);
    ctl.setPerspective(true);
    expect(ctl.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(ctl.controls.target.x).toBeCloseTo(12, 6);
  });

  it("setPerspective only records the mode before mount (no container)", () => {
    const ctl = new CameraController({
      getContainer: () => null,
      getCanvas: () => document.createElement("div"),
      getSnapshot: () => null,
      getCurrentPositions: () => new Float32Array(0),
    });
    ctl.setPerspective(true);
    expect(ctl.camera).toBeUndefined();
    expect(ctl.getCameraState()).toBeNull();
  });
});

describe("CameraController custom pan (perspective)", () => {
  it("translates camera and target together on a right-drag", () => {
    const { ctl, canvas } = setup();
    ctl.setPerspective(true);
    const cam = ctl.camera as THREE.PerspectiveCamera;
    cam.position.set(0, -40, 0);
    ctl.controls.target.set(0, 0, 0);
    ctl.controls.syncImmediate();
    cam.updateMatrix();
    const press = (type: string, x: number, init: MouseEventInit = {}) =>
      canvas.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: 300, bubbles: true, ...init }),
      );
    press("pointerdown", 400, { button: 2 });
    press("pointermove", 480);
    press("pointerup", 480);
    expect(ctl.controls.target.x).toBeLessThan(0);
    expect(cam.position.x).toBeCloseTo(ctl.controls.target.x, 9);
    expect(cam.position.y).toBeCloseTo(-40, 9);
  });

  it("ignores a second press while a pan is active and other pointers' moves", () => {
    const { ctl, canvas, internals } = setup();
    const press = (type: string, x: number, init: MouseEventInit = {}) =>
      canvas.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: 300, bubbles: true, ...init }),
      );
    press("pointerdown", 400, { button: 2 });
    press("pointerdown", 100, { button: 2 });
    press("pointermove", 480);
    // 80 px of an 800 px wide, 50 * 800/600 unit frustum; the second press is ignored.
    expect(internals._frustumPanX).toBeCloseTo(-(80 / 800) * ((50 * 800) / 600), 6);
    press("pointerup", 480);
    expect(internals.customPanActive).toBe(false);
  });

  it("does nothing for a zero-sized container", () => {
    const { canvas, internals } = setup({ width: 0, height: 0 });
    const press = (type: string, x: number, init: MouseEventInit = {}) =>
      canvas.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: 0, bubbles: true, ...init }),
      );
    press("pointerdown", 0, { button: 2 });
    press("pointermove", 50);
    press("pointerup", 50);
    expect(internals._frustumPanX).toBe(0);
  });
});

describe("CameraController.screenToWorldAtPivot", () => {
  it("unprojects onto the plane through the controls target", () => {
    const { ctl } = setup({ width: 800, height: 600 });
    ctl.controls.target.set(0, 0, 0);
    ctl.camera.lookAt(0, 0, 0);
    ctl.camera.updateMatrixWorld(true);
    const p = ctl.screenToWorldAtPivot(400, 300)!;
    expect(p[0]).toBeCloseTo(0, 4);
    expect(p[1]).toBeCloseTo(0, 3);
    expect(p[2]).toBeCloseTo(0, 4);
  });

  it("returns null before mount", () => {
    const { ctl } = setup({ mount: false });
    expect(ctl.screenToWorldAtPivot(0, 0)).toBeNull();
  });
});

describe("CameraController.setControlsEnabled", () => {
  it("toggles the controls, and is safe before mount", () => {
    const { ctl } = setup();
    ctl.setControlsEnabled(false);
    expect(ctl.controls.enabled).toBe(false);
    ctl.setControlsEnabled(true);
    expect(ctl.controls.enabled).toBe(true);
    expect(() => setup({ mount: false }).ctl.setControlsEnabled(false)).not.toThrow();
  });
});

describe("CameraController.dispose", () => {
  it("detaches the wheel and pan listeners and disposes the controls", () => {
    const { ctl, container, canvas, internals } = setup();
    const disposeSpy = vi.spyOn(ctl.controls, "dispose");
    ctl.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(internals.wheelZoomHandler).toBeNull();
    const zoom = ctl.camera.zoom;
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    expect(ctl.camera.zoom).toBe(zoom);
    canvas.dispatchEvent(
      new MouseEvent("pointerdown", { button: 2, clientX: 0, clientY: 0, bubbles: true }),
    );
    expect(internals.customPanActive).toBe(false);
  });

  it("is safe after a mount that never happened", () => {
    expect(() => setup({ mount: false }).ctl.dispose()).not.toThrow();
  });
});
