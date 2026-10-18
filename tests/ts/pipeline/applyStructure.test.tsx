/**
 * Every structure-open path writes the parse into the pipeline through one
 * helper, `applyStructureToPipeline`. These tests open the same file through
 * each path — `usePipelineStore.openFile` (webapp drag-drop, JupyterLab
 * `.megane.json` merges), `useMeganeLocal.applyStructureResult` (the VSCode and
 * JupyterLab single-file viewers) and the Load Structure node's own picker
 * (`useNodeLoadHandlers`) — and assert they leave the store identical. Each
 * block pins one place the three copies used to disagree.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { StructureParseResult } from "@/parsers/structure";

const parseMock = vi.hoisted(() => vi.fn());
vi.mock("@/parsers/structure", () => ({
  parseStructureFile: parseMock,
  parseStructureText: vi.fn(),
  parseStructurePrefix: vi.fn(async () => null),
  indexStructureLazy: vi.fn(async () => null),
  shouldUseLazyStructure: () => false,
  parseTopBonds: vi.fn(),
  parsePsfBonds: vi.fn(),
}));

import { useMeganeLocal } from "@/hooks/useMeganeLocal";
import { useNodeLoadHandlers } from "@/hooks/useNodeLoadHandlers";
import { usePipelineStore } from "@/pipeline/store";
import {
  applyStructureToPipeline,
  ensureStructureLoader,
  installMinimalGraph,
} from "@/pipeline/openFile";
import { globalLoadHandlers } from "@/stores/loadHandlers";
import { LazyFrameProvider } from "@/stream/LazyFrameProvider";
import type { Frame, Snapshot, TrajectoryMeta } from "@/types";

type OpenPath = "openFile" | "useMeganeLocal" | "nodeHandler";
const PATHS: OpenPath[] = ["openFile", "useMeganeLocal", "nodeHandler"];

function makeSnapshot(nAtoms = 3): Snapshot {
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms).fill(6),
    bonds: new Uint32Array(0),
    bondOrders: new Uint8Array(0),
    box: null,
  };
}

function makeFrame(frameId: number, nAtoms = 3): Frame {
  return { frameId, nAtoms, positions: new Float32Array(nAtoms * 3).fill(frameId) };
}

function makeResult(overrides: Partial<StructureParseResult> = {}): StructureParseResult {
  return {
    snapshot: makeSnapshot(3),
    frames: [],
    meta: null,
    labels: null,
    vectorChannels: [],
    scalarChannels: [],
    warnings: [],
    ...overrides,
  };
}

function multiFrameResult(nAtoms = 3): StructureParseResult {
  const frames = [makeFrame(1, nAtoms), makeFrame(2, nAtoms)];
  const meta: TrajectoryMeta = { nFrames: 3, timestepPs: 1, nAtoms };
  return makeResult({ snapshot: makeSnapshot(nAtoms), frames, meta });
}

/** Open `result` as `fileName` through one of the three host paths. */
async function openVia(path: OpenPath, result: StructureParseResult, fileName: string) {
  parseMock.mockResolvedValueOnce(result);
  const file = new File(["<data>"], fileName);
  if (path === "openFile") {
    await usePipelineStore.getState().openFile(file);
    return;
  }
  if (path === "useMeganeLocal") {
    const { result: hook, unmount } = renderHook(() => useMeganeLocal());
    await act(async () => {
      await hook.current.applyStructureResult(result, fileName);
    });
    unmount();
    return;
  }
  // The node picker with a no-op legacy loader (the multi-instance harness
  // wires it this way), so only the node path itself is exercised.
  const { unmount } = renderHook(() =>
    useNodeLoadHandlers({ snapshot: null, onUploadStructure: () => {} }),
  );
  const loaderId = usePipelineStore.getState().nodes.find((n) => n.type === "load_structure")!.id;
  await act(async () => {
    globalLoadHandlers.structure?.(loaderId, file);
  });
  await vi.waitFor(() =>
    expect(usePipelineStore.getState().nodeSnapshots[loaderId]?.snapshot).toBe(result.snapshot),
  );
  unmount();
}

function params(id: string): Record<string, unknown> {
  return usePipelineStore.getState().nodes.find((n) => n.id === id)!.data.params as never;
}

function setTrajName(fileName: string) {
  usePipelineStore.getState().updateNodeParams("traj-1", { fileName });
}

beforeEach(() => {
  parseMock.mockReset();
  globalLoadHandlers.setStructure(null);
  usePipelineStore.getState().reset();
  installMinimalGraph(usePipelineStore);
  usePipelineStore.setState({ embeddedVectorChannels: null, activeEmbeddedVectorChannel: null });
});

