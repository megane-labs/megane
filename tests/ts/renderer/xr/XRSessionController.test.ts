/**
 * XRSessionController against a fake WebXR stack: a stand-in for three's
 * `renderer.xr` (session hand-off, controller spaces, `sessionend`) and a
 * fake `XRSession` / `navigator.xr`. The gestures' math is covered in
 * xrMath.test.ts; these tests drive the wiring — events, anchors, frame loop,
 * and restoring the desktop view.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as THREE from "three";
import {
  applyXRShading,
  EXACT_IMPOSTOR_UNIFORM,
  XRSessionController,
  type XRHighlight,
  type XRHost,
  type XRPressAction,
} from "@/renderer/xr/XRSessionController";
import type { XREditPanel } from "@/renderer/xr/XRPanel";
import {
  XR_DEPTH_CUE_STRENGTH,
  XR_NEAR_CLIP,
  XR_NEAR_FADE,
  XR_PLACEMENT_DISTANCE,
  XR_PLACEMENT_DROP,
  XR_PICK_MIN_RADIUS,
  XR_PLACEMENT_RADIUS,
  XR_STICK_ZOOM_RATE,
} from "@/renderer/xr/xrMath";
import { stubCanvas2D } from "./fakeCanvas";

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
  /** three's per-eye cameras; the viewport height sizes the edge fringe. */
  readonly eyes: { viewport?: THREE.Vector4 }[] = [
    { viewport: new THREE.Vector4(0, 0, 1600, 1000) },
  ];
  getCamera = () => ({ cameras: this.eyes });
}

