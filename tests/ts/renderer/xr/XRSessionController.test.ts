/**
 * XRSessionController against a fake WebXR stack: a stand-in for three's
 * `renderer.xr` (session hand-off, controller spaces, `sessionend`) and a
 * fake `XRSession` / `navigator.xr`. The gestures' math is covered in
 * xrMath.test.ts; these tests drive the wiring — events, anchors, frame loop,
 * and restoring the desktop view.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as THREE from "three";
import {
  EXACT_IMPOSTOR_UNIFORM,
  setExactImpostors,
  XRSessionController,
  type XRHost,
} from "@/renderer/xr/XRSessionController";
import { XR_PLACEMENT_RADIUS, XR_STICK_ZOOM_RATE } from "@/renderer/xr/xrMath";

/* eslint-disable @typescript-eslint/no-explicit-any */

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

class FakeXRManager extends THREE.EventDispatcher<any> {
  enabled = false;
  isPresenting = false;
  readonly controllers = [new THREE.Group(), new THREE.Group()];
  readonly referenceSpace = {} as XRReferenceSpace;
  setReferenceSpaceType = vi.fn();
  setSession = vi.fn(async () => {
    this.isPresenting = true;
  });
  getController = (i: number) => this.controllers[i];
  getReferenceSpace = (): XRReferenceSpace | null => this.referenceSpace;
}

function setup(opts: { localFloor?: boolean; mode?: XRSessionMode } = {}) {
  const xr = new FakeXRManager();
  let loop: ((time: number, frame?: XRFrame) => void) | null = null;
  const renderer = {
    xr,
    render: vi.fn(),
    setAnimationLoop: vi.fn((cb: typeof loop) => {
      loop = cb;
    }),
    getClearAlpha: vi.fn(() => 1),
    setClearAlpha: vi.fn(),
  };
  const session = {
    requestReferenceSpace: vi.fn(async (type: string) => {
      if (type === "local-floor" && opts.localFloor === false) throw new Error("unsupported");
      return {};
    }),
    end: vi.fn(async () => {
      xr.isPresenting = false;
      xr.dispatchEvent({ type: "sessionend" });
    }),
  };
  const requestSession = vi.fn(async () => session);
  vi.stubGlobal("navigator", { xr: { requestSession } });

  const scene = new THREE.Scene();
  const background = new THREE.Color(0xffffff);
  scene.background = background;
  const impostor = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.ShaderMaterial({ uniforms: { [EXACT_IMPOSTOR_UNIFORM]: { value: 0 } } }),
  );
  scene.add(impostor);
  const camera = new THREE.PerspectiveCamera();
  const host: XRHost & { onPresentingChange: ReturnType<typeof vi.fn> } = {
    getRenderer: () => renderer as unknown as THREE.WebGLRenderer,
    getScene: () => scene,
    getViewCamera: () => camera,
    getFocus: vi.fn(() => ({ center: v(0, 0, 0), radius: 25 })),
    onPresentingChange: vi.fn(),
  };
  const controller = new XRSessionController(host);

  /** One frame of the session loop, the head at `head` looking down −z. */
  const frame = (time: number, head: THREE.Vector3 | null = v(0, 1.6, 0)) => {
    const xrFrame = {
      getViewerPose: () =>
        head
          ? {
              transform: {
                position: { x: head.x, y: head.y, z: head.z },
                orientation: { x: 0, y: 0, z: 0, w: 1 },
              },
            }
          : null,
    } as unknown as XRFrame;
    loop?.(time, xrFrame);
  };
  const uniform = () =>
    (impostor.material as THREE.ShaderMaterial).uniforms[EXACT_IMPOSTOR_UNIFORM].value;
  return {
    xr,
    renderer,
    session,
    requestSession,
    scene,
    background,
    host,
    controller,
    frame,
    uniform,
    getLoop: () => loop,
  };
}

