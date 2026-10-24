import { describe, it, expect } from "vitest";
import {
  DEFAULT_FRAME_CACHE_BYTES,
  MIN_FRAME_CACHE_FRAMES,
  frameCacheCapacity,
} from "@/stream/frameCacheCapacity";

const MiB = 1024 * 1024;

describe("frameCacheCapacity", () => {
  it("keeps the frame limit for a small system", () => {
    // 3000 atoms = 36 KB a frame: 256 frames are 9 MB, well under the budget.
    expect(frameCacheCapacity(3000, 256)).toBe(256);
  });

  it("caps a large system by bytes", () => {
    // 100k atoms = 1.2 MB a frame: 128 MiB holds 111 of them, not 256.
    const n = 100_000;
    const capacity = frameCacheCapacity(n, 256);
    expect(capacity).toBe(Math.floor(DEFAULT_FRAME_CACHE_BYTES / (n * 12)));
    expect(capacity * n * 12).toBeLessThanOrEqual(DEFAULT_FRAME_CACHE_BYTES);
  });

  it("takes an explicit byte budget", () => {
    // 1 MiB of 1000-atom (12 000-byte) frames is 87 frames.
    expect(frameCacheCapacity(1000, 256, MiB)).toBe(87);
  });

  it("always keeps at least two frames", () => {
    // 10M atoms = 120 MB a frame: one would already blow a 64 MiB budget.
    expect(frameCacheCapacity(10_000_000, 256, 64 * MiB)).toBe(MIN_FRAME_CACHE_FRAMES);
    expect(frameCacheCapacity(10, 1)).toBe(MIN_FRAME_CACHE_FRAMES);
  });

  it("treats an empty system as tiny frames", () => {
    expect(frameCacheCapacity(0, 64)).toBe(64);
  });
});
