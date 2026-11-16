import { describe, it, expect } from "vitest";
import { HostFrameProvider } from "@/stream/HostFrameProvider";
import type { Frame } from "@/types";

const frame = (frameId: number): Frame => ({
  frameId,
  nAtoms: 2,
  positions: new Float32Array(6),
});

describe("HostFrameProvider", () => {
  it("answers the frame the host delivered, for that frame's index only", () => {
    const meta = { nFrames: 10, timestepPs: 0, nAtoms: 2 };
    const provider = new HostFrameProvider(meta);
    expect(provider.kind).toBe("stream");
    expect(provider.meta).toBe(meta);
    // Nothing delivered yet: like a stream whose frame has not arrived.
    expect(provider.getFrame(0)).toBeNull();
    expect(provider.heldBytes()).toBe(0);

    const f3 = frame(3);
    provider.setFrame(f3);
    expect(provider.getFrame(3)).toBe(f3);
    expect(provider.getFrame(0)).toBeNull();
    expect(provider.heldBytes()).toBe(24);

    const f4 = frame(4);
    provider.setFrame(f4);
    expect(provider.getFrame(3)).toBeNull();
    expect(provider.getFrame(4)).toBe(f4);

    provider.setFrame(null);
    expect(provider.getFrame(4)).toBeNull();
  });
});
