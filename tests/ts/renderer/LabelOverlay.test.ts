import { describe, it, expect, vi, afterEach } from "vitest";
import { LabelOverlay } from "@/renderer/LabelOverlay";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LabelOverlay.getData", () => {
  it("hands out the labels and positions it draws, for the headset", () => {
    // jsdom has no 2D canvas; getData never draws.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const overlay = new LabelOverlay();
    expect(overlay.getData()).toBeNull();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    overlay.setAtomData(new Uint8Array([6, 8]), 2);
    overlay.setPositions(positions);
    expect(overlay.getData()).toBeNull();
    const labels = ["C1", "O1"];
    overlay.setLabels(labels);
    expect(overlay.getData()).toEqual({ labels, positions, count: 2 });
    overlay.setAtomData(new Uint8Array(0), 0);
    expect(overlay.getData()).toBeNull();
  });
});
