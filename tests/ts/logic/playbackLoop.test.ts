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

  it("plays an inverted loop range (start typed past end) between its two ends", () => {
    // The Timeline's two inputs are edited one keystroke at a time, so the
    // range passes through start > end; playback used to pin on the start.
    const inverted = bounds(100, 80, 20);
    expect(effectiveLoopRange(inverted)).toEqual({ start: 20, end: 80 });
    const seen: number[] = [];
    let f = 78;
    for (let i = 0; i < 4; i++) seen.push((f = nextPlaybackFrame(f, inverted)!));
    expect(seen).toEqual([79, 80, 20, 21]);
    expect(nextPlaybackFrame(30, inverted)).toBe(31);
    expect(stepPlaybackFrame(80, 1, inverted)).toBe(80);
    expect(stepPlaybackFrame(20, -1, inverted)).toBe(20);
  });

  it("never loops back to a stale start past the last frame", () => {
    // A start left over from a longer trajectory is clamped like the end.
    expect(effectiveLoopRange({ totalFrames: 10, loopStart: 50, loopEnd: 99 })).toEqual({
      start: 9,
      end: 9,
    });
    expect(nextPlaybackFrame(9, { totalFrames: 10, loopStart: 50, loopEnd: 99 })).toBe(9);
    expect(effectiveLoopRange(bounds(0))).toEqual({ start: 0, end: 0 });
  });

  it("clamps a requested loop range", () => {
    expect(clampLoopRange(-3, 50, 10)).toEqual({ loopStart: 0, loopEnd: 9 });
    expect(clampLoopRange(2, 5, 10)).toEqual({ loopStart: 2, loopEnd: 5 });
    expect(clampLoopRange(2, 5, 0)).toEqual({ loopStart: 0, loopEnd: 0 });
  });
});
