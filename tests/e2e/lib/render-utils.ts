/**
 * Renderer state helpers wrapping `window.__megane_test`.
 *
 * These functions are thin wrappers over `page.evaluate(() =>
 * window.__megane_test.<method>())` so spec code reads naturally and
 * doesn't repeat the same boilerplate. The namespace is registered by
 * MoleculeRenderer.mount() when testMode is detected — see
 * src/renderer/MoleculeRenderer.ts.
 */

import type { Page, Frame } from "playwright/test";
import { waitForReady, getReadyState } from "./setup";

export type Scope = Page | Frame;

export type CameraMode = "perspective" | "orthographic";

/** Signed axis accepted by `alignCamera` (mirrors `ViewAxis` in src). */
export type ViewAxis = `${"+" | "-"}${"a" | "b" | "c" | "x" | "y" | "z"}`;

export interface CameraState {
  mode: CameraMode;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  up?: [number, number, number];
}

export interface ProjectedAtom {
  index: number;
  sx: number;
  sy: number;
  depth: number;
  element: number;
}

export interface SubsystemVisibility {
  atoms: boolean;
  bonds: boolean;
  cell: boolean;
  cellAxes: boolean;
  vectors: boolean;
  labels: boolean;
  polyhedra: boolean;
  line: boolean;
}

interface TestApi {
  getProjectedAtomPositions: () => ProjectedAtom[];
  getCameraState: () => CameraState | null;
  getVisibleSubsystems: () => SubsystemVisibility;
  setCameraMode: (mode: CameraMode) => void;
  resetCamera: () => void;
  alignCamera: (axis: ViewAxis) => void;
}

export async function getProjectedAtoms(scope: Scope): Promise<ProjectedAtom[]> {
  return await scope.evaluate(() => {
    const w = window as Window & { __megane_test?: TestApi };
    if (!w.__megane_test) throw new Error("__megane_test not available; testMode off?");
    return w.__megane_test.getProjectedAtomPositions();
  });
}

export async function getCameraState(scope: Scope): Promise<CameraState | null> {
  return await scope.evaluate(() => {
    const w = window as Window & { __megane_test?: TestApi };
    if (!w.__megane_test) throw new Error("__megane_test not available; testMode off?");
    return w.__megane_test.getCameraState();
  });
}

export async function getVisibleSubsystems(scope: Scope): Promise<SubsystemVisibility> {
  return await scope.evaluate(() => {
    const w = window as Window & { __megane_test?: TestApi };
    if (!w.__megane_test) throw new Error("__megane_test not available; testMode off?");
    return w.__megane_test.getVisibleSubsystems();
  });
}

export async function setCameraMode(scope: Scope, mode: CameraMode): Promise<void> {
  await scope.evaluate((m) => {
    const w = window as Window & { __megane_test?: TestApi };
    w.__megane_test?.setCameraMode(m);
  }, mode);
}

export async function resetCamera(scope: Scope): Promise<void> {
  await scope.evaluate(() => {
    const w = window as Window & { __megane_test?: TestApi };
    w.__megane_test?.resetCamera();
  });
}

/** Turn the camera to look along a crystal / Cartesian axis (issue #661). */
export async function alignCamera(scope: Scope, axis: ViewAxis): Promise<void> {
  await scope.evaluate((a) => {
    const w = window as Window & { __megane_test?: TestApi };
    w.__megane_test?.alignCamera(a);
  }, axis);
}

/**
 * Wait until the renderer's epoch advances at least one tick past the
 * baseline. Useful after firing an interaction that should trigger a
 * re-render.
 */
export async function awaitFrame(scope: Scope, baselineEpoch?: number): Promise<void> {
  const start = baselineEpoch ?? (await getReadyState(scope)).renderEpoch;
  await waitForReady(scope, { untilEpoch: start + 1, timeout: 30_000 });
}
