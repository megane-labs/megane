/**
 * Tests the two-phase lazy trajectory path in useMeganeLocal.loadXtc.
 * Phase 1: decodeTrajectoryFrame0 decodes ONLY frame 0 from a bounded prefix →
 * instant first paint (a single-frame provisional trajectory). Phase 2
 * (background): indexTrajectoryLazy scans the full index and swaps in the
 * streaming LazyFrameProvider. A prefix miss falls back to a single full-read
 * index; a null index (worker unavailable) falls back to the eager parser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/parseCore";

const parseFileMock = vi.hoisted(() => vi.fn());
const frame0Mock = vi.hoisted(() => vi.fn());
const indexTrajMock = vi.hoisted(() => vi.fn());
const parseXtcMock = vi.hoisted(() => vi.fn());
const disposeMock = vi.hoisted(() => vi.fn());

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseFileMock,
  parseStructureText: vi.fn(),
  parseStructurePrefix: vi.fn(),
  indexStructureLazy: vi.fn(),
  // Structure stays eager so the base snapshot is set with no extra plumbing.
  shouldUseLazyStructure: () => false,
}));

vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: parseXtcMock,
  parseLammpstrjFile: vi.fn(),
  parseDCDFile: vi.fn(),
  parseNetCDFFile: vi.fn(),
  indexTrajectoryLazy: indexTrajMock,
  decodeTrajectoryFrame0: frame0Mock,
  // Never resolves → prefetch stays in-flight, no async-frame side effects.
  decodeTrajectoryFrame: vi.fn(() => new Promise<never>(() => {})),
  disposeTrajectoryLazy: disposeMock,
  shouldUseLazyTrajectory: () => true,
}));

import { useMeganeLocal } from "@/hooks/useMeganeLocal";
import { usePipelineStore } from "@/pipeline/store";

function makeStructure(nAtoms = 3): StructureParseResult {
  return {
    snapshot: {
      nAtoms,
      positions: new Float32Array(nAtoms * 3),
      elements: new Uint8Array(nAtoms).fill(6),
      bonds: new Uint32Array(0),
      box: null,
    },
    frames: [],
    meta: null,
    labels: null,
    vectorChannels: [],
  } as unknown as StructureParseResult;
}

/** Build an indexTrajectoryLazy handle: { trajectoryId, kind, index }. */
function trajHandle(trajectoryId: number, nFrames: number, nAtoms = 3) {
  return {
    trajectoryId,
    kind: "xtc" as const,
    index: {
      nAtoms,
      nFrames,
      timestepPs: 2,
      hasBox: false,
      box: null,
      times: new Float32Array(nFrames),
      vectorChannelNames: [] as string[],
    },
  };
}

async function flushBackground() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

/** Load a structure first (loadXtc requires a base snapshot). */
async function withStructure() {
  parseFileMock.mockResolvedValue(makeStructure(3));
  const hook = renderHook(() => useMeganeLocal());
  await act(async () => {
    await hook.result.current.loadFile(new File(["dummy"], "s.pdb"));
  });
  return hook;
}

