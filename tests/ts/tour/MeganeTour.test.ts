import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Config } from "driver.js";

// The controller drives driver.js; stand in for it so jsdom never lays out a
// real popover, and record what the tour was started with.
const created: Array<{ config: Config; driver: Record<string, ReturnType<typeof vi.fn>> }> = [];
vi.mock("driver.js", () => ({
  driver: (config: Config) => {
    const d = {
      drive: vi.fn(),
      destroy: vi.fn(() => config.onDestroyed?.(undefined, {} as never, {} as never)),
      isActive: vi.fn(() => true),
      getActiveElement: vi.fn(() => undefined),
      refresh: vi.fn(),
    };
    created.push({ config, driver: d });
    return d;
  },
}));
vi.mock("driver.js/dist/driver.css", () => ({}));
vi.mock("@/tour/tour.css", () => ({}));

const follow = { stop: vi.fn() };
vi.mock("@/tour/followTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/tour/followTarget")>()),
  followActiveElement: vi.fn(() => follow.stop),
}));

import { startTour, startPipelineTutorial, stopTour } from "@/tour/MeganeTour";
import { followActiveElement } from "@/tour/followTarget";
import { useTourStore } from "@/tour/tourStore";

beforeEach(() => {
  created.length = 0;
  follow.stop.mockClear();
  vi.mocked(followActiveElement).mockClear();
  document.body.innerHTML = "";
});

describe("MeganeTour", () => {
  it("leaves out the steps whose target is not on screen (#964)", () => {
    // Nothing of the viewer is mounted: only the centred steps remain.
    startTour();
    const steps = created[0].config.steps!;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.element === undefined)).toBe(true);
    expect(created[0].driver.drive).toHaveBeenCalled();
    expect(useTourStore.getState().isActive).toBe(true);
    stopTour();
  });

  it("keeps the callout on its target while the tour runs, and stops when it ends", () => {
    startPipelineTutorial();
    const { driver } = created[0];
    expect(followActiveElement).toHaveBeenCalledWith(driver);
    expect(follow.stop).not.toHaveBeenCalled();

    // Starting another tour ends the first one, and its following with it.
    startTour();
    expect(driver.destroy).toHaveBeenCalled();
    expect(follow.stop).toHaveBeenCalledTimes(1);

    stopTour();
    expect(follow.stop).toHaveBeenCalledTimes(2);
    expect(useTourStore.getState().isActive).toBe(false);
  });
});
