/**
 * Tests useMeganeLocal.loadFileProgressive: a host delivers a large file's head
 * and tail first (src/hosts/progressiveFile.ts). Frame 0 is drawn from those,
 * and the rest of the frames come in when the whole file arrives — through the
 * lazy index (XYZ / PDB / ASE .traj), or through a full parse for a file too
 * small to stream or one the index cannot read frame by frame.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/parseCore";
import type { ProgressiveFile } from "@/hosts/progressiveFile";

const headMock = vi.hoisted(() => vi.fn());
const prefixMock = vi.hoisted(() => vi.fn());
const indexMock = vi.hoisted(() => vi.fn());
const parseFileMock = vi.hoisted(() => vi.fn());
const disposeMock = vi.hoisted(() => vi.fn());
const lazyMock = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseFileMock,
  parseStructureText: vi.fn(),
  parseStructureHead: headMock,
  parseStructurePrefix: prefixMock,
  indexStructureLazy: indexMock,
  shouldUseLazyStructure: lazyMock,
}));

vi.mock("@/parsers/xtc", () => ({
  parseXTCFile: vi.fn(),
  parseLammpstrjFile: vi.fn(),
  parseDCDFile: vi.fn(),
  parseNetCDFFile: vi.fn(),
  indexTrajectoryLazy: vi.fn(),
  decodeTrajectoryFrame: vi.fn(() => new Promise<never>(() => {})),
  disposeTrajectoryLazy: disposeMock,
  shouldUseLazyTrajectory: () => false,
}));

import { useMeganeLocal } from "@/hooks/useMeganeLocal";
import { usePipelineStore } from "@/pipeline/store";

function makeResult(nFrames = 0): StructureParseResult {
  return {
    snapshot: {
      nAtoms: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      elements: new Uint8Array([6, 1, 1]),
      bonds: new Uint32Array(0),
      box: null,
    },
    frames: Array.from({ length: nFrames }, (_, i) => ({
      frameId: i + 1,
      nAtoms: 3,
      positions: new Float32Array(9),
    })),
    meta: nFrames > 0 ? { nFrames: nFrames + 1, timestepPs: 1, nAtoms: 3 } : null,
    labels: null,
    vectorChannels: [],
  } as unknown as StructureParseResult;
}

/** A progressive file whose whole-file promise the test resolves by hand. */
function progressive(name: string): { pf: ProgressiveFile; deliver: () => File } {
  let resolve!: (f: File) => void;
  const file = new Promise<File>((r) => (resolve = r));
  const whole = new File(["whole"], name);
  return {
    pf: { name, size: 64 * 1024 * 1024, head: new Uint8Array(4), tail: new Uint8Array(2), file },
    deliver: () => {
      resolve(whole);
      return whole;
    },
  };
}

