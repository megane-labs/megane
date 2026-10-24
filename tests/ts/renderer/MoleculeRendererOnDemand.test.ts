/**
 * The render loop draws on demand: it redraws when the camera moved or when
 * something asked for a frame (`requestRender`), and otherwise leaves the last
 * frame on the canvas, so an idle viewer costs no GPU or main-thread time.
 *
 * mount() needs WebGL, so — as in the other MoleculeRenderer tests — the
 * fields `animate` touches are stubbed in. Test mode is captured when
 * testApi.ts loads, so the flag is set before the dynamic import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";

(globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
const { MoleculeRenderer } = await import("@/renderer/MoleculeRenderer");

type Camera = THREE.OrthographicCamera | THREE.PerspectiveCamera;

function renderer(camera: Camera = new THREE.PerspectiveCamera()) {
  const r = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = r as any;
  const render = vi.fn();
  internals.container = null;
  internals.cameraController = { camera, tick: vi.fn() };
  internals.renderer = {
    render,
    getSize: (v: THREE.Vector2) => v.set(10, 10),
    getPixelRatio: () => 1,
  };
  const fpsTick = vi.fn();
  internals.fpsCounter = { tick: fpsTick };
  const frame = (t: number) => internals.animate(t);
  return { r, internals, frame, render, camera, fpsTick };
}

type ReadyWindow = Window & { __megane_test_ready?: { renderEpoch: number; firstFrame: boolean } };

describe("MoleculeRenderer on-demand rendering", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws the first frame, then only frames something asked for", () => {
    const { r, frame, render } = renderer();
    frame(0);
    frame(16);
    frame(32);
    expect(render).toHaveBeenCalledTimes(1);
    r.requestRender();
    r.requestRender(); // several requests in one frame draw it once
    frame(48);
    frame(64);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("redraws when the camera moves, turns or zooms", () => {
    const { frame, render, camera } = renderer();
    frame(0);
    camera.position.x += 1;
    frame(16);
    expect(render).toHaveBeenCalledTimes(2);
    camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    frame(32);
    expect(render).toHaveBeenCalledTimes(3);
    camera.zoom = 2;
    frame(48);
    expect(render).toHaveBeenCalledTimes(4);
    frame(64);
    expect(render).toHaveBeenCalledTimes(4);
  });

  it("redraws when only the projection changes (an orthographic frustum pan)", () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1);
    const { frame, render } = renderer(camera);
    frame(0);
    camera.left -= 0.5;
    camera.right -= 0.5;
    camera.updateProjectionMatrix();
    frame(16);
    expect(render).toHaveBeenCalledTimes(2);
    frame(32);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("feeds skipped frames to the FPS counter as not drawn", () => {
    const { frame, fpsTick } = renderer();
    frame(0);
    frame(16);
    expect(fpsTick).toHaveBeenCalledTimes(2);
    expect(fpsTick.mock.calls[0]).toHaveLength(1); // drawn: tick(now)
    expect(fpsTick.mock.calls[1][1]).toBe(false); // skipped
  });

  it("keeps the E2E render epoch ticking while the canvas is current", () => {
    const { internals, frame, render } = renderer();
    internals.snapshot = { nAtoms: 0 };
    const ready = () => (window as ReadyWindow).__megane_test_ready!;
    frame(0);
    const epoch = ready().renderEpoch;
    frame(16);
    frame(32);
    expect(render).toHaveBeenCalledTimes(1);
    expect(ready().firstFrame).toBe(true);
    expect(ready().renderEpoch).toBe(epoch + 2);
  });

  it("asks for a frame after a resize and when the WebGL context comes back", () => {
    const { r, internals, frame, render } = renderer();
    frame(0);
    internals.container = { clientWidth: 100, clientHeight: 50 };
    internals.renderer.setPixelRatio = vi.fn();
    internals.renderer.setSize = vi.fn();
    internals.cameraController.resize = vi.fn();
    internals.cameraController.controls = { handleResize: vi.fn() };
    internals.labelOverlay = null;
    frame(16); // the container size changed under the loop
    expect(internals.renderer.setSize).toHaveBeenCalledWith(100, 50, false);
    expect(render).toHaveBeenCalledTimes(2);
    frame(32);
    expect(render).toHaveBeenCalledTimes(2);
    internals.onContextRestored();
    frame(48);
    expect(render).toHaveBeenCalledTimes(3);
    expect(r).toBeInstanceOf(MoleculeRenderer);
  });

  it("redraws the desktop view when an immersive session ends", () => {
    const { internals, frame, render } = renderer();
    frame(0);
    internals.pivotMarker = null;
    internals.onXRPresentingChange(false);
    expect(render).toHaveBeenCalledTimes(2);
  });

  // Every renderer method that changes what is drawn records a request before
  // doing any work, so even an unmounted renderer (whose sub-renderers are
  // missing and may throw) shows it.
  const box = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);
  const snapshot = {
    nAtoms: 1,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(3),
    elements: new Uint8Array([6]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box,
  };
  const mutators: [string, unknown[]][] = [
    ["loadSnapshot", [snapshot]],
    ["updateFrame", [{ frameId: 1, nAtoms: 1, positions: new Float32Array(3) }]],
    ["updateBonds", [new Uint32Array(0), null]],
    ["updateBondsExt", [new Uint32Array(0), null, null, null, 0]],
    ["setLabels", [["C1"]]],
    ["setDrawingBoundary", [null]],
    ["setBondPeriodicImages", [null]],
    ["setVectors", [null]],
    ["setVectorScale", [2]],
    ["loadPolyhedra", [{}]],
    ["clearPolyhedra", []],
    ["getOrCreateLayer", ["layer"]],
    ["getLayer", ["layer"]],
    ["removeLayer", ["layer"]],
    ["removeInactiveLayers", [new Set()]],
    ["fitToViewAll", []],
    ["setAtomScale", [2]],
    ["setAtomOpacity", [0.5]],
    ["setAtomScaleOverrides", [new Float32Array(1)]],
    ["setAtomOpacityOverrides", [new Float32Array(1)]],
    ["clearAtomOverrides", []],
    ["setBondScale", [2]],
    ["setBondOpacity", [0.5]],
    ["applyAtomColorOverrides", [new Float32Array(3)]],
    ["setBondOpacityOverrides", [new Float32Array(1)]],
    ["clearBondOpacityOverrides", []],
    ["setAtomsVisible", [false]],
    ["setRepresentationType", ["line"]],
    ["setRepresentationByAtom", [null]],
    ["setBondsVisible", [false]],
    ["setCellVisible", [false]],
    ["setCellAxesVisible", [false]],
    ["setPivotMarkerVisible", [true]],
    ["resetView", []],
    ["setRotationCenter", [1, 2, 3]],
    ["resetRotationCenter", []],
    ["setViewInsets", [10, 20]],
    ["setPerspective", [true]],
    ["setBackgroundColor", [0x000000]],
    ["toggleAtomSelection", [0]],
    ["setSelection", [[0]]],
    ["setPreviewSelection", [[0]]],
    ["setHoverHighlight", [[0]]],
    ["setWarningHighlight", [[0]]],
    ["clearSelection", []],
    ["setCameraMode", ["perspective"]],
    ["resetCamera", []],
    ["alignCameraToAxis", ["+x"]],
    ["applyCameraState", [{ mode: "orthographic", position: [0, 0, 1], target: [0, 0, 0] }]],
  ];

  it.each(mutators)("%s asks for a redraw", (name, args) => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals.renderRequested = false;
    try {
      internals[name](...args);
    } catch {
      /* unmounted: the sub-renderer the method goes on to touch is missing */
    }
    expect(internals.renderRequested).toBe(true);
  });

  it("does not redraw for a colour override it already shows", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals.renderRequested = false;
    r.applyAtomColorOverrides(null); // the state it starts in
    expect(internals.renderRequested).toBe(false);
  });

  it("moves the axes inset only while it is being dragged, redrawing it", () => {
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals.renderRequested = false;
    expect(r.moveAxesDrag(5, 5)).toBe(false);
    expect(internals.renderRequested).toBe(false);
    internals.axesDragging = true;
    internals.cellAxesRenderer = { moveBy: vi.fn() };
    internals.container = { clientWidth: 100, clientHeight: 100 };
    expect(r.moveAxesDrag(10, 10)).toBe(true);
    expect(internals.cellAxesRenderer.moveBy).toHaveBeenCalledWith(10, 10, 100, 100);
    expect(internals.renderRequested).toBe(true);
  });
});
