import { describe, it, expect, beforeEach } from "vitest";
import { usePipelineStore } from "@/pipeline/store";
import type { AddBondParams, LoadStructureParams, LoadTrajectoryParams } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([1, 1, 1, 1.757, 1.586, 1, 0.243, 1.586, 1]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** loader → replicate(2×2×2) → viewport, plus a trajectory node and an add_bond on "distance". */
function loadReplicatedPipeline() {
  usePipelineStore.getState().deserialize({
    version: 3,
    nodes: [
      {
        type: "load_structure",
        id: "loader-1",
        position: { x: 0, y: 0 },
        fileName: "w.xyz",
        hasTrajectory: false,
        hasCell: true,
        enabled: true,
      },
      {
        type: "load_trajectory",
        id: "traj-1",
        position: { x: 300, y: 0 },
        fileName: "w.xtc",
        enabled: true,
      },
      {
        type: "replicate",
        id: "rep-1",
        position: { x: 0, y: 200 },
        nx: 2,
        ny: 2,
        nz: 2,
        enabled: true,
      },
      {
        type: "add_bond",
        id: "ab-1",
        position: { x: 300, y: 200 },
        bondSource: "distance",
        enabled: true,
      },
      {
        type: "viewport",
        id: "viewport-1",
        position: { x: 0, y: 400 },
        perspective: false,
        cellAxesVisible: true,
        enabled: true,
      },
    ],
    edges: [
      { source: "loader-1", target: "rep-1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "loader-1", target: "rep-1", sourceHandle: "cell", targetHandle: "cell" },
      { source: "rep-1", target: "viewport-1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "rep-1", target: "ab-1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "ab-1", target: "viewport-1", sourceHandle: "bond", targetHandle: "bond" },
      {
        source: "traj-1",
        target: "viewport-1",
        sourceHandle: "trajectory",
        targetHandle: "trajectory",
      },
    ],
  } as never);
  usePipelineStore.getState().setNodeSnapshot("loader-1", {
    snapshot: water(),
    frames: null,
    meta: null,
    labels: ["HOH", "HOH", "HOH"],
  });
}

function rendered(): number {
  return usePipelineStore.getState().viewportState.particles[0]?.source.nAtoms ?? -1;
}

function params<T>(id: string): T {
  return usePipelineStore.getState().nodes.find((n) => n.id === id)!.data.params as T;
}

describe("usePipelineStore — edit mode", () => {
  beforeEach(() => {
    usePipelineStore.setState({ editMode: false, editsBypassed: false });
    loadReplicatedPipeline();
  });

  it("shows the loader's output while on and the graph's output while off", () => {
    expect(rendered()).toBe(24);
    const before = usePipelineStore.getState().editRevision;
    usePipelineStore.getState().setEditMode(true);
    expect(usePipelineStore.getState().editMode).toBe(true);
    expect(rendered()).toBe(3);
    // The cell is the loader's, the bonds are the structure's own.
    expect(usePipelineStore.getState().viewportState.cells).toHaveLength(1);
    expect(usePipelineStore.getState().viewportState.bonds[0].nBonds).toBe(2);
    // Switching modes keeps the camera (it bumps the edit revision).
    expect(usePipelineStore.getState().editRevision).toBe(before + 1);
    usePipelineStore.getState().setEditMode(false);
    expect(rendered()).toBe(24);
    expect(usePipelineStore.getState().editRevision).toBe(before + 2);
  });

  it("is idempotent", () => {
    const before = usePipelineStore.getState().editRevision;
    usePipelineStore.getState().setEditMode(false);
    expect(usePipelineStore.getState().editRevision).toBe(before);
  });

  it("re-executes edits in edit mode against the loader, not the replicated view", () => {
    usePipelineStore.getState().setEditMode(true);
    usePipelineStore.getState().pushEditOp({ op: "delete_atoms", atoms: [0] });
    expect(rendered()).toBe(2);
    usePipelineStore.getState().setEditMode(false);
    // The graph sees the edited structure: 2 atoms × 8 images.
    expect(rendered()).toBe(16);
  });

  it("still reports node errors from the graph while on", () => {
    usePipelineStore.getState().setEditMode(true);
    usePipelineStore.getState().pushEditOp({ op: "delete_atoms", atoms: [99] });
    expect(usePipelineStore.getState().nodeErrors["loader-1"]?.[0].message).toContain(
      "unknown atom 99",
    );
  });
});

describe("usePipelineStore — newEmptyCell", () => {
  beforeEach(() => {
    usePipelineStore.setState({ editMode: false, editsBypassed: false });
    loadReplicatedPipeline();
  });

  it("replaces the loader's structure with an empty cell and keeps the graph", () => {
    usePipelineStore.getState().pushEditOp({ op: "delete_atoms", atoms: [0] });
    usePipelineStore.setState({
      fileFrames: [{ frameId: 0, nAtoms: 3, positions: new Float32Array(9) }],
      fileMeta: { nFrames: 1, timestepPs: 1, nAtoms: 3 },
    });
    const nodeIds = usePipelineStore.getState().nodes.map((n) => n.id);

    const revision = usePipelineStore.getState().editRevision;
    expect(usePipelineStore.getState().newEmptyCell(12)).toBe("loader-1");

    const state = usePipelineStore.getState();
    // A new cell is a new structure: the view re-fits (no camera-preserve bump).
    expect(state.editRevision).toBe(revision);
    expect(state.nodes.map((n) => n.id)).toEqual(nodeIds);
    const snap = state.nodeSnapshots["loader-1"].snapshot;
    expect(snap.nAtoms).toBe(0);
    expect(Array.from(snap.box!)).toEqual([12, 0, 0, 0, 12, 0, 0, 0, 12]);
    const loader = params<LoadStructureParams>("loader-1");
    expect(loader.fileName).toBe("untitled");
    expect(loader.hasCell).toBe(true);
    expect(loader.hasTrajectory).toBe(false);
    expect(loader.edits ?? []).toEqual([]);
    // Trajectories of the old structure are gone.
    expect(state.fileFrames).toBeNull();
    expect(state.fileMeta).toBeNull();
    expect(state.structureFrames).toBeNull();
    expect(state.atomLabels).toBeNull();
    expect(params<LoadTrajectoryParams>("traj-1").fileName).toBe("");
    // Bonds the user draws must be the bonds shown.
    expect(params<AddBondParams>("ab-1").bondSource).toBe("structure");
    // The graph renders the empty cell (replicated 2×2×2: still no atoms).
    expect(rendered()).toBe(0);
    expect(state.viewportState.cells.length).toBeGreaterThan(0);
  });

  it("clears the edit history even when the loader already held an untitled cell", () => {
    usePipelineStore.getState().newEmptyCell(10);
    usePipelineStore
      .getState()
      .pushEditOp({ op: "add_atom", id: "a", element: 6, position: [5, 5, 5] });
    expect(params<LoadStructureParams>("loader-1").edits).toHaveLength(1);
    usePipelineStore.getState().newEmptyCell(10);
    expect(params<LoadStructureParams>("loader-1").edits ?? []).toEqual([]);
    expect(rendered()).toBe(0);
  });

  it("installs a minimal loader → viewport graph when there is no loader", () => {
    usePipelineStore.getState().deserialize({
      version: 3,
      nodes: [
        {
          type: "viewport",
          id: "viewport-1",
          position: { x: 0, y: 0 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [],
    } as never);
    const id = usePipelineStore.getState().newEmptyCell(8);
    expect(id).not.toBe("");
    const state = usePipelineStore.getState();
    expect(state.nodes.some((n) => n.type === "load_structure")).toBe(true);
    expect(state.nodeSnapshots[id].snapshot.nAtoms).toBe(0);
    expect(state.viewportState.cells).toHaveLength(1);
  });

  it("is what edit mode shows too", () => {
    usePipelineStore.getState().setEditMode(true);
    usePipelineStore.getState().newEmptyCell(10);
    expect(rendered()).toBe(0);
    usePipelineStore
      .getState()
      .pushEditOp({ op: "add_atom", id: "a", element: 6, position: [5, 5, 5] });
    expect(rendered()).toBe(1);
  });
});
