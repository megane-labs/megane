import { describe, it, expect, beforeEach } from "vitest";
import { usePipelineStore } from "@/pipeline/store";
import type { LoadStructureParams, ParticleData } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function loaderParams(): LoadStructureParams {
  return usePipelineStore.getState().nodes.find((n) => n.id === "loader-1")!.data
    .params as LoadStructureParams;
}

function edits() {
  return loaderParams().edits ?? [];
}

function renderedAtoms(): number {
  return usePipelineStore.getState().viewportState.particles[0]?.source.nAtoms ?? 0;
}

describe("usePipelineStore — edit history on the loader", () => {
  beforeEach(() => {
    usePipelineStore.getState().deserialize({
      version: 3,
      nodes: [
        {
          type: "load_structure",
          id: "loader-1",
          position: { x: 0, y: 0 },
          fileName: "water.xyz",
          hasTrajectory: false,
          hasCell: false,
          enabled: true,
        },
        {
          type: "viewport",
          id: "viewport-1",
          position: { x: 0, y: 200 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [
        {
          source: "loader-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    });
    usePipelineStore.getState().setNodeSnapshot("loader-1", {
      snapshot: water(),
      frames: null,
      meta: null,
      labels: null,
    });
  });

  it("pushEditOp appends to the loader's edits and re-executes the pipeline — no new node", () => {
    expect(renderedAtoms()).toBe(3);
    const id = usePipelineStore
      .getState()
      .pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    expect(id).toBe("loader-1");
    expect(edits()).toHaveLength(1);
    expect(usePipelineStore.getState().nodes.some((n) => n.type === "edit")).toBe(false);
    expect(renderedAtoms()).toBe(4);
    const p = usePipelineStore.getState().viewportState.particles[0] as ParticleData;
    expect(p.source.elements[3]).toBe(7);
    expect(p.sourceNodeId).toBe("loader-1");
  });

  it("appends further ops in order", () => {
    const s = usePipelineStore.getState();
    s.pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    s.pushEditOp({ op: "delete_atoms", atoms: [1] });
    expect(edits().map((e) => e.op)).toEqual(["add_atom", "delete_atoms"]);
    expect(renderedAtoms()).toBe(3);
  });

  it("replaceLastEditOp swaps the most recent op in place", () => {
    const s = usePipelineStore.getState();
    s.pushEditOp({ op: "move_atoms", atoms: [0], delta: [0, 0, 0] });
    s.replaceLastEditOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    expect(edits()).toEqual([{ op: "move_atoms", atoms: [0], delta: [1, 0, 0] }]);
    const p = usePipelineStore.getState().viewportState.particles[0] as ParticleData;
    expect(p.source.positions[0]).toBe(1);
  });

  it("undoEditOp pops and returns the last op; clearEditOps empties the list", () => {
    const s = usePipelineStore.getState();
    expect(s.undoEditOp()).toBeNull();
    s.pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    s.pushEditOp({ op: "add_atom", id: "n2", element: 6, position: [3, 3, 3] });
    const popped = usePipelineStore.getState().undoEditOp();
    expect(popped).toEqual({ op: "add_atom", id: "n2", element: 6, position: [3, 3, 3] });
    expect(edits()).toHaveLength(1);
    expect(renderedAtoms()).toBe(4);
    usePipelineStore.getState().clearEditOps();
    expect(edits()).toHaveLength(0);
    expect(renderedAtoms()).toBe(3);
    expect(usePipelineStore.getState().undoEditOp()).toBeNull();
  });

  it("replaceLastEditOp / clearEditOps are no-ops on an empty history", () => {
    const before = usePipelineStore.getState().editRevision;
    usePipelineStore.getState().replaceLastEditOp({ op: "delete_atoms", atoms: [1] });
    usePipelineStore.getState().clearEditOps();
    expect(edits()).toHaveLength(0);
    expect(usePipelineStore.getState().editRevision).toBe(before);
  });

  it("pushEditOp does nothing without a load_structure node", () => {
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
    });
    const id = usePipelineStore
      .getState()
      .pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    expect(id).toBe("");
    expect(usePipelineStore.getState().nodes.some((n) => n.type === "load_structure")).toBe(false);
  });

  it("bumps editRevision on every change to the edit list and on the preview, on nothing else", () => {
    const s = usePipelineStore.getState();
    const start = s.editRevision;
    s.pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    expect(usePipelineStore.getState().editRevision).toBe(start + 1);
    usePipelineStore.getState().replaceLastEditOp({ op: "delete_atoms", atoms: [0] });
    expect(usePipelineStore.getState().editRevision).toBe(start + 2);
    usePipelineStore.getState().undoEditOp();
    expect(usePipelineStore.getState().editRevision).toBe(start + 3);
    usePipelineStore.getState().pushEditOp({ op: "delete_atoms", atoms: [0] });
    usePipelineStore.getState().clearEditOps();
    expect(usePipelineStore.getState().editRevision).toBe(start + 5);
    // Editing the list directly (Inspector, hand edit) counts too.
    usePipelineStore
      .getState()
      .updateNodeParams("loader-1", { edits: [{ op: "delete_atoms", atoms: [0] }] });
    expect(usePipelineStore.getState().editRevision).toBe(start + 6);
    // Other params and other nodes leave it alone (a wrap toggle keeps the
    // camera through the topology heuristic, a new file must re-fit).
    usePipelineStore.getState().updateNodeParams("viewport-1", { perspective: true });
    usePipelineStore.getState().toggleNode("viewport-1");
    usePipelineStore.getState().updateNodeParams("loader-1", { hasCell: true });
    expect(usePipelineStore.getState().editRevision).toBe(start + 6);
  });

  it("loading a different file into the loader starts the history fresh", () => {
    usePipelineStore.getState().pushEditOp({ op: "delete_atoms", atoms: [0] });
    // Same file name (a reload) keeps the history …
    usePipelineStore.getState().updateNodeParams("loader-1", { fileName: "water.xyz" });
    expect(edits()).toHaveLength(1);
    // … a different one drops it, without counting as an edit (the camera must re-fit).
    const rev = usePipelineStore.getState().editRevision;
    usePipelineStore.getState().updateNodeParams("loader-1", { fileName: "other.pdb" });
    expect(edits()).toEqual([]);
    expect(usePipelineStore.getState().editRevision).toBe(rev);
    expect(renderedAtoms()).toBe(3);
  });

  it("edits survive a serialize → deserialize round trip on the loader", () => {
    const s = usePipelineStore.getState();
    s.pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2], bondTo: 0 });
    const json = usePipelineStore.getState().serialize();
    expect(json.nodes.some((n) => n.type === "edit")).toBe(false);
    const serialized = json.nodes.find(
      (n) => n.id === "loader-1",
    ) as unknown as LoadStructureParams;
    expect(serialized.edits).toHaveLength(1);
    // Opening a pipeline resets the per-node data; load the file again and the
    // history replays on it.
    usePipelineStore.getState().deserialize(json);
    expect(edits()).toHaveLength(1);
    usePipelineStore.getState().setNodeSnapshot("loader-1", {
      snapshot: water(),
      frames: null,
      meta: null,
      labels: null,
    });
    expect(renderedAtoms()).toBe(4);
  });
});
