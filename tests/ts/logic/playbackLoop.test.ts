import { describe, expect, it } from "vitest";
import {
  clampLoopRange,
  effectiveLoopRange,
  nextPlaybackFrame,
  playbackIntervalMs,
  stepPlaybackFrame,
} from "@/logic/playbackLoop";

const bounds = (totalFrames: number, loopStart = 0, loopEnd = totalFrames - 1) => ({
  totalFrames,
  loopStart,
  loopEnd,
});

describe("playbackLoop", () => {
  it("derives the tick period from fps × speed", () => {
    expect(playbackIntervalMs(30, 1)).toBeCloseTo(1000 / 30);
    expect(playbackIntervalMs(10, 2)).toBe(50);
  });

  it("clamps a stale loop range to the frames that exist", () => {
    expect(effectiveLoopRange({ totalFrames: 5, loopStart: -2, loopEnd: 99 })).toEqual({
      start: 0,
      end: 4,
    });
  });

  it("advances one frame and wraps past the loop end", () => {
    expect(nextPlaybackFrame(0, bounds(5))).toBe(1);
    expect(nextPlaybackFrame(4, bounds(5))).toBe(0);
    expect(nextPlaybackFrame(3, bounds(10, 2, 3))).toBe(2);
    // A loop end left over from a longer trajectory still wraps at the last frame.
    expect(nextPlaybackFrame(4, { totalFrames: 5, loopStart: 1, loopEnd: 40 })).toBe(1);
  });

  it("has nothing to play for a single-frame or empty trajectory", () => {
    expect(nextPlaybackFrame(0, bounds(1))).toBeNull();
    expect(nextPlaybackFrame(0, bounds(0))).toBeNull();
  });

  it("steps within the loop range without wrapping", () => {
    expect(stepPlaybackFrame(2, 1, bounds(10, 1, 3))).toBe(3);
    expect(stepPlaybackFrame(3, 1, bounds(10, 1, 3))).toBe(3);
    expect(stepPlaybackFrame(2, -1, bounds(10, 1, 3))).toBe(1);
    expect(stepPlaybackFrame(1, -1, bounds(10, 1, 3))).toBe(1);
  });

  it("clamps a requested loop range", () => {
    expect(clampLoopRange(-3, 50, 10)).toEqual({ loopStart: 0, loopEnd: 9 });
    expect(clampLoopRange(2, 5, 10)).toEqual({ loopStart: 2, loopEnd: 5 });
    expect(clampLoopRange(2, 5, 0)).toEqual({ loopStart: 0, loopEnd: 0 });
  });
});
