import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/structure";

const parseMock = vi.hoisted(() => vi.fn());
const shouldLazyMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseMock,
  shouldUseLazyStructure: shouldLazyMock,
}));

import { useNodeLoadHandlers } from "@/hooks/useNodeLoadHandlers";
import { usePipelineStore } from "@/pipeline/store";
import { globalLoadHandlers } from "@/stores/loadHandlers";

// The hook registers into the load-handler slots rather than a module-level
// setter, so the test reads the registered handler back off the global bundle
// — which is what `useLoadHandlers()` resolves to with no provider mounted.
const captured = {
  get structure() {
    return globalLoadHandlers.structure;
  },
  set structure(fn) {
    globalLoadHandlers.setStructure(fn);
  },
};

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

function seedStore(nodeId = "n1") {
  usePipelineStore.setState({
    nodes: [
      {
        id: nodeId,
        type: "load_structure",
        position: { x: 0, y: 0 },
        data: {},
      } as never,
    ],
    setNodeSnapshot: vi.fn(),
    updateNodeParams: vi.fn(),
    setNodeParseError: vi.fn(),
    clearNodeParseError: vi.fn(),
    setFileVectors: vi.fn(),
  });
}

describe("useNodeLoadHandlers — double-parse fix", () => {
  beforeEach(() => {
    captured.structure = null;
    parseMock.mockReset();
    shouldLazyMock.mockReset();
    shouldLazyMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parses the file once and forwards the parsed result to onUploadStructure for the primary node", async () => {
    seedStore("n1");
    const result = makeResult();
    parseMock.mockResolvedValue(result);
    const onUploadStructure = vi.fn();

    renderHook(() => useNodeLoadHandlers({ snapshot: null, onUploadStructure }));

    const file = new File(["dummy"], "mol.pdb");
    await act(async () => {
      captured.structure?.("n1", file);
      await Promise.resolve();
    });

    // The file is read + WASM-parsed exactly ONCE (previously twice).
    expect(parseMock).toHaveBeenCalledTimes(1);
    // The legacy load path receives the already-parsed result, not just the file.
    expect(onUploadStructure).toHaveBeenCalledTimes(1);
    expect(onUploadStructure).toHaveBeenCalledWith(file, result);
    // The node snapshot is still populated from the same parse.
    expect(usePipelineStore.getState().setNodeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does NOT drive the legacy load path for a non-primary node", async () => {
    seedStore("n1");
    parseMock.mockResolvedValue(makeResult());
    const onUploadStructure = vi.fn();

    renderHook(() => useNodeLoadHandlers({ snapshot: null, onUploadStructure }));

    const file = new File(["dummy"], "mol.pdb");
    await act(async () => {
      captured.structure?.("n2", file);
      await Promise.resolve();
    });

    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(onUploadStructure).not.toHaveBeenCalled();
  });

  it("routes a large multi-frame XYZ to the lazy loader without an eager parse", async () => {
    seedStore("n1");
    shouldLazyMock.mockReturnValue(true);
    const onUploadStructure = vi.fn();

    renderHook(() => useNodeLoadHandlers({ snapshot: null, onUploadStructure }));

    const file = new File(["dummy"], "big.xyz");
    await act(async () => {
      captured.structure?.("n1", file);
      await Promise.resolve();
    });

    // No eager full-file parse; the file is handed to the lazy loader (no preParsed).
    expect(parseMock).not.toHaveBeenCalled();
    expect(onUploadStructure).toHaveBeenCalledExactlyOnceWith(file);
    expect(shouldLazyMock).toHaveBeenCalledWith("xyz", file.size);
  });

  it("routes a large multi-MODEL PDB to the lazy loader", async () => {
    seedStore("n1");
    shouldLazyMock.mockReturnValue(true);
    const onUploadStructure = vi.fn();

    renderHook(() => useNodeLoadHandlers({ snapshot: null, onUploadStructure }));

    const file = new File(["dummy"], "trajectory.pdb");
    await act(async () => {
      captured.structure?.("n1", file);
      await Promise.resolve();
    });

    expect(parseMock).not.toHaveBeenCalled();
    expect(onUploadStructure).toHaveBeenCalledExactlyOnceWith(file);
    expect(shouldLazyMock).toHaveBeenCalledWith("pdb", file.size);
  });

  it("keeps the eager path for a small XYZ (lazy declined)", async () => {
    seedStore("n1");
    shouldLazyMock.mockReturnValue(false);
    parseMock.mockResolvedValue(makeResult());
    const onUploadStructure = vi.fn();

    renderHook(() => useNodeLoadHandlers({ snapshot: null, onUploadStructure }));

    const file = new File(["dummy"], "small.xyz");
    await act(async () => {
      captured.structure?.("n1", file);
      await Promise.resolve();
    });

    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(onUploadStructure).toHaveBeenCalledWith(file, expect.anything());
  });

  it("does not call onUploadStructure when parsing fails", async () => {
    seedStore("n1");
    parseMock.mockRejectedValue(new Error("bad file"));
    const onUploadStructure = vi.fn();

    renderHook(() => useNodeLoadHandlers({ snapshot: null, onUploadStructure }));

    const file = new File(["dummy"], "mol.pdb");
    await act(async () => {
      captured.structure?.("n1", file);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onUploadStructure).not.toHaveBeenCalled();
    expect(usePipelineStore.getState().setNodeParseError).toHaveBeenCalledTimes(1);
  });
});
