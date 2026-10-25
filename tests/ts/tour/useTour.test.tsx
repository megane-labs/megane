import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// Mock the driver.js-backed tour controller so we don't pull driver into jsdom.
vi.mock("@/tour/MeganeTour", () => ({
  startTour: vi.fn(),
  stopTour: vi.fn(),
}));

import { useTour } from "@/tour/useTour";
import { startTour, stopTour } from "@/tour/MeganeTour";
import { useTourStore } from "@/tour/tourStore";

const mockStartTour = vi.mocked(startTour);
const mockStopTour = vi.mocked(stopTour);

describe("useTour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStartTour.mockReset();
    mockStopTour.mockReset();
    useTourStore.setState({
      host: "webapp",
      isActive: false,
      dontShowAgain: false,
      autoStartHandled: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("syncs the host into the store", () => {
    renderHook(() => useTour({ host: "vscode" }));
    expect(useTourStore.getState().host).toBe("vscode");
  });

  it("auto-starts on webapp when dontShowAgain=false", async () => {
    renderHook(() => useTour({ host: "webapp", autoStartDelayMs: 100 }));
    expect(mockStartTour).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    // The tour controller is loaded on first use.
    await vi.dynamicImportSettled();
    expect(mockStartTour).toHaveBeenCalledTimes(1);
    expect(useTourStore.getState().autoStartHandled).toBe(true);
  });

  it("does not auto-start on ipywidget host", () => {
    renderHook(() => useTour({ host: "ipywidget", autoStartDelayMs: 100 }));
    vi.advanceTimersByTime(1000);
    expect(mockStartTour).not.toHaveBeenCalled();
    expect(useTourStore.getState().autoStartHandled).toBe(true);
  });

  it("does not auto-start when __MEGANE_TEST__ is set", () => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    try {
      renderHook(() => useTour({ host: "webapp", autoStartDelayMs: 100 }));
      vi.advanceTimersByTime(1000);
      expect(mockStartTour).not.toHaveBeenCalled();
      expect(useTourStore.getState().autoStartHandled).toBe(true);
    } finally {
      delete (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__;
    }
  });

  it("does not auto-start when dontShowAgain is true", () => {
    useTourStore.setState({ dontShowAgain: true });
    renderHook(() => useTour({ host: "webapp", autoStartDelayMs: 100 }));
    vi.advanceTimersByTime(1000);
    expect(mockStartTour).not.toHaveBeenCalled();
    expect(useTourStore.getState().autoStartHandled).toBe(true);
  });

  it("skips auto-start when autoStartHandled is already true (subsequent mount)", () => {
    useTourStore.setState({ autoStartHandled: true });
    renderHook(() => useTour({ host: "webapp", autoStartDelayMs: 100 }));
    vi.advanceTimersByTime(1000);
    expect(mockStartTour).not.toHaveBeenCalled();
  });

  it("stops a running tour on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useTour({ host: "webapp", autoStartDelayMs: 100 }),
    );
    result.current.startTour();
    await vi.dynamicImportSettled();
    unmount();
    await vi.dynamicImportSettled();
    expect(mockStopTour).toHaveBeenCalled();
  });

  it("returns a startTour callback that triggers the controller", async () => {
    useTourStore.setState({ dontShowAgain: true });
    const { result } = renderHook(() => useTour({ host: "webapp", autoStartDelayMs: 100 }));
    vi.advanceTimersByTime(100);
    expect(mockStartTour).not.toHaveBeenCalled();

    result.current.startTour();
    await vi.dynamicImportSettled();
    expect(mockStartTour).toHaveBeenCalledTimes(1);
  });
});