describe.each(PATHS)("structure open via %s", (path) => {
  it("offers the file's embedded vector channels to the load_vector UI", async () => {
    // Before: only openFile and the node picker did; the VSCode / JupyterLab
    // single-file path (useMeganeLocal) dropped GRO velocities.
    const velocities = [{ frame: 0, vectors: new Float32Array(9) }];
    await openVia(
      path,
      makeResult({ vectorChannels: [{ name: "velocity", frames: velocities }] }),
      "water.gro",
    );
    expect(usePipelineStore.getState().embeddedVectorChannels).toEqual([
      { name: "velocity", frames: velocities },
    ]);
  });

  it("feeds a multi-frame file's frames into the structure channel", async () => {
    // Before: only useMeganeLocal called setStructureFrames.
    const result = multiFrameResult();
    await openVia(path, result, "traj.xyz");
    const state = usePipelineStore.getState();
    expect(state.structureFrames).toBe(result.frames);
    expect(state.structureMeta).toEqual(result.meta);
  });

  it("drops the file trajectory and flips LoadTrajectory to the structure source for a multi-frame file", async () => {
    // Before: useMeganeLocal also copied the frames into the file channel.
    usePipelineStore
      .getState()
      .setFileFrames([makeFrame(0)], { nFrames: 1, timestepPs: 1, nAtoms: 3 });
    setTrajName("run.xtc");
    await openVia(path, multiFrameResult(), "traj.xyz");
    const state = usePipelineStore.getState();
    expect(state.fileFrames).toBeNull();
    expect(params("traj-1")).toMatchObject({ source: "structure", fileName: "" });
    expect(params("loader-1")).toMatchObject({ fileName: "traj.xyz", hasTrajectory: true });
  });

  it("does not let a single-frame file inherit the previous file's structure frames", async () => {
    // Before: useMeganeLocal kept the old frames when the atom count matched,
    // so the new file's loader replayed the old file's trajectory.
    await openVia(path, multiFrameResult(3), "traj.xyz");
    await openVia(path, makeResult({ snapshot: makeSnapshot(3) }), "single.xyz");
    const state = usePipelineStore.getState();
    expect(state.structureFrames).toBeNull();
    expect(state.structureMeta).toBeNull();
    expect(params("loader-1")).toMatchObject({ fileName: "single.xyz", hasTrajectory: false });
  });

  it("keeps a still-fitting file trajectory and its name on a single-frame swap", async () => {
    // Before: useMeganeLocal reset the node to { fileName: "" } while the
    // trajectory kept playing.
    await openVia(path, makeResult({ snapshot: makeSnapshot(3) }), "a.pdb");
    usePipelineStore
      .getState()
      .setFileFrames([makeFrame(0)], { nFrames: 1, timestepPs: 1, nAtoms: 3 });
    setTrajName("run.xtc");
    await openVia(path, makeResult({ snapshot: makeSnapshot(3) }), "b.pdb");
    expect(usePipelineStore.getState().fileFrames).toHaveLength(1);
    expect(params("traj-1")).toMatchObject({ source: "file", fileName: "run.xtc" });
  });

  it("drops a file trajectory whose atom count no longer fits, and clears its name", async () => {
    // Before: openFile's merge path kept a 3-atom trajectory on a 5-atom file.
    await openVia(path, makeResult({ snapshot: makeSnapshot(3) }), "a.pdb");
    usePipelineStore
      .getState()
      .setFileFrames([makeFrame(0)], { nFrames: 1, timestepPs: 1, nAtoms: 3 });
    setTrajName("run.xtc");
    await openVia(path, makeResult({ snapshot: makeSnapshot(5) }), "b.pdb");
    expect(usePipelineStore.getState().fileFrames).toBeNull();
    expect(params("traj-1")).toMatchObject({ source: "file", fileName: "" });
  });

  it("clears a LoadTrajectory name that refers to no loaded trajectory", async () => {
    // Before: openFile left { source: "file" } with the stale name.
    setTrajName("stale.xtc");
    await openVia(path, makeResult(), "a.pdb");
    expect(params("traj-1")).toMatchObject({ source: "file", fileName: "" });
  });

  it("picks the AddBond source from the file format", async () => {
    await openVia(path, makeResult(), "water.gro");
    expect(params("addbond-1").bondSource).toBe("distance");
    await openVia(path, makeResult(), "water.pdb");
    expect(params("addbond-1").bondSource).toBe("structure");
  });
});

describe.each(["openFile", "useMeganeLocal"] as const)("minimal graph install via %s", (path) => {
  it("installs the minimal pipeline and drops the old graph's data", async () => {
    // Before: useMeganeLocal installed nodes/edges but kept the old graph's
    // node snapshots and file trajectory.
    usePipelineStore.setState({ nodes: [], edges: [] });
    usePipelineStore.setState({
      nodeSnapshots: {
        gone: { snapshot: makeSnapshot(2), frames: null, meta: null, labels: null },
      },
      fileFrames: [makeFrame(0, 2)],
      fileMeta: { nFrames: 1, timestepPs: 1, nAtoms: 2 },
    });
    const result = makeResult();
    await openVia(path, result, "a.pdb");
    const state = usePipelineStore.getState();
    expect(state.nodes.some((n) => n.id === "loader-1")).toBe(true);
    expect(Object.keys(state.nodeSnapshots)).toEqual(["loader-1"]);
    expect(state.nodeSnapshots["loader-1"].snapshot).toBe(result.snapshot);
    expect(state.fileFrames).toBeNull();
  });
});