/** Bring controller `i` into tracking at `pos` and connect `source`. */
function track(xr: FakeXRManager, i: number, pos: THREE.Vector3, source: any = {}) {
  const space = xr.controllers[i];
  space.visible = true;
  space.matrix.makeTranslation(pos.x, pos.y, pos.z);
  space.dispatchEvent({ type: "connected", data: source });
  return space;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setExactImpostors", () => {
  it("flips the uniform on every impostor material and skips other objects", () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({ uniforms: { [EXACT_IMPOSTOR_UNIFORM]: { value: 0 } } }),
    );
    const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    root.add(a, plain, new THREE.Group());
    setExactImpostors(root, true);
    expect((a.material as THREE.ShaderMaterial).uniforms[EXACT_IMPOSTOR_UNIFORM].value).toBe(1);
    setExactImpostors(root, false);
    expect((a.material as THREE.ShaderMaterial).uniforms[EXACT_IMPOSTOR_UNIFORM].value).toBe(0);
  });
});

describe("XRSessionController session lifecycle", () => {
  it("starts a session and hands the frame loop to it", async () => {
    const t = setup();
    const listener = vi.fn();
    t.controller.subscribe(listener);
    await t.controller.enter("immersive-vr");
    expect(t.requestSession).toHaveBeenCalledWith("immersive-vr", {
      optionalFeatures: ["local-floor", "hand-tracking"],
    });
    expect(t.xr.enabled).toBe(true);
    expect(t.xr.setReferenceSpaceType).toHaveBeenCalledWith("local-floor");
    expect(t.xr.setSession).toHaveBeenCalledWith(t.session);
    expect(t.renderer.setAnimationLoop).toHaveBeenCalledWith(expect.any(Function));
    expect(t.host.onPresentingChange).toHaveBeenCalledWith(true);
    expect(t.scene.getObjectByName("megane-xr-rig")).toBeDefined();
    expect(t.controller.presenting).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ presenting: true, mode: "immersive-vr" }),
    );
    // VR keeps the scene background.
    expect(t.scene.background).toBe(t.background);
  });

  it("falls back to a local reference space without local-floor", async () => {
    const t = setup({ localFloor: false });
    await t.controller.enter("immersive-vr");
    expect(t.xr.setReferenceSpaceType).toHaveBeenCalledWith("local");
  });

  it("ignores a second enter while presenting", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    await t.controller.enter("immersive-ar");
    expect(t.requestSession).toHaveBeenCalledTimes(1);
    expect(t.controller.getState().mode).toBe("immersive-vr");
  });

  it("ignores a second click while the first session is still starting", async () => {
    const t = setup();
    const first = t.controller.enter("immersive-vr");
    await t.controller.enter("immersive-vr");
    await first;
    expect(t.requestSession).toHaveBeenCalledTimes(1);
    expect(t.controller.presenting).toBe(true);
  });

  it("can try again after the browser refuses a session", async () => {
    const t = setup();
    t.requestSession.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await expect(t.controller.enter("immersive-vr")).rejects.toThrow("denied");
    await t.controller.enter("immersive-vr");
    expect(t.controller.presenting).toBe(true);
  });

  it("rejects when the browser has no WebXR", async () => {
    const t = setup();
    vi.stubGlobal("navigator", {});
    await expect(t.controller.enter("immersive-vr")).rejects.toThrow(/not available/);
    expect(t.controller.presenting).toBe(false);
  });

  it("ends the session and restores the desktop view when three cannot attach it", async () => {
    const t = setup();
    t.xr.setSession.mockRejectedValueOnce(new Error("makeXRCompatible failed"));
    await expect(t.controller.enter("immersive-vr")).rejects.toThrow("makeXRCompatible failed");
    expect(t.session.end).toHaveBeenCalled();
    expect(t.controller.presenting).toBe(false);
    expect(t.xr.enabled).toBe(false);
    expect(t.host.onPresentingChange).toHaveBeenLastCalledWith(false);
  });

  it("restores the scene, the loop and the shading when the session ends", async () => {
    const t = setup();
    t.scene.position.set(1, 2, 3);
    await t.controller.enter("immersive-vr");
    t.frame(0);
    expect(t.uniform()).toBe(1);
    expect(t.scene.scale.x).not.toBe(1);
    await t.controller.exit();
    expect(t.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(t.xr.enabled).toBe(false);
    expect(t.scene.position.toArray()).toEqual([1, 2, 3]);
    expect(t.scene.scale.toArray()).toEqual([1, 1, 1]);
    expect(t.scene.getObjectByName("megane-xr-rig")).toBeUndefined();
    expect(t.uniform()).toBe(0);
    expect(t.host.onPresentingChange).toHaveBeenLastCalledWith(false);
    expect(t.controller.getState()).toMatchObject({ presenting: false, mode: null, frames: 1 });
    // exit() without a session is a no-op.
    await expect(t.controller.exit()).resolves.toBeUndefined();
  });

  it("clears the background for passthrough AR and puts it back afterwards", async () => {
    const t = setup();
    await t.controller.enter("immersive-ar");
    expect(t.scene.background).toBeNull();
    expect(t.renderer.setClearAlpha).toHaveBeenLastCalledWith(0);
    await t.controller.exit();
    expect(t.scene.background).toBe(t.background);
    expect(t.renderer.setClearAlpha).toHaveBeenLastCalledWith(1);
  });

  it("can enter again after a session ended, reusing its controller spaces", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    await t.controller.exit();
    await t.controller.enter("immersive-vr");
    const rig = t.scene.getObjectByName("megane-xr-rig")!;
    expect(rig.children).toEqual(t.xr.controllers);
  });

  it("unsubscribes listeners and ends the session on dispose", async () => {
    const t = setup();
    const listener = vi.fn();
    const off = t.controller.subscribe(listener);
    off();
    await t.controller.enter("immersive-vr");
    expect(listener).not.toHaveBeenCalled();
    t.controller.dispose();
    expect(t.session.end).toHaveBeenCalled();
  });
});

