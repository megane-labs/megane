/**
 * A background phase of an older load never lands on a newer one.
 *
 * Large structure and trajectory files load in two phases: frame 0 first, then
 * the rest in the background. The background phase checks a load token before
 * it touches the pipeline, but only the large-file paths used to advance that
 * token, so a small file (or text, or an already-parsed result) opened while an
 * older large file was still indexing was overwritten by it: the old streaming
 * provider was attached to the new structure, the old file was re-applied, or
 * an old trajectory provider replaced the new trajectory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/parseCore";

const prefixMock = vi.hoisted(() => vi.fn());
const indexMock = vi.hoisted(() => vi.fn());
const parseFileMock = vi.hoisted(() => vi.fn());
const parseTextMock = vi.hoisted(() => vi.fn());
const frame0Mock = vi.hoisted(() => vi.fn());
const indexTrajMock = vi.hoisted(() => vi.fn());
const parseTrajMock = vi.hoisted(() => vi.fn());
const disposeMock = vi.hoisted(() => vi.fn());

/** Files at least this big take the two-phase path. */
const LAZY_BYTES = 10;

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseFileMock,
  parseStructureText: parseTextMock,
  parseStructurePrefix: prefixMock,
  parseStructureHead: vi.fn(),
  indexStructureLazy: indexMock,
  shouldUseLazyStructure: (_kind: string, size: number) => size >= LAZY_BYTES,
}));

vi.mock("@/parsers/xtc", () => ({
  indexTrajectoryLazy: indexTrajMock,
  decodeTrajectoryFrame0: frame0Mock,
  // Never resolves → prefetch stays in-flight, no async-frame side effects.
  decodeTrajectoryFrame: vi.fn(() => new Promise<never>(() => {})),
  disposeTrajectoryLazy: disposeMock,
  shouldUseLazyTrajectory: (_kind: string, size: number) => size >= LAZY_BYTES,
}));

vi.mock("@/parsers/trajectoryDispatch", () => ({
  parseTrajectoryByName: parseTrajMock,
}));

import { useMeganeLocal } from "@/hooks/useMeganeLocal";
import { usePipelineStore } from "@/pipeline/store";