describe("useMeganeLocal — two-phase lazy trajectory", () => {
  beforeEach(() => {
    parseFileMock.mockReset();
    frame0Mock.mockReset();
    indexTrajMock.mockReset();
    parseXtcMock.mockReset();
    disposeMock.mockReset();
    usePipelineStore.getState().reset();
  });

  it("shows frame 0 from the prefix (phase 1), then swaps in the stream (phase 2)", async () => {
    const { result } = await withStructure();
    frame0Mock.mockResolvedValue(new Float32Array(9).fill(5)); // phase 1
    // Hold phase 2 pending so phase 1 can be observed in isolation.
    let resolveIndex: (h: ReturnType<typeof trajHandle>) => void = () => {};
    indexTrajMock.mockImplementation(() => new Promise((r) => (resolveIndex = r)));

    await act(async () => {
      await result.current.loadXtc(new File(["dummy"], "big.xtc"));
    });

    // Phase 1: a single-frame provisional trajectory is on screen — no full read.
    expect(frame0Mock).toHaveBeenCalledTimes(1);
    expect(parseXtcMock).not.toHaveBeenCalled();
    expect(result.current.xtcFileName).toBe("big.xtc");
    expect(usePipelineStore.getState().fileFrames).toHaveLength(1);
    expect(usePipelineStore.getState().fileProvider).toBeNull();

    // Phase 2 (background): the streaming provider is swapped in.
    await act(async () => {
      resolveIndex(trajHandle(1, 20));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    const store = usePipelineStore.getState();
    expect(store.fileProvider).not.toBeNull();
    expect(store.fileProvider!.meta.nFrames).toBe(20);
    expect(store.fileFrames).toBeNull();
    expect(result.current.hasFileFrames).toBe(true);
  });

  it("seeds the provider's frame 0 so it serves synchronously after the swap", async () => {
    const { result } = await withStructure();
    const seed = new Float32Array(9).fill(7);
    frame0Mock.mockResolvedValue(seed);
    indexTrajMock.mockResolvedValue(trajHandle(4, 10));

    await act(async () => {
      await result.current.loadXtc(new File(["dummy"], "seed.xtc"));
    });
    await flushBackground();

    const provider = usePipelineStore.getState().fileProvider!;
    // Frame 0 is served from the seeded cache (the same Float32Array), no decode.
    expect(provider.getFrame(0)!.positions).toBe(seed);
  });

  it("falls back to a full-read index when the prefix can't hold frame 0", async () => {
    const { result } = await withStructure();
    frame0Mock.mockResolvedValue(null); // frame 0 too big for the prefix
    indexTrajMock.mockResolvedValue(trajHandle(2, 15));

    await act(async () => {
      await result.current.loadXtc(new File(["dummy"], "huge.xtc"));
    });

    // No provisional single frame; the full-read index attaches the stream directly.
    expect(usePipelineStore.getState().fileProvider).not.toBeNull();
    expect(usePipelineStore.getState().fileProvider!.meta.nFrames).toBe(15);
    expect(parseXtcMock).not.toHaveBeenCalled();
  });

  it("falls back to the eager parser when prefix and index are both unavailable", async () => {
    const { result } = await withStructure();
    frame0Mock.mockResolvedValue(null);
    indexTrajMock.mockResolvedValue(null);
    parseXtcMock.mockResolvedValue({
      frames: [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }],
      meta: { nFrames: 1, timestepPs: 1, nAtoms: 3 },
      vectorChannels: [],
    });

    await act(async () => {
      await result.current.loadXtc(new File(["dummy"], "x.xtc"));
    });

    expect(parseXtcMock).toHaveBeenCalledTimes(1);
    expect(usePipelineStore.getState().fileProvider).toBeNull();
    expect(usePipelineStore.getState().fileFrames).toHaveLength(1);
  });

  it("rejects a non-trajectory extension instead of guessing XTC", async () => {
    const { result } = await withStructure();
    await expect(result.current.loadXtc(new File(["dummy"], "run.trr"))).rejects.toThrow(
      /Unsupported trajectory format: run\.trr/,
    );
    expect(frame0Mock).not.toHaveBeenCalled();
    expect(indexTrajMock).not.toHaveBeenCalled();
    expect(parseXtcMock).not.toHaveBeenCalled();
  });

  it("disposes a stale phase-2 handle when a newer trajectory load supersedes it", async () => {
    const { result } = await withStructure();
    frame0Mock.mockResolvedValue(new Float32Array(9));
    // First load's index resolves LATE; a second load bumps the token meanwhile.
    let resolveFirst: (h: ReturnType<typeof trajHandle>) => void = () => {};
    indexTrajMock.mockImplementationOnce(
      () => new Promise((r) => (resolveFirst = r)), // load 1 index (pending)
    );
    indexTrajMock.mockResolvedValueOnce(trajHandle(99, 30)); // load 2 index

    await act(async () => {
      await result.current.loadXtc(new File(["dummy"], "a.xtc")); // phase 1 done, phase 2 pending
    });
    await act(async () => {
      await result.current.loadXtc(new File(["dummy"], "b.xtc")); // supersedes load 1
    });
    await flushBackground();

    // Now the first load's index finally resolves — it must be discarded + disposed.
    await act(async () => {
      resolveFirst(trajHandle(42, 12));
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(disposeMock).toHaveBeenCalledWith(42); // stale handle freed
    const store = usePipelineStore.getState();
    expect(store.fileProvider!.meta.nFrames).toBe(30); // load 2 won
  });
});
