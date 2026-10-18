import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/structure";

const localMock = vi.hoisted(() => ({
  loadFile: vi.fn(),
  applyStructureResult: vi.fn().mockResolvedValue(undefined),
  loadXtc: vi.fn(),
  seekFrame: vi.fn(),
  snapshot: null,
  frame: null,
  meta: null,
  currentFrame: 0,
  currentFrameRef: { current: 0 },
}));

vi.mock("@/hooks/useMeganeLocal", () => ({
  useMeganeLocal: () => localMock,
}));
vi.mock("@/hooks/useMeganeWebSocket", () => ({
  useMeganeWebSocket: () => ({
    snapshot: null,
    frame: null,
    meta: null,
    currentFrame: 0,
    currentFrameRef: { current: 0 },
    clientRef: { current: null },
  }),
}));

import { useDataSource } from "@/hooks/useDataSource";

describe("useDataSource.uploadStructure", () => {
  beforeEach(() => {
    localMock.loadFile.mockClear();
    localMock.applyStructureResult.mockClear();
  });

  it("reuses a pre-parsed result via applyStructureResult (no re-parse)", () => {
    const { result } = renderHook(() => useDataSource("local"));
    const file = new File(["x"], "mol.pdb");
    const preParsed = { snapshot: { nAtoms: 1 } } as unknown as StructureParseResult;

    result.current.uploadStructure(file, preParsed);

    expect(localMock.applyStructureResult).toHaveBeenCalledTimes(1);
    expect(localMock.applyStructureResult).toHaveBeenCalledWith(preParsed, "mol.pdb");
    expect(localMock.loadFile).not.toHaveBeenCalled();
  });

  it("falls back to loadFile (parse) when no pre-parsed result is supplied", () => {
    const { result } = renderHook(() => useDataSource("local"));
    const file = new File(["x"], "mol.pdb");

    result.current.uploadStructure(file);

    expect(localMock.loadFile).toHaveBeenCalledTimes(1);
    expect(localMock.loadFile).toHaveBeenCalledWith(file);
    expect(localMock.applyStructureResult).not.toHaveBeenCalled();
  });
});
