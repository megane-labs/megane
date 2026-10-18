import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, waitFor, act, cleanup } from "@testing-library/react";

vi.mock("@/components/Viewport", () => ({ Viewport: vi.fn(() => null) }));
vi.mock("@/components/Timeline", () => ({ Timeline: vi.fn(() => null) }));
vi.mock("@/components/Tooltip", () => ({ Tooltip: vi.fn(() => null) }));
vi.mock("@/parsers/structure", () => ({ parseStructureFile: vi.fn() }));
vi.mock("@/pipeline/apply", () => ({
  applyViewportState: vi.fn(),
  applyVectorsForFrame: vi.fn(),
}));

import { PipelineViewer } from "@/components/PipelineViewer";
import { Viewport } from "@/components/Viewport";
import { Timeline } from "@/components/Timeline";
import { parseStructureFile } from "@/parsers/structure";
import { applyViewportState } from "@/pipeline/apply";
import type { SerializedPipeline } from "@/pipeline/types";
import type { Frame, Snapshot } from "@/types";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";

const mockViewport = vi.mocked(Viewport);
const mockTimeline = vi.mocked(Timeline);
const mockParse = vi.mocked(parseStructureFile);
const mockApply = vi.mocked(applyViewportState);

const N_FRAMES = 4;
const snapshot: Snapshot = {
  nAtoms: 1,
  nBonds: 0,
  nFileBonds: 0,
  positions: new Float32Array([0, 0, 0]),
  elements: new Uint8Array([6]),
  bonds: new Uint32Array(0),
  bondOrders: null,
  box: null,
};
const frames: Frame[] = Array.from({ length: N_FRAMES }, (_, i) => ({
  frameId: i,
  nAtoms: 1,
  positions: new Float32Array([i, 0, 0]),
}));

const pipeline: SerializedPipeline = {
  version: 3,
  nodes: [
    {
      id: "s1",
      type: "load_structure",
      fileName: "traj.xyz",
      fileUrl: "/traj.xyz",
      hasTrajectory: true,
      hasCell: false,
      position: { x: 0, y: 0 },
    },
    {
      id: "v1",
      type: "viewport",
      perspective: false,
      cellAxesVisible: true,
      pivotMarkerVisible: true,
      position: { x: 0, y: 200 },
    },
  ],
  edges: [
    { source: "s1", target: "v1", sourceHandle: "particle", targetHandle: "particle" },
    { source: "s1", target: "v1", sourceHandle: "trajectory", targetHandle: "trajectory" },
  ],
} as unknown as SerializedPipeline;

const timeline = () => mockTimeline.mock.lastCall![0];

describe("PipelineViewer playback", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) })),
    );
    mockParse.mockResolvedValue({
      snapshot,
      frames,
      meta: { nFrames: N_FRAMES, timestepPs: 1, nAtoms: 1 },
      labels: null,
    } as never);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function mount() {
    const utils = render(<PipelineViewer pipeline={pipeline} />);
    await waitFor(() => expect(mockTimeline).toHaveBeenCalled());
    return utils;
  }

  it("plays the pipeline's trajectory through the playback store", async () => {
    await mount();
    expect(mockViewport.mock.lastCall![0].snapshot).toBe(snapshot);
    expect(timeline().totalFrames).toBe(N_FRAMES);
    expect(timeline().currentFrame).toBe(0);
    expect(timeline().loopEnd).toBe(N_FRAMES - 1);
    const firstFrame = mockViewport.mock.lastCall![0].frame;
    expect(firstFrame).not.toBeNull();

    vi.useFakeTimers();
    act(() => timeline().onFpsChange(10));
    act(() => timeline().onPlayPause());
    expect(timeline().playing).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(timeline().currentFrame).toBe(1);
    // The tick hands the provider's frame to the Viewport.
    expect(mockViewport.mock.lastCall![0].frame).not.toBe(firstFrame);
    act(() => vi.advanceTimersByTime(100 * (N_FRAMES - 1)));
    // Four ticks from frame 0 on a four-frame loop wrap back to 0.
    expect(timeline().currentFrame).toBe(0);
    act(() => vi.advanceTimersByTime(100));
    expect(timeline().currentFrame).toBe(1);

    // Scrubbing pauses.
    act(() => timeline().onSeek(3));
    expect(timeline().playing).toBe(false);
    expect(timeline().currentFrame).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(timeline().currentFrame).toBe(3);
  });

  it("steps and clamps the loop range", async () => {
    await mount();
    act(() => timeline().onLoopRangeChange(1, 99));
    expect(timeline().loopStart).toBe(1);
    expect(timeline().loopEnd).toBe(N_FRAMES - 1);
    act(() => timeline().onStepForward());
    expect(timeline().currentFrame).toBe(1);
    act(() => timeline().onStepBackward());
    act(() => timeline().onStepBackward());
    expect(timeline().currentFrame).toBe(1);
    act(() => timeline().onSpeedChange(2));
    expect(timeline().speedMultiplier).toBe(2);
  });

  it("stops playing on unmount", async () => {
    const { unmount } = await mount();
    vi.useFakeTimers();
    act(() => timeline().onPlayPause());
    const clear = vi.spyOn(globalThis, "clearInterval");
    unmount();
    expect(clear).toHaveBeenCalled();
  });

  it("applies the executed viewport state to the renderer on attach", async () => {
    await mount();
    const renderer = {} as MoleculeRenderer;
    mockApply.mockClear();
    act(() => mockViewport.mock.lastCall![0].onRendererReady!(renderer));
    expect(mockApply).toHaveBeenCalled();
    const [r, vs, prev] = mockApply.mock.calls[0];
    expect(r).toBe(renderer);
    expect(vs.particles[0].source).toBe(snapshot);
    expect(prev).toBeNull();
  });
});