describe("XRSessionController frames", () => {
  it("places the structure in front of the head on the first frame and draws it", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const state = t.controller.getState();
    expect(state.scale).toBeCloseTo(XR_PLACEMENT_RADIUS / 25, 9);
    expect(state.position[2]).toBeLessThan(0);
    expect(t.renderer.render).toHaveBeenCalledWith(t.scene, expect.any(THREE.PerspectiveCamera));
    expect(state.frames).toBe(1);
    // The rig cancels the scene transform so controllers stay in room space.
    const rig = t.scene.getObjectByName("megane-xr-rig")!;
    t.scene.updateMatrixWorld(true);
    expect(rig.matrixWorld.equals(new THREE.Matrix4())).toBe(false);
    const product = t.scene.matrixWorld.clone().multiply(rig.matrix);
    for (let i = 0; i < 16; i++) {
      expect(product.elements[i]).toBeCloseTo(new THREE.Matrix4().elements[i], 9);
    }
  });

  it("waits for a viewer pose before placing", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0, null);
    expect(t.controller.getState().scale).toBe(1);
    t.xr.getReferenceSpace = () => null;
    t.frame(16);
    expect(t.controller.getState().scale).toBe(1);
    expect(t.renderer.render).toHaveBeenCalledTimes(2);
  });

  it("draws nothing once three stops presenting", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.xr.isPresenting = false;
    t.frame(0);
    expect(t.renderer.render).not.toHaveBeenCalled();
  });

  it("carries the structure with one grabbing hand", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const right = track(t.xr, 0, v(0.2, 1.2, -0.4));
    right.dispatchEvent({ type: "selectstart" });
    const before = t.controller.getState().position;
    right.matrix.makeTranslation(0.3, 1.4, -0.4);
    t.frame(16);
    const after = t.controller.getState().position;
    expect(after[0] - before[0]).toBeCloseTo(0.1, 9);
    expect(after[1] - before[1]).toBeCloseTo(0.2, 9);
    // Released: moving the hand no longer moves the structure.
    right.dispatchEvent({ type: "selectend" });
    right.matrix.makeTranslation(0, 0, 0);
    t.frame(32);
    expect(t.controller.getState().position).toEqual(after);
  });

  it("scales with two hands and hands over to the remaining one", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const scale0 = t.controller.getState().scale;
    const left = track(t.xr, 0, v(-0.1, 1.2, -0.4));
    const right = track(t.xr, 1, v(0.1, 1.2, -0.4));
    left.dispatchEvent({ type: "squeezestart" });
    right.dispatchEvent({ type: "squeezestart" });
    left.matrix.makeTranslation(-0.2, 1.2, -0.4);
    right.matrix.makeTranslation(0.2, 1.2, -0.4);
    t.frame(16);
    expect(t.controller.getState().scale).toBeCloseTo(scale0 * 2, 9);
    // Let go with the left hand: the right one carries on alone.
    left.dispatchEvent({ type: "squeezeend" });
    const before = t.controller.getState().position;
    right.matrix.makeTranslation(0.2, 1.3, -0.4);
    t.frame(32);
    expect(t.controller.getState().scale).toBeCloseTo(scale0 * 2, 9);
    expect(t.controller.getState().position[1] - before[1]).toBeCloseTo(0.1, 9);
  });

  it("re-anchors when a grabbing hand loses tracking or disconnects", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const left = track(t.xr, 0, v(-0.1, 1.2, -0.4));
    const right = track(t.xr, 1, v(0.1, 1.2, -0.4));
    left.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectstart" });
    // The left hand drops out of tracking mid-gesture: the right hand takes
    // over from where it is, and carries the structure from then on.
    left.visible = false;
    t.frame(16);
    const before = t.controller.getState().position;
    right.matrix.makeTranslation(0.1, 1.3, -0.4);
    t.frame(32);
    expect(t.controller.getState().position[1] - before[1]).toBeCloseTo(0.1, 9);
    // The right controller disconnects: nothing grabs any more.
    right.dispatchEvent({ type: "disconnected", data: {} });
    right.matrix.makeTranslation(1, 1, 1);
    const held = t.controller.getState().position;
    t.frame(48);
    expect(t.controller.getState().position).toEqual(held);
  });

  it("ignores a release without a press", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const right = track(t.xr, 0, v(0, 1, 0));
    right.dispatchEvent({ type: "squeezeend" });
    const held = t.controller.getState().position;
    t.frame(16);
    expect(t.controller.getState().position).toEqual(held);
  });

  it("zooms with the thumbstick, but not while a hand grabs", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const scale0 = t.controller.getState().scale;
    const gamepad = { axes: [0, 0, 0, -1], buttons: [] as { pressed: boolean }[] };
    const right = track(t.xr, 0, v(0.2, 1.2, -0.4), { gamepad });
    t.frame(100); // dt = 0.1 s
    expect(t.controller.getState().scale).toBeCloseTo(
      scale0 * Math.exp(XR_STICK_ZOOM_RATE * 0.1),
      9,
    );
    right.dispatchEvent({ type: "selectstart" });
    const grabbed = t.controller.getState().scale;
    t.frame(200);
    expect(t.controller.getState().scale).toBeCloseTo(grabbed, 9);
  });

  it("caps a long frame gap so a hitch does not fling the structure", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const scale0 = t.controller.getState().scale;
    track(t.xr, 0, v(0, 1, 0), { gamepad: { axes: [0, 0, 0, -1], buttons: [] } });
    t.frame(5000);
    expect(t.controller.getState().scale).toBeCloseTo(
      scale0 * Math.exp(XR_STICK_ZOOM_RATE * 0.1),
      9,
    );
  });

  it("puts the structure back in front of the user on A / X", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const placed = t.controller.getState().position;
    const buttons = [0, 1, 2, 3, 4].map(() => ({ pressed: false }));
    const right = track(t.xr, 0, v(0.2, 1.2, -0.4), { gamepad: { axes: [], buttons } });
    right.dispatchEvent({ type: "selectstart" });
    right.matrix.makeTranslation(0.6, 1.2, -0.4);
    t.frame(16);
    right.dispatchEvent({ type: "selectend" });
    expect(t.controller.getState().position).not.toEqual(placed);
    buttons[4].pressed = true;
    t.frame(32); // the press is seen; the next frame re-places
    t.frame(48);
    const reset = t.controller.getState().position;
    for (let i = 0; i < 3; i++) expect(reset[i]).toBeCloseTo(placed[i], 9);
    // Holding the button does not keep re-placing.
    right.dispatchEvent({ type: "selectstart" });
    right.matrix.makeTranslation(0.2, 1.5, -0.4);
    t.frame(64);
    expect(t.controller.getState().position[1]).not.toBeCloseTo(placed[1], 3);
    expect(t.host.getFocus).toHaveBeenCalledTimes(2);
  });
});
