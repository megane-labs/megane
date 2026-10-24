import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

/**
 * The renderer's side of the immersive view: it delegates the session to
 * XRSessionController and, when the session starts or ends, hands the frame
 * loop over and hides / restores the desktop-only pivot marker. mount() needs
 * WebGL, so — as in the other MoleculeRenderer tests — the fields these paths
 * touch are stubbed in.
 */
function renderer() {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  const camera = new THREE.PerspectiveCamera();
  internals.container = { clientWidth: 100, clientHeight: 50 };
  internals.cameraController = {
    camera,
    tick: vi.fn(),
    resize: vi.fn(),
    controls: { handleResize: vi.fn() },
  };
  internals.renderer = {
    render: vi.fn(),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    getSize: (v: THREE.Vector2) => v.set(10, 10),
    getPixelRatio: () => 1,
  };
  internals.fpsCounter = { tick: vi.fn() };
  const pivot = { visible: true };
  internals.pivotMarker = {
    isVisible: () => pivot.visible,
    setVisible: vi.fn((visible: boolean) => {
      pivot.visible = visible;
    }),
    update: vi.fn(),
  };
  const xr = {
    presenting: false,
    enter: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    getState: vi.fn(() => ({ presenting: false })),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
  internals.xr = xr;
  return { r, internals, xr, pivot };
}

describe("MoleculeRenderer immersive view", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 42),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates enter / exit / state / subscribe to the session controller", async () => {
    const { r, xr } = renderer();
    await r.enterXR("immersive-ar");
    expect(xr.enter).toHaveBeenCalledWith("immersive-ar");
    await r.exitXR();
    expect(xr.exit).toHaveBeenCalled();
    expect(r.getXRState()).toEqual({ presenting: false });
    const listener = vi.fn();
    r.onXRStateChange(listener);
    expect(xr.subscribe).toHaveBeenCalledWith(listener);
  });

  it("stops the desktop loop and hides the pivot marker while presenting", () => {
    const { internals, pivot } = renderer();
    internals.animationId = 7;
    internals.onXRPresentingChange(true);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(internals.animationId).toBeNull();
    expect(pivot.visible).toBe(false);
    // Without a running loop (or a pivot marker) there is nothing to stop.
    vi.mocked(cancelAnimationFrame).mockClear();
    internals.pivotMarker = null;
    internals.onXRPresentingChange(true);
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("restores the pivot marker and restarts the desktop loop afterwards", () => {
    const { internals, pivot } = renderer();
    internals.onXRPresentingChange(true);
    internals.onXRPresentingChange(false);
    expect(pivot.visible).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalled();
    expect(internals.animationId).toBe(42);
    // The first desktop frame re-syncs the canvas to the container.
    expect(internals.lastContainerW).toBe(100);
    expect(internals.renderer.setSize).toHaveBeenCalledWith(100, 50, false);
  });

  it("leaves a hidden pivot marker hidden", () => {
    const { internals, pivot } = renderer();
    pivot.visible = false;
    internals.onXRPresentingChange(true);
    internals.onXRPresentingChange(false);
    expect(pivot.visible).toBe(false);
  });

  it("does not resize the canvas while the headset owns it", () => {
    const { internals, xr } = renderer();
    xr.presenting = true;
    internals.onResize();
    expect(internals.renderer.setSize).not.toHaveBeenCalled();
  });

  it("places what is on screen: the current frame's bounding sphere", () => {
    const { internals } = renderer();
    expect(internals.xrFocus().radius).toBe(10);
    internals.snapshot = { nAtoms: 2, positions: new Float32Array([0, 0, 0, 0, 0, 0]) };
    internals.currentPositions = new Float32Array([0, 0, 0, 4, 0, 0]);
    const focus = internals.xrFocus();
    expect(focus.center.toArray()).toEqual([2, 0, 0]);
    expect(focus.radius).toBeCloseTo(2 + 2, 9);
  });

  it("places an empty cell by its corners, so building starts in its middle", () => {
    const { internals } = renderer();
    internals.snapshot = {
      nAtoms: 0,
      positions: new Float32Array(0),
      box: new Float32Array([10, 0, 0, 0, 8, 0, 0, 0, 6]),
      boxOrigin: new Float32Array([1, 1, 1]),
    };
    internals.currentPositions = new Float32Array(0);
    const focus = internals.xrFocus();
    expect(focus.center.toArray()).toEqual([6, 5, 4]);
    expect(focus.radius).toBeCloseTo(Math.hypot(10, 8, 6) / 2 + 2, 6);
    // Without an origin the cell starts at 0.
    internals.snapshot.boxOrigin = null;
    expect(internals.xrFocus().center.toArray()).toEqual([5, 4, 3]);
  });

  it("wires a real session controller to its own scene and camera", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const gl = {};
    internals.scene = scene;
    internals.renderer = gl;
    internals.cameraController = { camera };
    const host = internals.xr.host;
    expect(host.getRenderer()).toBe(gl);
    expect(host.getScene()).toBe(scene);
    expect(host.getViewCamera()).toBe(camera);
    expect(host.getFocus().radius).toBe(10);
    const change = vi.spyOn(internals, "onXRPresentingChange").mockImplementation(() => {});
    host.onPresentingChange(true);
    expect(change).toHaveBeenCalledWith(true);
  });

  it("answers the session's picking, measurement and label questions", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    const selection = {
      pickOnRay: vi.fn(() => ({ atomIndex: 1, distance: 2, position: [0, 0, 0] })),
      setHover: vi.fn(),
      selected: [1, 0],
      getMeasurement: vi.fn(() => ({ atoms: [1, 0], type: "distance", value: 4, label: "4 Å" })),
    };
    internals.selection = selection;
    const data = { labels: ["A"], positions: new Float32Array(3), count: 1 };
    internals.labelOverlay = { getData: () => data };
    internals.snapshot = { nAtoms: 2, positions: new Float32Array(6) };
    internals.currentPositions = new Float32Array([0, 0, 0, 4, 5, 6]);
    const host = internals.xr.host;
    const ray = new THREE.Ray();
    expect(host.pickAtom(ray, 0.5).atomIndex).toBe(1);
    expect(selection.pickOnRay).toHaveBeenCalledWith(ray, 0.5);
    host.setHoverAtoms([3]);
    expect(selection.setHover).toHaveBeenCalledWith([3], undefined);
    // An editing page lights atoms in its own colours.
    host.setHoverAtoms([2], 0xef4444);
    expect(selection.setHover).toHaveBeenLastCalledWith([2], 0xef4444);
    expect(host.getSelectedAtoms()).toEqual([1, 0]);
    expect(host.getMeasurement().label).toBe("4 Å");
    expect(host.getLabels()).toBe(data);
    const out = new THREE.Vector3();
    expect(host.getAtomPosition(1, out)).toBe(true);
    expect(out.toArray()).toEqual([4, 5, 6]);
    expect(host.getAtomPosition(2, out)).toBe(false);
    expect(host.getAtomPosition(-1, out)).toBe(false);
    internals.snapshot = null;
    internals.labelOverlay = null;
    expect(host.getAtomPosition(0, out)).toBe(false);
    expect(host.getLabels()).toBeNull();
  });

  it("forwards the page bridge and the panel probe to the session controller", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    const setBridge = vi.spyOn(internals.xr, "setBridge");
    const bridge = { playback: undefined };
    r.setXRBridge(bridge);
    expect(setBridge).toHaveBeenCalledWith(bridge);
    // Outside a session the panel has nothing to point at.
    expect(r.testGetXRPanelControlPose("exit")).toBeNull();
  });

  it("aims the E2E probe at a drawn atom or at a point of the structure", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    const aim = vi
      .spyOn(internals.xr, "aimPose")
      .mockImplementation((p) => ({
        position: (p as THREE.Vector3).toArray(),
        quaternion: [0, 0, 0, 1],
      }));
    internals.snapshot = { nAtoms: 2, positions: new Float32Array(6) };
    internals.currentPositions = new Float32Array([0, 0, 0, 4, 5, 6]);
    expect(r.testGetXRAimPose(1)?.position).toEqual([4, 5, 6]);
    expect(r.testGetXRAimPose([1, 2, 3])?.position).toEqual([1, 2, 3]);
    // No such atom: nothing to aim at.
    expect(r.testGetXRAimPose(5)).toBeNull();
    expect(aim).toHaveBeenCalledTimes(2);
  });

  it("ends the session on dispose", () => {
    const { r, xr, internals } = renderer();
    internals.atomLayers = { dispose: vi.fn() };
    internals.selection = { clear: vi.fn() };
    internals.clearSelection = vi.fn();
    internals.cameraController.dispose = vi.fn();
    internals.renderer.dispose = vi.fn();
    internals.renderer.domElement = { parentNode: null, removeEventListener: vi.fn() };
    internals.pivotMarker.dispose = vi.fn();
    r.dispose();
    expect(xr.dispose).toHaveBeenCalled();
  });
});
