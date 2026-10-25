import { describe, it, expect, vi } from "vitest";

const tour = vi.hoisted(() => ({
  startTour: vi.fn(),
  startPipelineTutorial: vi.fn(),
  stopTour: vi.fn(),
}));
vi.mock("@/tour/MeganeTour", () => tour);

describe("lazyTour", () => {
  it("loads the tour only when one starts, then forwards to it", async () => {
    vi.resetModules();
    const lazy = await import("@/tour/lazyTour");
    // Nothing loaded yet: stopping is a no-op.
    lazy.stopTour();
    await vi.dynamicImportSettled();
    expect(tour.stopTour).not.toHaveBeenCalled();

    await lazy.startTour();
    expect(tour.startTour).toHaveBeenCalledTimes(1);
    await lazy.startPipelineTutorial();
    expect(tour.startPipelineTutorial).toHaveBeenCalledTimes(1);
    lazy.stopTour();
    await vi.dynamicImportSettled();
    expect(tour.stopTour).toHaveBeenCalledTimes(1);
  });
});
