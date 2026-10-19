import { describe, it, expect } from "vitest";
import {
  BACKGROUND_LOAD_FRAME_MS,
  beginBackgroundLoad,
  skipFrameForBackgroundLoad,
} from "@/renderer/backgroundLoad";

describe("background-load frame throttle", () => {
  it("never skips a frame while nothing loads in the background", () => {
    expect(skipFrameForBackgroundLoad(1000, 999)).toBe(false);
  });

  it("skips idle frames closer than the interval while a load is in flight", () => {
    const end = beginBackgroundLoad();
    try {
      expect(skipFrameForBackgroundLoad(1000, 1000 - BACKGROUND_LOAD_FRAME_MS + 1)).toBe(true);
      expect(skipFrameForBackgroundLoad(1000, 1000 - BACKGROUND_LOAD_FRAME_MS)).toBe(false);
    } finally {
      end();
    }
    expect(skipFrameForBackgroundLoad(1000, 999)).toBe(false);
  });

  it("stays throttled until every overlapping load has ended, each end counted once", () => {
    const endA = beginBackgroundLoad();
    const endB = beginBackgroundLoad();
    endA();
    endA(); // a second call must not end B's load too
    expect(skipFrameForBackgroundLoad(1000, 999)).toBe(true);
    endB();
    expect(skipFrameForBackgroundLoad(1000, 999)).toBe(false);
  });
});