async function flushBackground() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe("useMeganeLocal.loadFileProgressive", () => {
  beforeEach(() => {
    // Reset the store first: it disposes the previous test's stream.
    usePipelineStore.getState().reset();
    for (const m of [headMock, prefixMock, indexMock, parseFileMock, disposeMock]) m.mockReset();
    lazyMock.mockReset().mockReturnValue(true);
  });

  it("draws an XYZ's frame 0 from the head, then streams once the whole file arrives", async () => {
    const f0 = makeResult();
    headMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue({
      handle: { trajectoryId: 4, kind: "xyz", index: { nAtoms: 3, nFrames: 7 } },
      frame0: f0,
    });
    const { pf, deliver } = progressive("big.xyz");

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFileProgressive(pf);
    });
    expect(headMock).toHaveBeenCalledWith(pf.head, pf.tail, pf.size, "xyz");
    expect(result.current.snapshot).toBe(f0.snapshot);
    expect(indexMock).not.toHaveBeenCalled();

    const whole = deliver();
    await flushBackground();
    expect(indexMock).toHaveBeenCalledWith(whole, "xyz");
    expect(usePipelineStore.getState().structureProvider!.meta.nFrames).toBe(8);
    expect(result.current.snapshot).toBe(f0.snapshot);
  });

  it("streams a large .traj after its head-and-tail frame 0", async () => {
    const f0 = makeResult();
    headMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue({
      handle: { trajectoryId: 6, kind: "traj", index: { nAtoms: 3, nFrames: 4 } },
      frame0: makeResult(),
    });
    const { pf, deliver } = progressive("run.traj");

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFileProgressive(pf);
    });
    expect(headMock).toHaveBeenCalledWith(pf.head, pf.tail, pf.size, "traj");
    const whole = deliver();
    await flushBackground();
    expect(indexMock).toHaveBeenCalledWith(whole, "traj");
    expect(parseFileMock).not.toHaveBeenCalled();
    expect(usePipelineStore.getState().structureProvider!.meta.nFrames).toBe(5);
    expect(result.current.snapshot).toBe(f0.snapshot);
  });

  it.each([
    ["cannot be indexed frame by frame", null],
    [
      "changes its atoms",
      { handle: { trajectoryId: 7, kind: "traj", index: { nFrames: 5, heterogeneous: true } } },
    ],
  ])("parses a large .traj whole when it %s, keeping frame 0", async (_why, indexed) => {
    const f0 = makeResult();
    headMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue(indexed);
    parseFileMock.mockResolvedValue(makeResult(5));
    const { pf, deliver } = progressive("npt.traj");

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFileProgressive(pf);
    });
    deliver();
    await flushBackground();
    expect(disposeMock).toHaveBeenCalledTimes(indexed ? 1 : 0);
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(f0.snapshot);
    expect(usePipelineStore.getState().structureFrames).toHaveLength(5);
  });

  it("parses a whole .traj too small to stream, keeping the frame-0 snapshot", async () => {
    lazyMock.mockReturnValue(false);
    const f0 = makeResult();
    const full = makeResult(5);
    headMock.mockResolvedValue(f0);
    parseFileMock.mockResolvedValue(full);
    const { pf, deliver } = progressive("run.traj");

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFileProgressive(pf);
    });
    expect(headMock).toHaveBeenCalledWith(pf.head, pf.tail, pf.size, "traj");
    expect(result.current.snapshot).toBe(f0.snapshot);

    deliver();
    await flushBackground();
    expect(indexMock).not.toHaveBeenCalled();
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    // Same snapshot object → the viewer does not re-fit the camera.
    expect(result.current.snapshot).toBe(f0.snapshot);
    expect(usePipelineStore.getState().structureFrames).toHaveLength(5);
    expect(result.current.hasStructureFrames).toBe(true);
  });

  it("reparses a heterogeneous file eagerly once it has arrived", async () => {
    const f0 = makeResult();
    const eager = makeResult(2);
    headMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue({
      handle: {
        trajectoryId: 5,
        kind: "pdb",
        index: { nAtoms: 3, nFrames: 2, heterogeneous: true },
      },
      frame0: f0,
    });
    parseFileMock.mockResolvedValue(eager);
    const { pf, deliver } = progressive("mixed.pdb");

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFileProgressive(pf);
    });
    deliver();
    await flushBackground();
    expect(disposeMock).toHaveBeenCalledWith(5);
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(eager.snapshot);
  });

  it("waits for the whole file when the head cannot hold frame 0", async () => {
    headMock.mockResolvedValue(null);
    const f0 = makeResult();
    prefixMock.mockResolvedValue(f0);
    indexMock.mockResolvedValue(null);
    const { pf, deliver } = progressive("huge.xyz");

    const { result } = renderHook(() => useMeganeLocal());
    let done = false;
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadFileProgressive(pf).then(() => {
        done = true;
      });
    });
    await flushBackground();
    expect(done).toBe(false);
    expect(prefixMock).not.toHaveBeenCalled();

    const whole = deliver();
    await act(async () => {
      await loading;
    });
    // The ordinary lazy load of the whole file.
    expect(prefixMock).toHaveBeenCalledWith(whole, "xyz");
    expect(result.current.snapshot).toBe(f0.snapshot);
  });

  it("loads formats with no head reader from the whole file", async () => {
    lazyMock.mockReturnValue(false);
    const eager = makeResult();
    parseFileMock.mockResolvedValue(eager);
    const { pf, deliver } = progressive("box.gro");

    const { result } = renderHook(() => useMeganeLocal());
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadFileProgressive(pf);
    });
    deliver();
    await act(async () => {
      await loading;
    });
    expect(headMock).not.toHaveBeenCalled();
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(eager.snapshot);
  });

  it("drops the rest of a file a newer load has replaced", async () => {
    const f0 = makeResult();
    headMock.mockResolvedValue(f0);
    const { pf, deliver } = progressive("old.traj");
    const newer = makeResult();
    parseFileMock.mockResolvedValue(newer);

    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.loadFileProgressive(pf);
    });
    // A newer progressive load (whose head the worker cannot read) takes over…
    headMock.mockResolvedValueOnce(null);
    const second = progressive("new.traj");
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadFileProgressive(second.pf);
    });
    await flushBackground();
    // …so the old file's arrival must not parse or apply anything.
    deliver();
    await flushBackground();
    expect(parseFileMock).not.toHaveBeenCalled();

    second.deliver();
    await act(async () => {
      await loading;
    });
    expect(parseFileMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(newer.snapshot);
  });
});
