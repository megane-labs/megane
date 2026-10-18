import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/structure";

const parseMock = vi.hoisted(() => vi.fn());

vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseMock,
  parseStructureText: vi.fn(),
  // Lazy structure streaming is disabled here so loadFile takes the eager path.
  shouldUseLazyStructure: () => false,
  indexStructureLazy: vi.fn(async () => null),
}));

import { useMeganeLocal } from "@/hooks/useMeganeLocal";

function makeResult(overrides: Partial<StructureParseResult> = {}): StructureParseResult {
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
    ...overrides,
  } as unknown as StructureParseResult;
}

describe("useMeganeLocal.applyStructureResult", () => {
  beforeEach(() => {
    parseMock.mockReset();
  });

  it("applies an already-parsed result WITHOUT re-parsing the file", async () => {
    const { result } = renderHook(() => useMeganeLocal());
    const res = makeResult();

    await act(async () => {
      await result.current.applyStructureResult(res, "test.pdb");
    });

    // The key guarantee: no second file read / WASM parse.
    expect(parseMock).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBe(res.snapshot);
    expect(result.current.pdbFileName).toBe("test.pdb");
  });

  it("loadFile parses exactly once and then applies the result", async () => {
    const res = makeResult();
    parseMock.mockResolvedValue(res);
    const { result } = renderHook(() => useMeganeLocal());

    await act(async () => {
      await result.current.loadFile(new File(["dummy"], "mol.pdb"));
    });

    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(res.snapshot);
    expect(result.current.pdbFileName).toBe("mol.pdb");
  });
});

describe("useMeganeLocal.seekFrame", () => {
  it("serves frame 0 from the base snapshot and later frames from the structure frames", async () => {
    const extra = [
      { frameId: 1, nAtoms: 3, positions: new Float32Array(9).fill(1) },
      { frameId: 2, nAtoms: 3, positions: new Float32Array(9).fill(2) },
    ];
    const res = makeResult({ frames: extra } as Partial<StructureParseResult>);
    const { result } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await result.current.applyStructureResult(res, "multi.xyz");
    });
    expect(result.current.trajectorySource).toBe("structure");

    act(() => result.current.seekFrame(2));
    expect(result.current.frame).toBe(extra[1]);
    expect(result.current.currentFrame).toBe(2);
    expect(result.current.currentFrameRef.current).toBe(2);

    act(() => result.current.seekFrame(0));
    expect(result.current.frame).toEqual({
      frameId: 0,
      nAtoms: 3,
      positions: res.snapshot.positions,
    });

    // Out-of-range frames move the cursor but keep the last delivered frame.
    act(() => result.current.seekFrame(9));
    expect(result.current.frame?.frameId).toBe(0);
    expect(result.current.currentFrame).toBe(9);
  });

  it("only moves the cursor when no structure is loaded", () => {
    const { result } = renderHook(() => useMeganeLocal());
    act(() => result.current.seekFrame(0));
    expect(result.current.frame).toBeNull();
    expect(result.current.currentFrame).toBe(0);
  });
});