describe("installMinimalGraph", () => {
  it("disposes and drops lazy trajectory providers", () => {
    const meta: TrajectoryMeta = { nFrames: 2, timestepPs: 1, nAtoms: 3 };
    const fileProvider = Object.create(LazyFrameProvider.prototype) as LazyFrameProvider;
    const structureProvider = Object.create(LazyFrameProvider.prototype) as LazyFrameProvider;
    const disposeFile = vi.fn();
    const disposeStructure = vi.fn();
    Object.assign(fileProvider, { dispose: disposeFile, meta });
    Object.assign(structureProvider, { dispose: disposeStructure, meta });
    usePipelineStore.setState({ fileProvider, structureProvider });

    installMinimalGraph(usePipelineStore);

    const state = usePipelineStore.getState();
    expect(disposeFile).toHaveBeenCalledTimes(1);
    expect(disposeStructure).toHaveBeenCalledTimes(1);
    expect(state.fileProvider).toBeNull();
    expect(state.structureProvider).toBeNull();
  });
});

describe("ensureStructureLoader", () => {
  it("keeps the graph in merge mode and reinstalls it in replace mode", () => {
    usePipelineStore.getState().updateNodeParams("loader-1", { fileName: "keep.pdb" });
    expect(ensureStructureLoader(usePipelineStore)).toBe("loader-1");
    expect(params("loader-1").fileName).toBe("keep.pdb");
    expect(ensureStructureLoader(usePipelineStore, { mode: "replace" })).toBe("loader-1");
    expect(params("loader-1").fileName).toBe("");
  });

  it("honours an explicit target node", () => {
    expect(ensureStructureLoader(usePipelineStore, { targetNodeId: "loader-x" })).toBe("loader-x");
  });
});

describe("applyStructureToPipeline — secondary loader", () => {
  function addSecondLoader() {
    const state = usePipelineStore.getState();
    usePipelineStore.setState({
      nodes: [
        ...state.nodes,
        {
          id: "loader-2",
          type: "load_structure",
          position: { x: 0, y: 0 },
          data: {
            params: { type: "load_structure", fileName: "", hasTrajectory: false, hasCell: false },
            enabled: true,
          },
        },
        {
          id: "addbond-2",
          type: "add_bond",
          position: { x: 0, y: 100 },
          data: { params: { type: "add_bond", bondSource: "structure" }, enabled: true },
        },
      ] as never,
      edges: [
        ...state.edges,
        {
          id: "e-l2",
          source: "loader-2",
          target: "addbond-2",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    });
  }

  it("fills the node but leaves the global trajectory state to the primary loader", () => {
    addSecondLoader();
    usePipelineStore
      .getState()
      .setFileFrames([makeFrame(0)], { nFrames: 1, timestepPs: 1, nAtoms: 3 });
    setTrajName("run.xtc");

    applyStructureToPipeline(usePipelineStore, "loader-2", multiFrameResult(), "other.gro");

    const state = usePipelineStore.getState();
    expect(state.nodeSnapshots["loader-2"]?.snapshot.nAtoms).toBe(3);
    expect(params("loader-2")).toMatchObject({ fileName: "other.gro", hasTrajectory: true });
    // The node picker used to skip this for a non-primary loader.
    expect(params("addbond-2").bondSource).toBe("distance");
    expect(params("addbond-1").bondSource).toBe("structure");
    expect(state.structureFrames).toBeNull();
    expect(state.fileFrames).toHaveLength(1);
    expect(params("traj-1")).toMatchObject({ fileName: "run.xtc" });
  });

  it("synthesises the structure meta when a multi-frame parse carries none", () => {
    const result = makeResult({ frames: [makeFrame(1)], meta: null });
    applyStructureToPipeline(usePipelineStore, "loader-1", result, "traj.xyz");
    expect(usePipelineStore.getState().structureMeta).toEqual({
      nFrames: 2,
      timestepPs: 1,
      nAtoms: 3,
    });
  });

  it("treats a parse without vector channels as offering none", () => {
    usePipelineStore.setState({
      embeddedVectorChannels: [{ name: "velocity", frames: [] }],
    });
    const { vectorChannels: _drop, ...bare } = makeResult();
    applyStructureToPipeline(usePipelineStore, "loader-1", bare, "a.pdb");
    expect(usePipelineStore.getState().embeddedVectorChannels).toBeNull();
  });
});
