import { describe, it, expect, vi, beforeEach } from "vitest";
import { LazyFrameProvider } from "@/stream/LazyFrameProvider";
import type { TrajectoryLazyHandle, DecodedLazyFrame } from "@/parsers/parseClient";
import type { TrajectoryMeta } from "@/types";

const N_ATOMS = 4;
const N_FRAMES = 50;

function makeHandle(nFrames = N_FRAMES): TrajectoryLazyHandle {
  return {
    trajectoryId: 7,
    kind: "xtc",
    index: {
      nAtoms: N_ATOMS,
      nFrames,
      timestepPs: 2,
      hasBox: false,
      box: null,
      times: new Float32Array(nFrames),
      vectorChannelNames: [],
    },
  };
}

function makeMeta(nFrames = N_FRAMES): TrajectoryMeta {
  return { nFrames, timestepPs: 2, nAtoms: N_ATOMS };
}

function decoded(frame: number): DecodedLazyFrame {
  return {
    positions: new Float32Array(N_ATOMS * 3).fill(frame),
    vectors: new Float32Array(0),
    vectorChannelCount: 0,
  };
}

/** A decode stub whose promises resolve only when we call `flush()`. */
function deferredDecode() {
  const resolvers: Array<() => void> = [];
  const fn = vi.fn((_tid: number, frame: number) => {
    return new Promise<DecodedLazyFrame>((resolve) => {
      resolvers.push(() => resolve(decoded(frame)));
    });
  });
  return {
    fn,
    async flush() {
      const pending = resolvers.splice(0);
      pending.forEach((r) => r());
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("LazyFrameProvider", () => {
  let decode: ReturnType<typeof deferredDecode>;
  let dispose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    decode = deferredDecode();
    dispose = vi.fn();
  });

  function make(opts: { maxCacheSize?: number; prefetchAhead?: number } = {}) {
    return new LazyFrameProvider(makeHandle(), makeMeta(), {
      decode: decode.fn,
      dispose,
      prefetchAhead: opts.prefetchAhead ?? 0,
      maxCacheSize: opts.maxCacheSize,
    });
  }

  it("has stream kind and carries meta", () => {
    const p = make();
    expect(p.kind).toBe("stream");
    expect(p.meta.nFrames).toBe(N_FRAMES);
    expect(p.meta.nAtoms).toBe(N_ATOMS);
  });

  it("primes frame 0 at construction", () => {
    make({ prefetchAhead: 0 });
    expect(decode.fn).toHaveBeenCalledWith(7, 0);
  });

  it("getFrame miss returns null and requests a decode", () => {
    const p = make({ prefetchAhead: 0 });
    decode.fn.mockClear();
    expect(p.getFrame(5)).toBeNull();
    expect(decode.fn).toHaveBeenCalledExactlyOnceWith(7, 5);
  });

  it("caches the decoded frame and fires onFrameReady", async () => {
    const p = make({ prefetchAhead: 0 });
    const ready = vi.fn();
    p.setOnFrameReady(ready);
    p.getFrame(3);
    await decode.flush();

    expect(ready).toHaveBeenCalledTimes(2); // frame 0 (primed) + frame 3
    const frame = p.getFrame(3);
    expect(frame).not.toBeNull();
    expect(frame!.frameId).toBe(3);
    expect(frame!.nAtoms).toBe(N_ATOMS);
    expect(frame!.positions[0]).toBe(3);
  });

  it("carries a frame's own cell when the decoder gives one", async () => {
    const box = new Float32Array([12, 0, 0, 0, 12, 0, 0, 0, 12]);
    const p = new LazyFrameProvider(makeHandle(), makeMeta(), {
      decode: async (_t, frame) => ({ ...decoded(frame), ...(frame === 2 && { box }) }),
      dispose,
      prefetchAhead: 0,
    });
    p.getFrame(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(p.getFrame(2)!.box).toBe(box);
    expect(p.getFrame(0)!.box).toBeUndefined();
  });

  it("dedups concurrent requests for the same frame", () => {
    const p = make({ prefetchAhead: 0 });
    decode.fn.mockClear();
    p.getFrame(9);
    p.getFrame(9);
    p.getFrame(9);
    expect(decode.fn).toHaveBeenCalledTimes(1);
  });

  it("prefetches a window ahead of the requested frame", () => {
    const p = make({ prefetchAhead: 3 });
    decode.fn.mockClear();
    p.getFrame(10);
    // 10, 11, 12, 13
    expect(decode.fn.mock.calls.map((c) => c[1]).sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("clamps the prefetch window to the last frame", () => {
    const p = make({ prefetchAhead: 10 });
    decode.fn.mockClear();
    p.getFrame(N_FRAMES - 2); // 48 → window would be 48..58, clamped to 48,49
    const frames = decode.fn.mock.calls.map((c) => c[1]).sort((a, b) => a - b);
    expect(frames).toEqual([N_FRAMES - 2, N_FRAMES - 1]);
  });

  it("does not request out-of-range frames", () => {
    const p = make({ prefetchAhead: 0 });
    decode.fn.mockClear();
    expect(p.getFrame(-1)).toBeNull();
    expect(p.getFrame(N_FRAMES)).toBeNull();
    expect(decode.fn).not.toHaveBeenCalled();
  });

  it("evicts least-recently-used frames past the cache limit", async () => {
    const p = make({ prefetchAhead: 0, maxCacheSize: 2 });
    p.getFrame(1);
    p.getFrame(2);
    await decode.flush();
    // Both cached.
    expect(p.getFrame(1)).not.toBeNull();
    // Requesting a 3rd distinct frame evicts the oldest (frame 0 primed first,
    // then 1, then 2 → adding 3 evicts 0 first).
    p.getFrame(3);
    await decode.flush();
    // Cache holds at most 2; the earliest inserted is gone.
    const held = [0, 1, 2, 3].filter((i) => p.getFrame(i) !== null);
    expect(held.length).toBeLessThanOrEqual(2);
  });

  it("caps the cache by bytes, keeping the prefetch window inside it", async () => {
    // 4 atoms = 48 bytes a frame: a 150-byte budget holds 3 frames, so at most
    // 2 are decoded ahead of the requested one, whatever prefetchAhead asks.
    const p = new LazyFrameProvider(makeHandle(), makeMeta(), {
      decode: decode.fn,
      dispose,
      prefetchAhead: 10,
      maxCacheBytes: 150,
    });
    expect(decode.fn.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
    await decode.flush();
    decode.fn.mockClear();
    p.getFrame(20);
    expect(decode.fn.mock.calls.map((c) => c[1])).toEqual([20, 21, 22]);
    await decode.flush();
    expect([0, 1, 2, 20, 21, 22].filter((i) => p.getFrame(i) !== null)).toEqual([20, 21, 22]);
  });

  it("tracks decoded count and fires onProgress", async () => {
    const p = make({ prefetchAhead: 0 });
    const progress = vi.fn();
    p.setOnProgress(progress);
    p.getFrame(4);
    await decode.flush();
    expect(p.decodedCount()).toBe(2); // primed frame 0 + frame 4
    expect(progress).toHaveBeenLastCalledWith(2, N_FRAMES);
  });

  it("leaves a frame null when its decode rejects, and allows retry", async () => {
    // Reject only the FIRST decode of frame 6 (frame 0 priming must not consume it).
    let sixCalls = 0;
    const failing = vi.fn((_tid: number, frame: number) => {
      if (frame === 6 && ++sixCalls === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve(decoded(1));
    });
    const p = new LazyFrameProvider(makeHandle(), makeMeta(), {
      decode: failing,
      dispose,
      prefetchAhead: 0,
    });
    p.getFrame(6);
    await Promise.resolve();
    await Promise.resolve();
    expect(p.getFrame(6)).toBeNull(); // still null after rejection (a retry is now in flight)
    await Promise.resolve();
    await Promise.resolve();
    expect(p.getFrame(6)).not.toBeNull(); // retry succeeded
  });

  it("dispose frees the worker decoder, clears the cache, and is idempotent", async () => {
    const p = make({ prefetchAhead: 0 });
    p.getFrame(2);
    await decode.flush();
    p.dispose();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(7);
    expect(p.getFrame(2)).toBeNull(); // cache cleared
    p.dispose();
    expect(dispose).toHaveBeenCalledTimes(1); // idempotent
  });

  it("stops decoding after dispose", () => {
    const p = make({ prefetchAhead: 0 });
    p.dispose();
    decode.fn.mockClear();
    expect(p.getFrame(5)).toBeNull();
    expect(decode.fn).not.toHaveBeenCalled();
  });

  it("emits embedded vectors via onVectors when a decoded frame carries them", async () => {
    const withVectors = vi.fn((_tid: number, frame: number) =>
      Promise.resolve({
        positions: new Float32Array(N_ATOMS * 3).fill(frame),
        vectors: new Float32Array(N_ATOMS * 3).fill(frame + 100),
        vectorChannelCount: 1,
      }),
    );
    const p = new LazyFrameProvider(makeHandle(), makeMeta(), {
      decode: withVectors,
      dispose,
      prefetchAhead: 0,
    });
    const onVectors = vi.fn();
    p.setOnVectors(onVectors);
    p.getFrame(4);
    await Promise.resolve();
    await Promise.resolve();
    const call = onVectors.mock.calls.find((c) => c[0] === 4);
    expect(call).toBeDefined();
    expect(call![1]).toBeInstanceOf(Float32Array);
    expect(call![1][0]).toBe(104);
    expect(call![2]).toBe(1);
  });

  it("does not emit onVectors for a frame with no vectors", async () => {
    const p = make({ prefetchAhead: 0 });
    const onVectors = vi.fn();
    p.setOnVectors(onVectors);
    p.getFrame(2);
    await decode.flush();
    expect(onVectors).not.toHaveBeenCalled();
  });

  it("applies the structure-file base-frame convention (frame 0 = basePositions, decode i-1)", () => {
    const basePositions = new Float32Array(N_ATOMS * 3).fill(42);
    // index.nFrames = decodable extra frames; provider exposes nFrames + 1.
    const handle = makeHandle(3);
    const p = new LazyFrameProvider(
      handle,
      { nFrames: 4, timestepPs: 2, nAtoms: N_ATOMS },
      {
        decode: decode.fn,
        dispose,
        prefetchAhead: 0,
        basePositions,
      },
    );
    // Frame 0 is synchronous (the eager snapshot), no decode.
    decode.fn.mockClear();
    const f0 = p.getFrame(0);
    expect(f0!.positions).toBe(basePositions);
    expect(decode.fn).not.toHaveBeenCalled();
    // Provider frame 2 decodes underlying extra frame 1.
    p.getFrame(2);
    expect(decode.fn).toHaveBeenCalledExactlyOnceWith(7, 1);
  });

  it("seeds frame 0 (trajectory convention) so it serves synchronously with no decode", () => {
    const seed = new Float32Array(N_ATOMS * 3).fill(77);
    const p = new LazyFrameProvider(makeHandle(), makeMeta(), {
      decode: decode.fn,
      dispose,
      prefetchAhead: 0,
      seedFrame0: seed,
    });
    // Frame 0 comes straight from the seeded cache — no worker round-trip.
    expect(decode.fn).not.toHaveBeenCalledWith(7, 0);
    const f0 = p.getFrame(0);
    expect(f0).not.toBeNull();
    expect(f0!.frameId).toBe(0);
    expect(f0!.positions).toBe(seed);
    expect(p.decodedCount()).toBe(1);
    // Other frames still decode on demand.
    p.getFrame(5);
    expect(decode.fn).toHaveBeenCalledExactlyOnceWith(7, 5);
  });

  it("ignores seedFrame0 when basePositions is set (structure convention wins)", () => {
    const seed = new Float32Array(N_ATOMS * 3).fill(1);
    const basePositions = new Float32Array(N_ATOMS * 3).fill(2);
    const p = new LazyFrameProvider(
      makeHandle(3),
      { nFrames: 4, timestepPs: 2, nAtoms: N_ATOMS },
      {
        decode: decode.fn,
        dispose,
        prefetchAhead: 0,
        seedFrame0: seed,
        basePositions,
      },
    );
    expect(p.getFrame(0)!.positions).toBe(basePositions);
  });
});
