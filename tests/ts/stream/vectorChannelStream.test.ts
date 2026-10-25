import { describe, it, expect, vi, afterEach } from "vitest";
import { streamVectorChannels, VECTOR_OFFER_DELAY_MS } from "@/stream/vectorChannelStream";
import type { VectorChannel } from "@/types";

afterEach(() => {
  vi.useRealTimers();
});

/** A provider stub whose decoded-vector callback the test fires. */
function provider() {
  let cb: ((frameId: number, vectors: Float32Array, count: number) => void) | null = null;
  return {
    setOnVectors(c: (frameId: number, vectors: Float32Array, count: number) => void) {
      cb = c;
    },
    emit(frameId: number, values: number[]) {
      cb?.(frameId, Float32Array.from(values), values.length / 3);
    },
    attached: () => cb !== null,
  };
}

describe("streamVectorChannels", () => {
  it("offers every channel, frames in order, batched", () => {
    vi.useFakeTimers();
    const p = provider();
    const offer = vi.fn();
    streamVectorChannels(p, ["velocity", "force"], 1, offer);
    expect(offer).not.toHaveBeenCalled(); // nothing known yet
    p.emit(2, [1, 2, 3, -1, -2, -3]);
    p.emit(1, [4, 5, 6, -4, -5, -6]);
    expect(offer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(VECTOR_OFFER_DELAY_MS);
    expect(offer).toHaveBeenCalledOnce();
    const [channels] = offer.mock.calls[0] as [VectorChannel[]];
    expect(channels.map((c) => c.name)).toEqual(["velocity", "force"]);
    expect(channels[0].frames.map((f) => f.frame)).toEqual([1, 2]);
    expect(Array.from(channels[0].frames[1].vectors)).toEqual([1, 2, 3]);
    expect(Array.from(channels[1].frames[0].vectors)).toEqual([-4, -5, -6]);
  });

  it("offers a seeded frame 0 right away, and skips a frame short of a channel", () => {
    vi.useFakeTimers();
    const p = provider();
    const offer = vi.fn();
    const seed: VectorChannel[] = [
      { name: "momenta", frames: [{ frame: 0, vectors: Float32Array.from([7, 8, 9]) }] },
    ];
    streamVectorChannels(p, ["momenta", "force"], 1, offer, seed);
    expect(offer).toHaveBeenCalledOnce();
    expect((offer.mock.calls[0][0] as VectorChannel[])[0].frames).toHaveLength(1);
    p.emit(1, [1, 1, 1]); // carries momenta only
    vi.advanceTimersByTime(VECTOR_OFFER_DELAY_MS);
    const [momenta, force] = offer.mock.calls[1][0] as VectorChannel[];
    expect(momenta.frames.map((f) => f.frame)).toEqual([0, 1]);
    expect(force.frames).toEqual([]);
  });

  it("keeps a seeded channel the frames do not carry as seeded", () => {
    const p = provider();
    const offer = vi.fn();
    const vel = Float32Array.from([1, 2, 3]);
    streamVectorChannels(p, [], 1, offer, [{ name: "vel", frames: [{ frame: 0, vectors: vel }] }]);
    expect(p.attached()).toBe(false); // nothing streams with the frames
    expect(offer).toHaveBeenCalledWith([{ name: "vel", frames: [{ frame: 0, vectors: vel }] }]);
  });

  it("does nothing without channels", () => {
    const p = provider();
    const offer = vi.fn();
    streamVectorChannels(p, [], 3, offer);
    expect(p.attached()).toBe(false);
    expect(offer).not.toHaveBeenCalled();
  });
});
