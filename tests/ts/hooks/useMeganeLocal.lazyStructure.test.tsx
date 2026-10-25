/**
 * Tests the two-phase lazy structure path in useMeganeLocal.loadFile.
 * Phase 1: parseStructurePrefix parses frame 0 from a bounded prefix → instant
 * first paint. Phase 2 (background): indexStructureLazy builds the full index and
 * attaches the streaming provider. Prefix-miss falls back to a single full read;
 * only a null index (worker unavailable) falls back to the eager parser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/parseCore";

const prefixMock = vi.hoisted(() => vi.fn());
const indexMock = vi.hoisted(() => vi.fn());
const parseFileMock = vi.hoisted(() => vi.fn());
const disposeMock = vi.hoisted(() => vi.fn());

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseFileMock,
  parseStructureText: vi.fn(),
  parseStructurePrefix: prefixMock,
  indexStructureLazy: indexMock,
  shouldUseLazyStructure: () => true,
}));

vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: vi.fn(),
  parseLammpstrjFile: vi.fn(),
  parseDCDFile: vi.fn(),
  parseNetCDFFile: vi.fn(),
  indexTrajectoryLazy: vi.fn(),
  // Never resolves → prefetch stays in-flight, no async-frame side effects in the test.
  decodeTrajectoryFrame: vi.fn(() => new Promise<never>(() => {})),
  disposeTrajectoryLazy: disposeMock,
  shouldUseLazyTrajectory: () => false,
}));

import { useMeganeLocal } from "@/hooks/useMeganeLocal";
import { usePipelineStore } from "@/pipeline/store";

function makeFrame0(): StructureParseResult {
  return {
    snapshot: {
      nAtoms: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      elements: new Uint8Array([6, 1, 1]),
      bonds: new Uint32Array(0),
      box: null,
    },
    frames: [],
    meta: null,
    labels: null,
    vectorChannels: [],
  } as unknown as StructureParseResult;
}

/** Build the `indexStructureLazy` result: { handle, frame0 }. */
function indexed(
  trajectoryId: number,
  kind: "xyz" | "pdb",
  nFrames: number,
  frame0: StructureParseResult,
) {
  return { handle: { trajectoryId, kind, index: { nAtoms: 3, nFrames } }, frame0 };
}

/** Drain the microtasks the fire-and-forget Phase-2 promise chain schedules. */
async function flushBackground() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useMeganeLocal — two-phase lazy structure", () => {
  beforeEach(() => {
    prefixMock.mockReset();
    indexMock.mockReset();
    parseFileMock.mockReset();
    disposeMock.mockReset();
    usePipelineStore.getState().reset();
  });

  it("renders frame 0 from the prefix (phase 1), then attaches the stream (phase 2)", async () => {
    const f0 = makeFrame0();
    prefixMock.mockResolvedValue(f0); // phase 1: instant frame 0
    indexMock.mockResolvedValue(indexed(1, "xyz", 5, f0)); // phase 2: index

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "big.xyz"));
    });

    // Phase 1: frame 0 is on screen immediately from the prefix — no full read.
    expect(result.current.snapshot).toBe(f0.snapshot);
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(result.current.pdbFileName).toBe("big.xyz");

    // Phase 2 (background): the streaming provider is attached.
    await flushBackground();
    const store = usePipelineStore.getState();
    expect(store.structureProvider).not.toBeNull();
    expect(store.structureProvider!.meta.nFrames).toBe(6); // 5 extra + frame 0
    expect(store.structureFrames).toBeNull();
    expect(result.current.hasStructureFrames).toBe(true);
  });

  it("attaches a multi-MODEL PDB stream after prefix first paint", async () => {
    const f0 = makeFrame0();
    prefixMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue(indexed(9, "pdb", 2, f0));

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "traj.pdb"));
    });
    expect(result.current.snapshot).toBe(f0.snapshot);
    await flushBackground();

    expect(usePipelineStore.getState().structureProvider).not.toBeNull();
    expect(usePipelineStore.getState().structureProvider!.meta.nFrames).toBe(3);
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("streams an ASE .traj: frame 0 from its head and tail, then the frame index", async () => {
    const f0 = makeFrame0();
    prefixMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue(indexed(11, "traj", 3, f0));
    const file = new File(["dummy"], "md.traj");

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(file);
    });
    expect(prefixMock).toHaveBeenCalledWith(file, "traj");
    expect(result.current.snapshot).toBe(f0.snapshot);
    await flushBackground();
    expect(indexMock).toHaveBeenCalledWith(file, "traj");
    expect(usePipelineStore.getState().structureProvider!.meta.nFrames).toBe(4);
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("keeps a single-frame file static (no stream attached)", async () => {
    const f0 = makeFrame0();
    prefixMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue(indexed(2, "xyz", 0, f0)); // no extra frames

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "single.xyz"));
    });
    await flushBackground();

    // Frame 0 stays static; the background index decoder is freed, no provider.
    expect(disposeMock).toHaveBeenCalledWith(2);
    expect(usePipelineStore.getState().structureProvider).toBeNull();
    expect(result.current.snapshot).toBe(f0.snapshot);
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("offers a streamed .traj's vector channels, frame 0's from the index", async () => {
    const f0 = makeFrame0(); // frame 0 from the file's first bytes: no vectors
    prefixMock.mockResolvedValue(f0);
    const momenta = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const indexedFrame0 = {
      ...makeFrame0(),
      vectorChannels: [{ name: "momenta", frames: [{ frame: 0, vectors: momenta }] }],
    };
    indexMock.mockResolvedValue({
      handle: {
        trajectoryId: 12,
        kind: "traj",
        index: { nAtoms: 3, nFrames: 2, vectorChannelNames: ["momenta"] },
      },
      frame0: indexedFrame0,
    });

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "md.traj"));
    });
    await flushBackground();

    const channels = usePipelineStore.getState().embeddedVectorChannels;
    expect(channels?.map((c) => c.name)).toEqual(["momenta"]);
    expect(channels![0].frames).toEqual([{ frame: 0, vectors: momenta }]);
  });

  it("falls back to a single full read when the prefix can't hold frame 0", async () => {
    const f0 = makeFrame0();
    prefixMock.mockResolvedValue(null); // frame 0 too big for the prefix
    indexMock.mockResolvedValue(indexed(3, "xyz", 5, f0)); // full read still streams

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "huge.xyz"));
    });

    expect(result.current.snapshot).toBe(f0.snapshot);
    expect(usePipelineStore.getState().structureProvider).not.toBeNull();
    expect(parseFileMock).not.toHaveBeenCalled();
  });

  it("falls back to eager parse when both prefix and index are unavailable", async () => {
    prefixMock.mockResolvedValue(null);
    indexMock.mockResolvedValue(null);
    const eager = makeFrame0();
    parseFileMock.mockResolvedValue(eager);

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "x.xyz"));
    });

    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(usePipelineStore.getState().structureProvider).toBeNull();
    expect(result.current.snapshot).toBe(eager.snapshot);
  });
});
