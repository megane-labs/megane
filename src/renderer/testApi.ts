/**
 * E2E test hooks for the renderer.
 *
 * Playwright specs observe the viewer through two window globals that exist
 * only in test mode (`?test=1`, `globalThis.__MEGANE_TEST__`, or an iframed
 * host inheriting it from the parent):
 *
 * - `window.__megane_test_ready` — render / load / frame counters capture
 *   helpers wait on before a screenshot;
 * - `window.__megane_test` — read-only probes (projected atoms, camera state,
 *   subsystem visibility, GPU memory) and a few deterministic camera actions,
 *   bound to the most recently mounted renderer.
 *
 * Outside test mode every function here is a no-op.
 */

import type * as THREE from "three";
import type { MeganeCameraMode, MeganeCameraState } from "./CameraController";
import type { MeganeProjectedAtom } from "./SelectionController";
import type { ViewAxis } from "./cameraOrientation";
import type { MeganeXRState } from "./xr/XRSessionController";
import type { XRPanelControl } from "./xr/XRPanel";

const _testMode = (() => {
  try {
    const g = globalThis as { __MEGANE_TEST__?: boolean };
    if (g.__MEGANE_TEST__) return true;
    if (typeof window !== "undefined" && window.location?.search) {
      const p = new URLSearchParams(window.location.search);
      if (p.get("test") === "1") return true;
    }
    // E2E hosts (notably ms-toolsai.jupyter widget output and the
    // VSCode webview) render the megane bundle inside a nested iframe
    // that the test runner can only reach via Page.addInitScript on the
    // outer page. Inherit the flag from the parent window when the same
    // origin allows it. Cross-origin access throws; we silently fall
    // back to false.
    if (typeof window !== "undefined" && window.parent && window.parent !== window) {
      const pg = (window.parent as Window & { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__;
      if (pg) return true;
    }
  } catch {
    /* noop */
  }
  return false;
})();

/**
 * True when running under E2E (via `?test=1`, `__MEGANE_TEST__`, or an iframed
 * host inheriting it from the parent). Consumers use this to keep non-
 * deterministic UI (e.g. the live FPS readout) stable for screenshot baselines.
 */
export function isMeganeTestMode(): boolean {
  return _testMode;
}

interface MeganeTestReady {
  firstFrame: boolean;
  dataLoaded: boolean;
  frame: number;
  /**
   * Animation frames at which the canvas showed a structure and was current:
   * redrawn that frame, or unchanged since the last redraw (the renderer draws
   * on demand). Waiting for it to pass a value read before an interaction
   * therefore waits until every change requested up to then is on screen.
   */
  renderEpoch: number;
  atomCount?: number;
  /**
   * Count of trajectory frames applied via updateFrame(). E2E capture
   * helpers gate on `framesApplied >= 1` before screenshotting a
   * multi-frame structure: lazily decoded trajectories (XTC worker) apply
   * frame 0 asynchronously after load, so without the gate a capture races
   * the decode and lands on either the base snapshot or the frame-0
   * positions nondeterministically.
   */
  framesApplied?: number;
}

export interface MeganeSubsystemVisibility {
  atoms: boolean;
  bonds: boolean;
  cell: boolean;
  cellAxes: boolean;
  vectors: boolean;
  labels: boolean;
  polyhedra: boolean;
  cartoon: boolean;
  surface: boolean;
  line: boolean;
}

export interface MeganeRendererMemory {
  geometries: number;
  textures: number;
}

export interface MeganeTestApi {
  getProjectedAtomPositions: () => MeganeProjectedAtom[];
  getCameraState: () => MeganeCameraState | null;
  getVisibleSubsystems: () => MeganeSubsystemVisibility;
  setCameraMode: (mode: MeganeCameraMode) => void;
  resetCamera: () => void;
  alignCamera: (axis: ViewAxis) => void;
  getRendererMemory: () => MeganeRendererMemory | null;
  /** Immersive (WebXR) session state; null before a renderer mounts. */
  getXRState: () => MeganeXRState | null;
  /**
   * Where an emulated controller must be (reference space) to point at the
   * headset panel's control `id`; null outside a session or without it.
   */
  getXRPanelControlPose: (id: XRPanelControl) => XRControlPose | null;
  /**
   * Where an emulated controller must be to point at atom `target` (a drawn
   * atom's index) or at a point of the structure (Å); null outside a session.
   */
  getXRAimPose: (target: number | [number, number, number]) => XRControlPose | null;
}

/** A controller pose aimed at a headset panel control. */
export interface XRControlPose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/** The renderer methods `window.__megane_test` forwards to. */
export interface TestApiRenderer {
  testGetProjectedAtomPositions(): MeganeProjectedAtom[];
  testGetCameraState(): MeganeCameraState | null;
  testGetVisibleSubsystems(): MeganeSubsystemVisibility;
  setCameraMode(mode: MeganeCameraMode): void;
  resetCamera(): void;
  alignCameraToAxis(axis: ViewAxis): void;
  getRenderer(): THREE.WebGLRenderer;
  getXRState(): MeganeXRState;
  testGetXRPanelControlPose(id: XRPanelControl): XRControlPose | null;
  testGetXRAimPose(target: number | [number, number, number]): XRControlPose | null;
}

let _activeRenderer: TestApiRenderer | null = null;

/**
 * Bind `window.__megane_test` to `r` (the most recently mounted renderer), or
 * remove it with `null`. The renderer is always tracked; the window global is
 * only installed in test mode.
 */
export function setActiveRenderer(r: TestApiRenderer | null): void {
  _activeRenderer = r;
  if (!_testMode || typeof window === "undefined") return;
  const w = window as Window & { __megane_test?: MeganeTestApi };
  if (r === null) {
    delete w.__megane_test;
    return;
  }
  if (!w.__megane_test) {
    w.__megane_test = {
      getProjectedAtomPositions: () =>
        _activeRenderer ? _activeRenderer.testGetProjectedAtomPositions() : [],
      getCameraState: () => (_activeRenderer ? _activeRenderer.testGetCameraState() : null),
      getVisibleSubsystems: () =>
        _activeRenderer
          ? _activeRenderer.testGetVisibleSubsystems()
          : {
              atoms: false,
              bonds: false,
              cell: false,
              cellAxes: false,
              vectors: false,
              labels: false,
              polyhedra: false,
              cartoon: false,
              surface: false,
              line: false,
            },
      setCameraMode: (mode) => _activeRenderer?.setCameraMode(mode),
      resetCamera: () => _activeRenderer?.resetCamera(),
      alignCamera: (axis) => _activeRenderer?.alignCameraToAxis(axis),
      getRendererMemory: () => {
        const info = _activeRenderer?.getRenderer().info.memory;
        return info ? { geometries: info.geometries, textures: info.textures } : null;
      },
      getXRState: () => _activeRenderer?.getXRState() ?? null,
      getXRPanelControlPose: (id) => _activeRenderer?.testGetXRPanelControlPose(id) ?? null,
      getXRAimPose: (target) => _activeRenderer?.testGetXRAimPose(target) ?? null,
    };
  }
}

/** Unbind the test API if `r` is the renderer it is bound to (on dispose). */
export function releaseActiveRenderer(r: TestApiRenderer): void {
  if (_activeRenderer === r) {
    setActiveRenderer(null);
  }
}

/** The `window.__megane_test_ready` record, created on first use; null outside test mode. */
export function getTestReady(): MeganeTestReady | null {
  if (!_testMode) return null;
  if (typeof window === "undefined") return null;
  const w = window as Window & { __megane_test_ready?: MeganeTestReady };
  if (!w.__megane_test_ready) {
    w.__megane_test_ready = {
      firstFrame: false,
      dataLoaded: false,
      frame: 0,
      renderEpoch: 0,
    };
  }
  return w.__megane_test_ready;
}

/** Record an up-to-date frame (only once a structure is on screen); see `renderEpoch`. */
export function signalRender(hasSnapshot: boolean): void {
  const r = getTestReady();
  if (!r || !hasSnapshot) return;
  r.firstFrame = true;
  r.renderEpoch = (r.renderEpoch ?? 0) + 1;
}