function structure(nAtoms: number): StructureParseResult {
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

const big = (name: string) => new File(["x".repeat(LAZY_BYTES)], name);
const small = (name: string) => new File(["x"], name);

/** A promise the test resolves by hand, to hold a background phase open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function structureIndex(nFrames: number, frame0: StructureParseResult, heterogeneous = false) {
  return {
    handle: { trajectoryId: 7, kind: "xyz", index: { nAtoms: 3, nFrames, heterogeneous } },
    frame0,
  };
}

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
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** Open a big multi-frame XYZ and stop after phase 1 (frame 0 on screen). */
async function openBigStructure(index: Promise<unknown>) {
  const hook = renderHook(() => useMeganeLocal());
  prefixMock.mockResolvedValue(structure(3));
  indexMock.mockReturnValue(index);
  await act(async () => {
    await hook.result.current.loadFile(big("big.xyz"));
  });
  expect(hook.result.current.pdbFileName).toBe("big.xyz");
  return hook;
}

describe("useMeganeLocal — load tokens", () => {
  beforeEach(() => {
    for (const m of [
      prefixMock,
      indexMock,
      parseFileMock,
      parseTextMock,
      frame0Mock,
      indexTrajMock,
      parseTrajMock,
      disposeMock,
    ]) {
      m.mockReset();
    }
    usePipelineStore.getState().reset();
  });

  it("does not attach an old file's stream to a small file opened after it", async () => {
    const index = deferred<unknown>();
    const { result } = await openBigStructure(index.promise);
    const next = structure(2);
    parseFileMock.mockResolvedValue(next);
    await act(async () => {
      await result.current.loadFile(small("small.pdb"));
    });

    index.resolve(structureIndex(5, structure(3)));
    await flushBackground();

    expect(result.current.snapshot).toBe(next.snapshot);
    expect(result.current.pdbFileName).toBe("small.pdb");
    expect(usePipelineStore.getState().structureProvider).toBeNull();
    expect(result.current.hasStructureFrames).toBe(false);
  });

  it("does not re-apply an old heterogeneous file over a newer one", async () => {
    const index = deferred<unknown>();
    const { result } = await openBigStructure(index.promise);
    const next = structure(2);
    parseFileMock.mockResolvedValue(next);
    await act(async () => {
      await result.current.loadFile(small("small.pdb"));
    });

    parseFileMock.mockResolvedValue(structure(3));
    index.resolve(structureIndex(5, structure(3), true));
    await flushBackground();

    expect(parseFileMock).toHaveBeenCalledTimes(1); // the old file is not reparsed
    expect(result.current.snapshot).toBe(next.snapshot);
    expect(result.current.pdbFileName).toBe("small.pdb");
  });

  it("invalidates an older load on loadText and applyStructureResult", async () => {
    const first = deferred<unknown>();
    const hook = await openBigStructure(first.promise);
    const text = structure(4);
    parseTextMock.mockResolvedValue(text);
    await act(async () => {
      await hook.result.current.loadText("ATOM", "typed.pdb");
    });
    first.resolve(structureIndex(5, structure(3)));
    await flushBackground();
    expect(hook.result.current.snapshot).toBe(text.snapshot);
    expect(usePipelineStore.getState().structureProvider).toBeNull();

    const second = deferred<unknown>();
    indexMock.mockReturnValue(second.promise);
    await act(async () => {
      await hook.result.current.loadFile(big("big2.xyz"));
    });
    const parsed = structure(5);
    await act(async () => {
      await hook.result.current.applyStructureResult(parsed, "parsed.pdb");
    });
    second.resolve(structureIndex(5, structure(3)));
    await flushBackground();
    expect(hook.result.current.snapshot).toBe(parsed.snapshot);
    expect(usePipelineStore.getState().structureProvider).toBeNull();
  });

  it("keeps the newer of two overlapping small-file parses", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    const slow = deferred<StructureParseResult>();
    const fast = structure(2);
    parseFileMock.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(fast);
    let firstLoad!: Promise<void>;
    await act(async () => {
      firstLoad = result.current.loadFile(small("slow.pdb"));
      await result.current.loadFile(small("fast.pdb"));
    });
    await act(async () => {
      slow.resolve(structure(3));
      await firstLoad;
    });
    expect(result.current.snapshot).toBe(fast.snapshot);
    expect(result.current.pdbFileName).toBe("fast.pdb");
  });

  it("does not let an old large trajectory replace a newer small one", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    parseFileMock.mockResolvedValue(structure(3));
    await act(async () => {
      await result.current.loadFile(small("s.pdb"));
    });

    frame0Mock.mockResolvedValue(new Float32Array(9).fill(1));
    const index = deferred<ReturnType<typeof trajHandle> | null>();
    indexTrajMock.mockReturnValue(index.promise);
    await act(async () => {
      await result.current.loadXtc(big("big.xtc"));
    });

    const frames = [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }];
    parseTrajMock.mockResolvedValue({
      frames,
      meta: { nFrames: 1, timestepPs: 1, nAtoms: 3 },
      vectorChannels: [],
    });
    await act(async () => {
      await result.current.loadXtc(small("small.xtc"));
    });

    index.resolve(trajHandle(3, 20));
    await flushBackground();

    expect(disposeMock).toHaveBeenCalledWith(3);
    expect(usePipelineStore.getState().fileProvider).toBeNull();
    expect(usePipelineStore.getState().fileFrames).toBe(frames);
    expect(result.current.xtcFileName).toBe("small.xtc");
  });

  it("does not attach an old structure's trajectory to a newly opened structure", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    parseFileMock.mockResolvedValue(structure(3));
    await act(async () => {
      await result.current.loadFile(small("s.pdb"));
    });

    frame0Mock.mockResolvedValue(new Float32Array(9).fill(1));
    const index = deferred<ReturnType<typeof trajHandle> | null>();
    indexTrajMock.mockReturnValue(index.promise);
    await act(async () => {
      await result.current.loadXtc(big("big.xtc"));
    });

    parseFileMock.mockResolvedValue(structure(2));
    await act(async () => {
      await result.current.loadFile(small("other.pdb"));
    });
    index.resolve(trajHandle(4, 20));
    await flushBackground();

    expect(disposeMock).toHaveBeenCalledWith(4);
    expect(usePipelineStore.getState().fileProvider).toBeNull();
    expect(result.current.hasFileFrames).toBe(false);
  });

  it("drops an eager trajectory parse superseded by a newer trajectory", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    parseFileMock.mockResolvedValue(structure(3));
    await act(async () => {
      await result.current.loadFile(small("s.pdb"));
    });

    const slow = deferred<unknown>();
    const newer = [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9).fill(2) }];
    parseTrajMock.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({
      frames: newer,
      meta: { nFrames: 1, timestepPs: 1, nAtoms: 3 },
      vectorChannels: [],
    });
    let firstLoad!: Promise<void>;
    await act(async () => {
      firstLoad = result.current.loadXtc(small("old.xtc"));
      await result.current.loadXtc(small("new.xtc"));
    });
    await act(async () => {
      slow.resolve({
        frames: [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }],
        meta: { nFrames: 1, timestepPs: 1, nAtoms: 3 },
        vectorChannels: [],
      });
      await firstLoad;
    });
    expect(usePipelineStore.getState().fileFrames).toBe(newer);
    expect(result.current.xtcFileName).toBe("new.xtc");
  });

  it("drops a large file's full-read fallback and text parse once a newer load starts", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    // The prefix cannot hold frame 0, so the load falls back to one full read.
    prefixMock.mockResolvedValue(null);
    const index = deferred<unknown>();
    indexMock.mockReturnValue(index.promise);
    let bigLoad!: Promise<void>;
    act(() => {
      bigLoad = result.current.loadFile(big("big.xyz"));
    });
    await flushBackground(); // the prefix came back empty; the full read is pending
    expect(indexMock).toHaveBeenCalledTimes(1);
    const text = deferred<StructureParseResult>();
    parseTextMock.mockReturnValue(text.promise);
    let textLoad!: Promise<StructureParseResult>;
    act(() => {
      textLoad = result.current.loadText("ATOM", "typed.pdb");
    });
    const next = structure(2);
    parseFileMock.mockResolvedValue(next);
    await act(async () => {
      await result.current.loadFile(small("small.pdb"));
    });

    await act(async () => {
      index.resolve(structureIndex(5, structure(3)));
      await bigLoad;
      text.resolve(structure(4));
      await textLoad;
    });
    expect(disposeMock).toHaveBeenCalledWith(7);
    expect(result.current.snapshot).toBe(next.snapshot);
    expect(result.current.pdbFileName).toBe("small.pdb");
    expect(usePipelineStore.getState().structureProvider).toBeNull();
  });

  it("drops a large trajectory's frame 0 and full-read fallback once a newer one starts", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    parseFileMock.mockResolvedValue(structure(3));
    await act(async () => {
      await result.current.loadFile(small("s.pdb"));
    });

    // First load: frame 0 still decoding. Second: no frame 0, full-read index pending.
    const frame0 = deferred<Float32Array | null>();
    frame0Mock.mockReturnValueOnce(frame0.promise).mockResolvedValueOnce(null);
    const index = deferred<ReturnType<typeof trajHandle> | null>();
    indexTrajMock.mockReturnValue(index.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.loadXtc(big("first.xtc"));
    });
    await act(async () => {
      second = result.current.loadXtc(big("second.xtc"));
      await Promise.resolve();
    });
    const frames = [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }];
    parseTrajMock.mockResolvedValue({
      frames,
      meta: { nFrames: 1, timestepPs: 1, nAtoms: 3 },
      vectorChannels: [],
    });
    await act(async () => {
      await result.current.loadXtc(small("third.xtc"));
    });

    await act(async () => {
      frame0.resolve(new Float32Array(9).fill(1));
      await first;
      index.resolve(trajHandle(5, 20));
      await second;
    });
    expect(disposeMock).toHaveBeenCalledWith(5);
    expect(usePipelineStore.getState().fileProvider).toBeNull();
    expect(usePipelineStore.getState().fileFrames).toBe(frames);
    expect(result.current.xtcFileName).toBe("third.xtc");
  });
});
