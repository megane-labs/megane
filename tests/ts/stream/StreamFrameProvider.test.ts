import { describe, it, expect, beforeEach, vi } from "vitest";
import { StreamFrameProvider } from "@/stream/StreamFrameProvider";
import type { WebSocketClient } from "@/stream/WebSocketClient";
import type { Frame, TrajectoryMeta } from "@/types";

function fakeClient(): WebSocketClient {
  return {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    get connected() {
      return true;
    },
  } as unknown as WebSocketClient;
}

function makeFrame(id: number, nAtoms = 2): Frame {
  return {
    frameId: id,
    nAtoms,
    positions: new Float32Array(nAtoms * 3),
  };
}

const META: TrajectoryMeta = { nFrames: 100, timestepPs: 1, nAtoms: 2 };

describe("StreamFrameProvider", () => {
  let client: WebSocketClient;

  beforeEach(() => {
    client = fakeClient();
  });

  it("kind is 'stream' and meta matches the constructor argument", () => {
    const provider = new StreamFrameProvider(client, META);
    expect(provider.kind).toBe("stream");
    expect(provider.meta).toEqual(META);
  });

  it("heldBytes sums the cached frames and drops to 0 on clear", () => {
    const provider = new StreamFrameProvider(client, META);
    expect(provider.heldBytes()).toBe(0);
    provider.receiveFrame(makeFrame(0));
    provider.receiveFrame({ ...makeFrame(1), box: new Float32Array(9) });
    expect(provider.heldBytes()).toBe(6 * 4 + (6 + 9) * 4);
    provider.clear();
    expect(provider.heldBytes()).toBe(0);
  });

  it("getFrame on empty cache returns null and requests via the client", () => {
    const provider = new StreamFrameProvider(client, META);
    const result = provider.getFrame(7);
    expect(result).toBeNull();
    expect(client.send).toHaveBeenCalledWith({ type: "request_frame", frame: 7 });
  });

  it("receiveFrame caches the frame and triggers onFrameReady", () => {
    const provider = new StreamFrameProvider(client, META);
    const onReady = vi.fn();
    provider.setOnFrameReady(onReady);

    const frame = makeFrame(3);
    provider.receiveFrame(frame);
    expect(onReady).toHaveBeenCalledWith(frame);
  });

  it("getFrame returns the cached frame without re-requesting", () => {
    const provider = new StreamFrameProvider(client, META);
    const frame = makeFrame(3);
    provider.receiveFrame(frame);

    const result = provider.getFrame(3);
    expect(result).toBe(frame);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("evicts the oldest frame when cache exceeds maxCacheSize (LRU)", () => {
    const provider = new StreamFrameProvider(client, META, 2);
    provider.receiveFrame(makeFrame(0));
    provider.receiveFrame(makeFrame(1));
    provider.receiveFrame(makeFrame(2));

    // Frame 0 should have been evicted; frames 1 and 2 stay.
    (client.send as ReturnType<typeof vi.fn>).mockClear();
    expect(provider.getFrame(0)).toBeNull();
    expect(client.send).toHaveBeenCalledWith({ type: "request_frame", frame: 0 });

    expect(provider.getFrame(1)?.frameId).toBe(1);
    expect(provider.getFrame(2)?.frameId).toBe(2);
  });

  it("caps the cache by bytes as well as by frames", () => {
    // 2 atoms = 24 bytes a frame: a 50-byte budget holds 2 of the 128 frames.
    const provider = new StreamFrameProvider(client, META, 128, 50);
    provider.receiveFrame(makeFrame(0));
    provider.receiveFrame(makeFrame(1));
    provider.receiveFrame(makeFrame(2));
    expect(provider.getFrame(0)).toBeNull();
    expect(provider.getFrame(1)?.frameId).toBe(1);
    expect(provider.getFrame(2)?.frameId).toBe(2);
  });

  it("re-receiving an existing frameId moves it to MRU position", () => {
    const provider = new StreamFrameProvider(client, META, 2);
    provider.receiveFrame(makeFrame(0));
    provider.receiveFrame(makeFrame(1));
    // Touch frame 0 → it becomes MRU; frame 1 is now the candidate for eviction.
    provider.receiveFrame(makeFrame(0));
    provider.receiveFrame(makeFrame(2));

    expect(provider.getFrame(0)?.frameId).toBe(0);
    (client.send as ReturnType<typeof vi.fn>).mockClear();
    expect(provider.getFrame(1)).toBeNull();
    expect(client.send).toHaveBeenCalledWith({ type: "request_frame", frame: 1 });
  });

  it("clear empties the cache and order", () => {
    const provider = new StreamFrameProvider(client, META);
    provider.receiveFrame(makeFrame(0));
    provider.receiveFrame(makeFrame(1));

    provider.clear();
    (client.send as ReturnType<typeof vi.fn>).mockClear();
    expect(provider.getFrame(0)).toBeNull();
    expect(provider.getFrame(1)).toBeNull();
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("setOnFrameReady can be replaced and the latest callback is used", () => {
    const provider = new StreamFrameProvider(client, META);
    const first = vi.fn();
    const second = vi.fn();
    provider.setOnFrameReady(first);
    provider.setOnFrameReady(second);
    provider.receiveFrame(makeFrame(5));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
