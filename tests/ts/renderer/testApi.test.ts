/**
 * The renderer's E2E test hooks (`window.__megane_test`,
 * `window.__megane_test_ready`). Test mode is captured when testApi.ts loads,
 * so the flag is set before the dynamic import.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { MeganeTestApi, TestApiRenderer } from "@/renderer/testApi";

(globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
const { isMeganeTestMode, setActiveRenderer, releaseActiveRenderer, getTestReady, signalRender } =
  await import("@/renderer/testApi");

type TestWindow = Window & {
  __megane_test?: MeganeTestApi;
  __megane_test_ready?: { firstFrame: boolean; renderEpoch: number };
};
const w = window as TestWindow;

function fakeRenderer(): TestApiRenderer {
  return {
    testGetProjectedAtomPositions: vi.fn(() => [{ index: 0, sx: 1, sy: 2, depth: 3, element: 6 }]),
    testGetCameraState: vi.fn(() => ({
      mode: "orthographic" as const,
      position: [0, 0, 1] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      zoom: 1,
    })),
    testGetVisibleSubsystems: vi.fn(() => ({
      atoms: true,
      bonds: true,
      cell: false,
      cellAxes: false,
      vectors: false,
      labels: true,
      polyhedra: false,
      cartoon: false,
      surface: false,
      line: false,
    })),
    setCameraMode: vi.fn(),
    resetCamera: vi.fn(),
    alignCameraToAxis: vi.fn(),
    getRenderer: vi.fn(
      () =>
        ({ info: { memory: { geometries: 7, textures: 2 } } }) as unknown as ReturnType<
          TestApiRenderer["getRenderer"]
        >,
    ),
    getXRState: vi.fn(() => ({
      presenting: true,
      mode: "immersive-vr" as const,
      frames: 3,
      scale: 0.01,
      position: [0, 1.5, -0.7] as [number, number, number],
    })),
  };
}

afterEach(() => {
  setActiveRenderer(null);
});

describe("testApi", () => {
  it("detects test mode from __MEGANE_TEST__", () => {
    expect(isMeganeTestMode()).toBe(true);
  });

  it("installs window.__megane_test bound to the active renderer", () => {
    const r = fakeRenderer();
    setActiveRenderer(r);
    const api = w.__megane_test!;
    expect(api.getProjectedAtomPositions()).toHaveLength(1);
    expect(api.getCameraState()?.mode).toBe("orthographic");
    expect(api.getVisibleSubsystems().atoms).toBe(true);
    expect(api.getRendererMemory()).toEqual({ geometries: 7, textures: 2 });
    expect(api.getXRState()).toMatchObject({ presenting: true, mode: "immersive-vr", frames: 3 });
    api.setCameraMode("perspective");
    api.resetCamera();
    api.alignCamera("+a");
    expect(r.setCameraMode).toHaveBeenCalledWith("perspective");
    expect(r.resetCamera).toHaveBeenCalledTimes(1);
    expect(r.alignCameraToAxis).toHaveBeenCalledWith("+a");
  });

  it("forwards to the most recently mounted renderer", () => {
    const a = fakeRenderer();
    const b = fakeRenderer();
    setActiveRenderer(a);
    const api = w.__megane_test!;
    setActiveRenderer(b);
    expect(w.__megane_test).toBe(api);
    api.resetCamera();
    expect(b.resetCamera).toHaveBeenCalledTimes(1);
    expect(a.resetCamera).not.toHaveBeenCalled();
  });

  it("falls back to empty answers when the bound renderer is gone", () => {
    const r = fakeRenderer();
    setActiveRenderer(r);
    const api = w.__megane_test!;
    // A stale reference held by a spec after the renderer was released.
    releaseActiveRenderer(r);
    expect(w.__megane_test).toBeUndefined();
    expect(api.getProjectedAtomPositions()).toEqual([]);
    expect(api.getCameraState()).toBeNull();
    expect(Object.values(api.getVisibleSubsystems()).every((v) => v === false)).toBe(true);
    expect(api.getRendererMemory()).toBeNull();
    expect(api.getXRState()).toBeNull();
    expect(() => api.setCameraMode("orthographic")).not.toThrow();
    expect(() => api.resetCamera()).not.toThrow();
    expect(() => api.alignCamera("+x")).not.toThrow();
  });

  it("releaseActiveRenderer ignores a renderer that is not the active one", () => {
    const a = fakeRenderer();
    setActiveRenderer(a);
    releaseActiveRenderer(fakeRenderer());
    expect(w.__megane_test).toBeDefined();
  });

  it("signalRender bumps the render epoch only once a structure is on screen", () => {
    const ready = getTestReady()!;
    expect(getTestReady()).toBe(ready);
    const epoch = ready.renderEpoch;
    signalRender(false);
    expect(ready.renderEpoch).toBe(epoch);
    signalRender(true);
    expect(ready.firstFrame).toBe(true);
    expect(ready.renderEpoch).toBe(epoch + 1);
    expect(w.__megane_test_ready).toBe(ready);
  });
});