/** A material carrying the impostor shaders' immersive uniforms. */
function impostorMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      [EXACT_IMPOSTOR_UNIFORM]: { value: 0 },
      uXRPixel: { value: 0 },
      uXRNear: { value: new THREE.Vector2() },
      uXRFog: { value: new THREE.Vector3() },
      uXRFogColor: { value: new THREE.Vector3() },
    },
  });
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
  const impostor = new THREE.Mesh(new THREE.BufferGeometry(), impostorMaterial());
  scene.add(impostor);
  const camera = new THREE.PerspectiveCamera();
  const host: XRHost & { onPresentingChange: ReturnType<typeof vi.fn> } = {
    getRenderer: () => renderer as unknown as THREE.WebGLRenderer,
    getScene: () => scene,
    getViewCamera: () => camera,
    getFocus: vi.fn(() => ({ center: v(0, 0, 0), radius: 25 })),
    onPresentingChange: vi.fn(),
    pickAtom: vi.fn(() => null),
    setHoverAtoms: vi.fn(),
    getSelectedAtoms: vi.fn(() => []),
    getMeasurement: vi.fn(() => null),
    getAtomPosition: vi.fn(() => false),
    getLabels: vi.fn(() => null),
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
  const material = impostor.material as THREE.ShaderMaterial;
  const uniform = () => material.uniforms[EXACT_IMPOSTOR_UNIFORM].value;
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
    material,
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

beforeEach(() => {
  stubCanvas2D();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("applyXRShading", () => {
  const shading = {
    fogStart: 0.7,
    fogEnd: 1.5,
    fogStrength: 0.4,
    fogColor: new THREE.Color(0.1, 0.2, 0.3),
    pixel: 0.002,
  };

  it("switches impostor materials to the immersive shading and back", () => {
    const root = new THREE.Group();
    const opaque = new THREE.Mesh(new THREE.BufferGeometry(), impostorMaterial());
    const blended = new THREE.Mesh(new THREE.BufferGeometry(), impostorMaterial());
    (blended.material as THREE.ShaderMaterial).transparent = true;
    const plain = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    root.add(opaque, blended, plain, new THREE.Group());
    applyXRShading(root, shading);
    const u = (opaque.material as THREE.ShaderMaterial).uniforms;
    expect(u[EXACT_IMPOSTOR_UNIFORM].value).toBe(1);
    expect(u.uXRPixel.value).toBe(0.002);
    expect(u.uXRNear.value.toArray()).toEqual([XR_NEAR_CLIP, XR_NEAR_FADE]);
    expect(u.uXRFog.value.toArray()).toEqual([0.7, 1.5, 0.4]);
    expect(u.uXRFogColor.value.x).toBeCloseTo(0.1, 6);
    // Alpha-to-coverage smooths opaque edges; blended ones use their alpha.
    expect(opaque.material.alphaToCoverage).toBe(true);
    expect(blended.material.alphaToCoverage).toBe(false);
    expect(plain.material.alphaToCoverage).toBe(false);
    applyXRShading(root, null);
    expect(u[EXACT_IMPOSTOR_UNIFORM].value).toBe(0);
    expect(opaque.material.alphaToCoverage).toBe(false);
  });

  it("tolerates materials without the immersive uniforms", () => {
    const root = new THREE.Group();
    const bare = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({ uniforms: { [EXACT_IMPOSTOR_UNIFORM]: { value: 0 } } }),
    );
    root.add(bare);
    expect(() => applyXRShading(root, shading)).not.toThrow();
    expect((bare.material as THREE.ShaderMaterial).uniforms[EXACT_IMPOSTOR_UNIFORM].value).toBe(1);
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
    // With no background to fade into, the depth cue darkens instead.
    t.frame(0);
    expect(t.material.uniforms.uXRFogColor.value.toArray()).toEqual([0, 0, 0]);
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
    expect(rig.children.filter((c) => t.xr.controllers.includes(c as THREE.Group))).toEqual(
      t.xr.controllers,
    );
    expect(rig.children.filter((c) => c.name === "megane-xr-panel")).toHaveLength(1);
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
    // The depth cue spans the structure as seen from the head: its near side
    // to its far side, toward the background colour.
    const fog = t.material.uniforms.uXRFog.value;
    expect(fog.x).toBeCloseTo(XR_PLACEMENT_DISTANCE - XR_PLACEMENT_RADIUS, 2);
    expect(fog.y).toBeCloseTo(XR_PLACEMENT_DISTANCE + XR_PLACEMENT_RADIUS, 2);
    expect(fog.z).toBe(XR_DEPTH_CUE_STRENGTH);
    expect(t.material.uniforms.uXRFogColor.value.toArray()).toEqual([1, 1, 1]);
    // One pixel of the 1000-pixel-high eye viewport.
    expect(t.material.uniforms.uXRPixel.value).toBeCloseTo(2 / 1000, 9);
    expect(t.material.alphaToCoverage).toBe(true);
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
    // Before three reports an eye viewport, a Quest-class height is assumed.
    t.xr.eyes.length = 0;
    await t.controller.enter("immersive-vr");
    t.frame(0, null);
    expect(t.controller.getState().scale).toBe(1);
    // Nothing placed yet: no depth cue.
    expect(t.material.uniforms.uXRFog.value.z).toBe(0);
    expect(t.material.uniforms.uXRPixel.value).toBeCloseTo(2 / 1800, 9);
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
    // Below the panel: the rays point at nothing, so the presses grab.
    const left = track(t.xr, 0, v(-0.1, 1.0, -0.4));
    const right = track(t.xr, 1, v(0.1, 1.0, -0.4));
    left.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectstart" });
    // The left hand drops out of tracking mid-gesture: the right hand takes
    // over from where it is, and carries the structure from then on.
    left.visible = false;
    t.frame(16);
    const before = t.controller.getState().position;
    right.matrix.makeTranslation(0.1, 1.1, -0.4);
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

/** Point controller `i` at panel control `id` (an emulated pose 15 cm in front of it). */
function aim(
  t: ReturnType<typeof setup>,
  i: number,
  id: Parameters<XRSessionController["panelControlPose"]>[0],
  source: any = {},
) {
  const pose = t.controller.panelControlPose(id);
  expect(pose).not.toBeNull();
  const space = track(t.xr, i, v(...pose!.position), source);
  space.matrix.compose(v(...pose!.position), new THREE.Quaternion(...pose!.quaternion), v(1, 1, 1));
  return space;
}

/** A page bridge with a 10-frame trajectory at frame 3 and a measurement selection. */
function bridge() {
  const state = { frame: 3, total: 10, playing: false };
  return {
    state,
    playback: {
      getState: vi.fn(() => ({ ...state })),
      togglePlay: vi.fn(() => {
        state.playing = !state.playing;
      }),
      seek: vi.fn((frame: number) => {
        state.frame = frame;
      }),
    },
    measure: { toggleAtom: vi.fn(), clear: vi.fn() },
  };
}

describe("XRSessionController panel", () => {
  it("offers Reset and Exit without a page bridge, placed below the view", async () => {
    const t = setup();
    expect(t.controller.panelControlPose("exit")).toBeNull();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    expect(t.controller.getState()).toMatchObject({ panel: ["reset", "exit"], measuring: false });
    const panel = t.scene.getObjectByName("megane-xr-panel")!;
    expect(panel.visible).toBe(true);
    expect(panel.position.y).toBeLessThan(1.6);
    expect(panel.position.z).toBeLessThan(0);
    await t.controller.exit();
    expect(t.controller.getState().panel).toEqual([]);
    expect(t.controller.panelControlPose("exit")).toBeNull();
  });

  it("presses controls with the trigger, firing on release over them", async () => {
    const t = setup();
    const b = bridge();
    t.controller.setBridge(b);
    await t.controller.enter("immersive-vr");
    t.frame(0);
    expect(t.controller.getState().panel).toEqual([
      "prev",
      "play",
      "next",
      "scrub",
      "measure",
      "reset",
      "exit",
    ]);
    const right = aim(t, 0, "play");
    t.frame(16);
    right.dispatchEvent({ type: "selectstart" });
    // Pressing a control does not grab: the structure stays put.
    const held = t.controller.getState().position;
    right.matrix.setPosition(
      right.matrix.elements[12] + 0.001,
      right.matrix.elements[13],
      right.matrix.elements[14],
    );
    t.frame(32);
    expect(t.controller.getState().position).toEqual(held);
    right.dispatchEvent({ type: "selectend" });
    expect(b.playback.togglePlay).toHaveBeenCalledTimes(1);

    aim(t, 0, "next");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(b.playback.seek).toHaveBeenLastCalledWith(4);
    aim(t, 0, "prev");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(b.playback.seek).toHaveBeenLastCalledWith(3);

    // Released after sliding off the control: nothing fires.
    aim(t, 0, "play");
    right.dispatchEvent({ type: "selectstart" });
    right.matrix.makeTranslation(0, 1.6, 0);
    right.dispatchEvent({ type: "selectend" });
    expect(b.playback.togglePlay).toHaveBeenCalledTimes(1);
  });

  it("scrubs while the trigger is held on the bar, even past its end", async () => {
    const t = setup();
    const b = bridge();
    t.controller.setBridge(b);
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const right = aim(t, 0, "scrub");
    right.dispatchEvent({ type: "selectstart" });
    // The middle of the bar is the middle of the trajectory.
    expect(b.playback.seek).toHaveBeenLastCalledWith(5);
    t.frame(16);
    expect(b.playback.seek).toHaveBeenCalledTimes(1);
    // Slide 50 cm to the right, off the panel: the last frame.
    const panel = t.scene.getObjectByName("megane-xr-panel")!;
    const rightward = v(1, 0, 0).applyQuaternion(panel.quaternion);
    const p = v().setFromMatrixPosition(right.matrix).addScaledVector(rightward, 0.5);
    right.matrix.setPosition(p);
    t.frame(32);
    expect(b.playback.seek).toHaveBeenLastCalledWith(9);
    right.dispatchEvent({ type: "selectend" });
    expect(b.playback.seek).toHaveBeenCalledTimes(2);
  });

  it("swallows a press on the panel's background instead of grabbing", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const right = aim(t, 0, "reset");
    // Up into the status row: on the panel, on no control.
    const panel = t.scene.getObjectByName("megane-xr-panel")!;
    const up = v(0, 1, 0).applyQuaternion(panel.quaternion);
    right.matrix.setPosition(v().setFromMatrixPosition(right.matrix).addScaledVector(up, 0.09));
    right.dispatchEvent({ type: "selectstart" });
    const held = t.controller.getState().position;
    right.matrix.setPosition(v(0.5, 1.5, -0.2));
    t.frame(16);
    expect(t.controller.getState().position).toEqual(held);
    right.dispatchEvent({ type: "selectend" });
  });

  it("puts the structure back with Reset and leaves with Exit", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const placed = t.controller.getState().position;
    const left = track(t.xr, 1, v(0, 1.0, -0.6));
    left.dispatchEvent({ type: "squeezestart" });
    left.matrix.makeTranslation(0.3, 1.0, -0.6);
    t.frame(16);
    left.dispatchEvent({ type: "squeezeend" });
    expect(t.controller.getState().position).not.toEqual(placed);
    const right = aim(t, 0, "reset");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    t.frame(32);
    const reset = t.controller.getState().position;
    for (let i = 0; i < 3; i++) expect(reset[i]).toBeCloseTo(placed[i], 9);
    aim(t, 0, "exit");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    await Promise.resolve();
    expect(t.session.end).toHaveBeenCalled();
    expect(t.controller.presenting).toBe(false);
  });

  it("toggles playback on B / Y", async () => {
    const t = setup();
    const b = bridge();
    t.controller.setBridge(b);
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const buttons = [0, 1, 2, 3, 4, 5].map(() => ({ pressed: false }));
    track(t.xr, 0, v(0.2, 1.2, -0.4), { gamepad: { axes: [], buttons } });
    buttons[5].pressed = true;
    t.frame(16);
    t.frame(32); // held: no repeat
    expect(b.playback.togglePlay).toHaveBeenCalledTimes(1);
    buttons[5].pressed = false;
    t.frame(48);
    buttons[5].pressed = true;
    t.frame(64);
    expect(b.playback.togglePlay).toHaveBeenCalledTimes(2);
  });
});

describe("XRSessionController measure mode", () => {
  /** A hit 0.5 Å-units… away: the host answers every ray with atom 7. */
  function measuring() {
    const t = setup();
    const b = bridge();
    t.controller.setBridge(b);
    t.host.pickAtom.mockImplementation(() => ({ atomIndex: 7, distance: 30, position: [0, 0, 0] }));
    return { t, b };
  }

  it("turns on from the panel, highlights the atom a ray points at and toggles it on a pinch", async () => {
    const { t, b } = measuring();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    // Not measuring yet: rays do not pick atoms.
    const left = track(t.xr, 1, v(0.3, 1.6, 0));
    t.frame(16);
    expect(t.host.pickAtom).not.toHaveBeenCalled();
    const right = aim(t, 0, "measure");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(t.controller.getState().measuring).toBe(true);
    right.matrix.makeTranslation(-0.3, 1.6, 0);
    t.frame(32);
    expect(t.host.setHoverAtoms).toHaveBeenLastCalledWith([7]);
    // The ray in structure space, each atom at least 8 mm wide in the room.
    const [ray, minRadius] = t.host.pickAtom.mock.calls[0];
    expect(ray).toBeInstanceOf(THREE.Ray);
    expect(minRadius).toBeCloseTo(XR_PICK_MIN_RADIUS / t.controller.getState().scale, 6);
    // The ray is drawn up to the atom, in the atom colour.
    const line = left.children.find((c) => c instanceof THREE.Line) as THREE.Line;
    expect(line.visible).toBe(true);
    expect(line.scale.z).toBeCloseTo(30 * t.controller.getState().scale, 9);
    // The same hover from both hands is sent once.
    t.frame(48);
    expect(t.host.setHoverAtoms).toHaveBeenCalledTimes(1);
    left.dispatchEvent({ type: "selectstart" });
    expect(b.measure.toggleAtom).toHaveBeenCalledWith(7);
    // A pinch on an atom does not grab.
    const held = t.controller.getState().position;
    left.matrix.makeTranslation(0.5, 1.6, 0);
    t.frame(64);
    expect(t.controller.getState().position).toEqual(held);
    left.dispatchEvent({ type: "selectend" });
  });

  it("grabs when a pinch points at no atom, and shows no ray while grabbing", async () => {
    const { t } = measuring();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const right = aim(t, 0, "measure");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    t.host.pickAtom.mockReturnValue(null);
    right.matrix.makeTranslation(0.2, 1.6, 0);
    t.frame(16);
    const line = right.children.find((c) => c instanceof THREE.Line) as THREE.Line;
    expect(line.visible).toBe(false);
    right.dispatchEvent({ type: "selectstart" });
    const before = t.controller.getState().position;
    right.matrix.makeTranslation(0.3, 1.6, 0);
    t.frame(32);
    expect(t.controller.getState().position[0] - before[0]).toBeCloseTo(0.1, 9);
    expect(line.visible).toBe(false);
  });

  it("shows the measurement over the measured atoms, clears it, and turns off", async () => {
    const { t, b } = measuring();
    t.host.getSelectedAtoms.mockReturnValue([1, 2]);
    t.host.getMeasurement.mockReturnValue({
      atoms: [1, 2],
      type: "distance",
      value: 1.5,
      label: "1.500 Å",
    });
    t.host.getAtomPosition.mockImplementation((i: number, out: THREE.Vector3) => {
      out.set(i, 0, 0);
      return true;
    });
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const label = t.scene.getObjectByName("megane-xr-measure-label")!;
    expect(label.visible).toBe(true);
    expect(label.position.toArray()).toEqual([1.5, 0, 0]);
    expect(t.controller.getState().panel).toContain("clear");
    const right = aim(t, 0, "clear");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(b.measure.clear).toHaveBeenCalled();
    // Turned on, then off again: the hover highlight is cleared.
    aim(t, 0, "measure");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    right.matrix.makeTranslation(0.3, 1.6, 0);
    t.frame(16);
    expect(t.host.setHoverAtoms).toHaveBeenLastCalledWith([7]);
    aim(t, 0, "measure");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(t.host.setHoverAtoms).toHaveBeenLastCalledWith(null);
    // A measurement whose atoms are gone shows no readout.
    t.host.getAtomPosition.mockReturnValue(false);
    t.frame(32);
    expect(label.visible).toBe(false);
  });

  it("drops the measure mode when the page withdraws it, and on session end", async () => {
    const { t } = measuring();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const right = aim(t, 0, "measure");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(t.controller.getState().measuring).toBe(true);
    t.controller.setBridge({});
    expect(t.controller.getState().measuring).toBe(false);
    t.frame(16);
    expect(t.controller.getState().panel).toEqual(["reset", "exit"]);
    await t.controller.exit();
    expect(t.controller.getState().measuring).toBe(false);
  });
});

describe("XRSessionController scene", () => {
  it("lights the meshes from the head and puts the lights back", async () => {
    const t = setup();
    const key = new THREE.DirectionalLight();
    key.position.set(50, 50, 50);
    t.scene.add(key);
    await t.controller.enter("immersive-vr");
    const rig = t.scene.getObjectByName("megane-xr-rig")!;
    expect(key.parent).toBe(rig);
    t.frame(0);
    // Head looking down −z: the light comes from the viewer's side.
    expect(key.position.z).toBeGreaterThan(0);
    expect(key.position.length()).toBeCloseTo(1, 9);
    await t.controller.exit();
    expect(key.parent).toBe(t.scene);
    expect(key.position.toArray()).toEqual([50, 50, 50]);
  });

  it("sizes fat lines by the eye they are drawn into", async () => {
    const t = setup();
    const material = Object.assign(new THREE.MeshBasicMaterial(), {
      isLineMaterial: true,
      resolution: new THREE.Vector2(800, 600),
    });
    t.scene.add(new THREE.Mesh(new THREE.BufferGeometry(), material));
    await t.controller.enter("immersive-vr");
    t.frame(0);
    expect(material.resolution.toArray()).toEqual([1600, 1000]);
    // Before three reports a viewport, a Quest-class eye is assumed.
    t.xr.eyes[0].viewport = new THREE.Vector4(0, 0, 0, 0);
    t.frame(16);
    expect(material.resolution.x).toBeGreaterThan(1000);
  });

  it("shows atom labels near the head once it is tracked", async () => {
    const t = setup();
    t.host.getLabels.mockReturnValue({
      labels: ["N", "CA"],
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      count: 2,
    });
    await t.controller.enter("immersive-vr");
    t.frame(0, null);
    expect(t.controller.getState().labels).toBe(0);
    t.frame(16);
    expect(t.controller.getState().labels).toBe(2);
    expect(t.scene.getObjectByName("megane-xr-labels")!.children).toHaveLength(2);
    await t.controller.exit();
    expect(t.scene.getObjectByName("megane-xr-labels")).toBeUndefined();
    expect(t.controller.getState().labels).toBe(0);
  });

  it("frees the panel, labels and rays on dispose", async () => {
    const t = setup();
    await t.controller.enter("immersive-vr");
    t.frame(0);
    const panel = t.scene.getObjectByName("megane-xr-panel") as THREE.Mesh;
    const dispose = vi.spyOn(panel.geometry, "dispose");
    t.controller.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});

describe("XRSessionController editing", () => {
  /** An editing page: one tool, one action; presses carry the structure unless told otherwise. */
  function editBridge(over: Record<string, unknown> = {}) {
    const panel: XREditPanel = {
      title: "Add atom",
      rows: [[{ id: "tool:add", label: "Add atom", active: true }]],
      actions: [{ id: "undo", label: "Undo" }],
    };
    return {
      panel: vi.fn(() => panel),
      press: vi.fn(),
      pressAction: vi.fn((): XRPressAction => "grab"),
      hover: vi.fn((): XRHighlight | null => null),
      spaceCursor: vi.fn((): number | null => null),
      click: vi.fn(),
      dragStart: vi.fn(() => true),
      dragMove: vi.fn(),
      dragEnd: vi.fn(),
      ...over,
    };
  }

  /** A session with an editing page; the structure's centre lands at (0, 1.5, −1.1). */
  async function editing(over: Record<string, unknown> = {}) {
    const t = setup();
    const edit = editBridge(over);
    t.controller.setBridge({ edit });
    await t.controller.enter("immersive-vr");
    t.frame(0);
    return { t, edit };
  }

  const atom = (index: number) => ({ atomIndex: index, distance: 30, position: [1, 2, 3] });
  const parts = (space: THREE.Object3D) => ({
    line: space.children[1] as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>,
    tip: space.children[2] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
  });

  it("shows the page's controls on the panel and hands their presses back", async () => {
    const { t, edit } = await editing();
    expect(t.controller.getState()).toMatchObject({ editing: true, dragging: false });
    expect(t.controller.getState().panel).toEqual(["edit:tool:add", "edit:undo", "reset", "exit"]);
    const right = aim(t, 0, "edit:undo");
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(edit.press).toHaveBeenCalledWith("undo");
    // A press on the panel is not a click on the structure.
    expect(edit.click).not.toHaveBeenCalled();
  });

  it("clicks the atom a pinch let go where it began, putting the structure back", async () => {
    const { t, edit } = await editing();
    t.host.pickAtom.mockReturnValue(atom(4));
    const placed = t.controller.getState().position;
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    right.dispatchEvent({ type: "selectstart" });
    // A few millimetres of jitter carry the structure while the pinch is held…
    right.matrix.makeTranslation(0.004, 1.5, -0.5);
    t.frame(16);
    expect(t.controller.getState().position[0]).toBeCloseTo(placed[0] + 0.004, 9);
    right.dispatchEvent({ type: "selectend" });
    expect(edit.click).toHaveBeenCalledWith(4, null);
    // …and the click puts it back exactly.
    t.frame(32);
    expect(t.controller.getState().position).toEqual(placed);
  });

  it("clicks empty space at the ray's point nearest the structure's centre", async () => {
    const { t, edit } = await editing();
    const right = track(t.xr, 0, v(0.05, 1.5, -0.5));
    t.scene.updateMatrix();
    const toStructure = t.scene.matrix.clone().invert();
    right.dispatchEvent({ type: "selectstart" });
    right.dispatchEvent({ type: "selectend" });
    expect(edit.click).toHaveBeenCalledTimes(1);
    const [index, point] = edit.click.mock.calls[0];
    expect(index).toBeNull();
    const expected = v(0.05, 1.5, -1.1).applyMatrix4(toStructure);
    for (let i = 0; i < 3; i++) expect(point[i]).toBeCloseTo(expected.getComponent(i), 6);
  });

  it("carries the structure with a press that moves, clicking nothing", async () => {
    const { t, edit } = await editing();
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    const placed = t.controller.getState().position;
    right.dispatchEvent({ type: "selectstart" });
    right.matrix.makeTranslation(0.1, 1.5, -0.5);
    t.frame(16);
    right.dispatchEvent({ type: "selectend" });
    expect(edit.click).not.toHaveBeenCalled();
    expect(t.controller.getState().position[0] - placed[0]).toBeCloseTo(0.1, 9);
  });

  it("scales with two hands, neither press a click", async () => {
    const { t, edit } = await editing();
    const right = track(t.xr, 0, v(0.1, 1.5, -0.5));
    const left = track(t.xr, 1, v(-0.1, 1.5, -0.5));
    right.dispatchEvent({ type: "selectstart" });
    left.dispatchEvent({ type: "selectstart" });
    left.dispatchEvent({ type: "selectend" });
    right.dispatchEvent({ type: "selectend" });
    expect(edit.click).not.toHaveBeenCalled();
  });

  it("drags the atoms the page lets it, rigidly with the hand", async () => {
    const { t, edit } = await editing({ pressAction: vi.fn((): XRPressAction => "drag") });
    t.host.pickAtom.mockReturnValue(atom(4));
    t.host.getAtomPosition.mockImplementation((i: number, out: THREE.Vector3) => {
      out.set(2, 0, 0);
      return i === 4;
    });
    const placed = t.controller.getState().position;
    const scale = t.controller.getState().scale;
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    right.dispatchEvent({ type: "selectstart" });
    // Still inside the click slop: nothing is dragged yet.
    t.frame(16);
    expect(edit.dragStart).not.toHaveBeenCalled();
    right.matrix.makeTranslation(0.05, 1.5, -0.5);
    t.frame(32);
    expect(edit.dragStart).toHaveBeenCalledWith(4);
    expect(t.controller.getState().dragging).toBe(true);
    const motion = edit.dragMove.mock.calls[0][0];
    expect(motion.pivot.toArray()).toEqual([2, 0, 0]);
    expect(motion.translation.x).toBeCloseTo(0.05 / scale, 6);
    expect(motion.translation.y).toBeCloseTo(0, 6);
    // The structure stays where it was; a still hand sends nothing new.
    expect(t.controller.getState().position).toEqual(placed);
    t.frame(48);
    expect(edit.dragMove).toHaveBeenCalledTimes(1);
    // The ray stays on the dragged atom, drawn where it is now.
    const { line } = parts(right);
    expect(line.visible).toBe(true);
    t.scene.updateMatrix();
    const at = v(2, 0, 0).applyMatrix4(t.scene.matrix);
    expect(line.scale.z).toBeCloseTo(-(at.z + 0.5), 6);
    right.dispatchEvent({ type: "selectend" });
    expect(edit.dragEnd).toHaveBeenCalledTimes(1);
    expect(edit.click).not.toHaveBeenCalled();
    expect(t.controller.getState().dragging).toBe(false);
  });

  it("clicks an atom a drag press let go of where it began", async () => {
    const { t, edit } = await editing({ pressAction: vi.fn((): XRPressAction => "drag") });
    t.host.pickAtom.mockReturnValue(atom(4));
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    right.dispatchEvent({ type: "selectstart" });
    t.frame(16);
    right.dispatchEvent({ type: "selectend" });
    expect(edit.click).toHaveBeenCalledWith(4, null);
    expect(edit.dragStart).not.toHaveBeenCalled();
    expect(edit.dragEnd).not.toHaveBeenCalled();
  });

  it("does nothing more with a drag the page refuses, and pivots on the hit without the atom", async () => {
    const { t, edit } = await editing({
      pressAction: vi.fn((): XRPressAction => "drag"),
      dragStart: vi.fn(() => false),
    });
    t.host.pickAtom.mockReturnValue(atom(4));
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    right.dispatchEvent({ type: "selectstart" });
    right.matrix.makeTranslation(0.05, 1.5, -0.5);
    t.frame(16);
    expect(edit.dragStart).toHaveBeenCalledTimes(1);
    t.frame(32);
    right.dispatchEvent({ type: "selectend" });
    expect(edit.dragMove).not.toHaveBeenCalled();
    expect(edit.dragEnd).not.toHaveBeenCalled();
    expect(edit.click).not.toHaveBeenCalled();
  });

  it("lets a second hand only carry while the first drags", async () => {
    const pressAction = vi.fn((): XRPressAction => "drag");
    const { t, edit } = await editing({ pressAction });
    t.host.pickAtom.mockReturnValue(atom(4));
    t.host.getAtomPosition.mockImplementation((_i: number, out: THREE.Vector3) => {
      out.set(0, 0, 0);
      return true;
    });
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    right.dispatchEvent({ type: "selectstart" });
    right.matrix.makeTranslation(0.05, 1.5, -0.5);
    t.frame(16);
    expect(t.controller.getState().dragging).toBe(true);
    const left = track(t.xr, 1, v(-0.2, 1.5, -0.5));
    const placed = t.controller.getState().position;
    left.dispatchEvent({ type: "selectstart" });
    left.dispatchEvent({ type: "selectend" });
    // On an atom too, the second press neither drags nor clicks.
    expect(pressAction).toHaveBeenCalledTimes(1);
    expect(edit.click).not.toHaveBeenCalled();
    // It carries the structure; the dragged atoms follow the hand all the same.
    left.dispatchEvent({ type: "selectstart" });
    left.matrix.makeTranslation(-0.1, 1.5, -0.5);
    t.frame(32);
    expect(t.controller.getState().position[0] - placed[0]).toBeCloseTo(0.1, 9);
    expect(edit.dragMove).toHaveBeenCalledTimes(2);
    const motion = edit.dragMove.mock.calls[1][0];
    // Held still in the room while the structure moved 10 cm under it.
    t.scene.updateMatrix();
    const now = motion.pivot.clone().add(motion.translation).applyMatrix4(t.scene.matrix);
    expect(now.x).toBeCloseTo(0.05, 6);
  });

  it("ends a drag when the hand is lost, the page stops editing, or the session ends", async () => {
    const drag = async (t: ReturnType<typeof setup>) => {
      const right = track(t.xr, 0, v(0, 1.5, -0.5));
      right.dispatchEvent({ type: "selectstart" });
      right.matrix.makeTranslation(0.05, 1.5, -0.5);
      t.frame(16);
      expect(t.controller.getState().dragging).toBe(true);
      return right;
    };
    const over = { pressAction: vi.fn((): XRPressAction => "drag") };

    const a = await editing(over);
    a.t.host.pickAtom.mockReturnValue(atom(4));
    const right = await drag(a.t);
    right.dispatchEvent({ type: "disconnected" });
    expect(a.edit.dragEnd).toHaveBeenCalledTimes(1);
    expect(a.t.controller.getState().dragging).toBe(false);

    const b = await editing(over);
    b.t.host.pickAtom.mockReturnValue(atom(4));
    await drag(b.t);
    b.t.controller.setBridge({});
    expect(b.edit.dragEnd).toHaveBeenCalledTimes(1);
    expect(b.t.controller.getState().dragging).toBe(false);

    const c = await editing(over);
    c.t.host.pickAtom.mockReturnValue(atom(4));
    await drag(c.t);
    // The same page again keeps the drag going.
    c.t.controller.setBridge({ edit: c.edit });
    expect(c.edit.dragEnd).not.toHaveBeenCalled();
    await c.t.controller.exit();
    expect(c.edit.dragEnd).toHaveBeenCalledTimes(1);
  });

  it("lights what a click would act on in the page's colours", async () => {
    const hover = vi.fn((): XRHighlight | null => ({ atoms: [4, 5], color: 0xef4444 }));
    const { t } = await editing({ hover });
    t.host.pickAtom.mockReturnValue(atom(4));
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    t.frame(16);
    expect(hover).toHaveBeenCalledWith(4);
    expect(t.host.setHoverAtoms).toHaveBeenLastCalledWith([4, 5], 0xef4444);
    const { line, tip } = parts(right);
    expect(line.visible).toBe(true);
    expect(line.material.color.getHex()).toBe(0xef4444);
    expect(tip.material.color.getHex()).toBe(0xef4444);
    // An atom a click would do nothing to: the ray reaches it, nothing is lit.
    hover.mockReturnValue(null);
    t.frame(32);
    expect(t.host.setHoverAtoms).toHaveBeenLastCalledWith(null);
    expect(line.visible).toBe(true);
    expect(line.material.color.getHex()).not.toBe(0xef4444);
  });

  it("shows where a click on empty space puts something, and no ray where it puts nothing", async () => {
    const spaceCursor = vi.fn((): number | null => 0x8b5cf6);
    const { t } = await editing({ spaceCursor });
    const right = track(t.xr, 0, v(0, 1.5, -0.5));
    t.frame(16);
    const { line, tip } = parts(right);
    expect(line.visible).toBe(true);
    // From the hand to the structure's centre plane, 60 cm ahead.
    expect(line.scale.z).toBeCloseTo(0.6, 6);
    expect(tip.material.color.getHex()).toBe(0x8b5cf6);
    spaceCursor.mockReturnValue(null);
    t.frame(32);
    expect(line.visible).toBe(false);
  });

  it("aims the E2E probe at a point of the structure from the head's side", async () => {
    const t = setup();
    expect(t.controller.aimPose(v(0, 0, 0))).toBeNull();
    await t.controller.enter("immersive-vr");
    expect(t.controller.aimPose(v(0, 0, 0))).toBeNull();
    t.frame(0);
    const pose = t.controller.aimPose(v(0, 0, 0))!;
    t.scene.updateMatrix();
    const target = v(0, 0, 0).applyMatrix4(t.scene.matrix);
    const from = v(...pose.position);
    expect(from.distanceTo(target)).toBeCloseTo(0.3, 6);
    const ray = new THREE.Ray(
      from,
      v(0, 0, -1).applyQuaternion(new THREE.Quaternion(...pose.quaternion)),
    );
    expect(ray.distanceToPoint(target)).toBeCloseTo(0, 6);
    // Toward the head.
    expect(from.distanceTo(v(0, 1.6, 0))).toBeLessThan(target.distanceTo(v(0, 1.6, 0)));
  });
});
