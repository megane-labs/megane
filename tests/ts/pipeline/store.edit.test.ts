import { describe, it, expect, beforeEach } from "vitest";
import { usePipelineStore } from "@/pipeline/store";
import { BUILD_EDIT_NODE_ID } from "@/pipeline/editSync";
import type { EditParams, ParticleData } from "@/pipeline/types";
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

function editOps(): EditParams["ops"] {
  const node = usePipelineStore.getState().nodes.find((n) => n.id === BUILD_EDIT_NODE_ID);
  return node ? (node.data.params as EditParams).ops : [];
}

function renderedAtoms(): number {
  return usePipelineStore.getState().viewportState.particles[0]?.source.nAtoms ?? 0;
}

describe("usePipelineStore — edit ops", () => {
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

  it("pushEditOp creates the edit node on first use and re-executes the pipeline", () => {
    expect(renderedAtoms()).toBe(3);
    const id = usePipelineStore
      .getState()
      .pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    expect(id).toBe(BUILD_EDIT_NODE_ID);
    const editNode = usePipelineStore.getState().nodes.find((n) => n.id === id)!;
    expect((editNode.data.params as EditParams).sourceAtomCount).toBe(3);
    expect(editOps()).toHaveLength(1);
    expect(renderedAtoms()).toBe(4);
    // The rendered stream now comes through the edit node.
    const p = usePipelineStore.getState().viewportState.particles[0] as ParticleData;
    expect(p.source.elements[3]).toBe(7);
  });

  it("appends further ops to the same node", () => {
    const s = usePipelineStore.getState();
    s.pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2] });
    s.pushEditOp({ op: "delete_atoms", atoms: [1] });
    expect(editOps()).toHaveLength(2);
    expect(usePipelineStore.getState().nodes.filter((n) => n.type === "edit")).toHaveLength(1);
    expect(renderedAtoms()).toBe(3);
  });

  it("replaceLastEditOp swaps the most recent op in place", () => {
    const s = usePipelineStore.getState();
    s.pushEditOp({ op: "move_atoms", atoms: [0], delta: [0, 0, 0] });
    s.replaceLastEditOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    expect(editOps()).toHaveLength(1);
    expect(editOps()[0]).toEqual({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
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
    expect(editOps()).toHaveLength(1);
    expect(renderedAtoms()).toBe(4);
    usePipelineStore.getState().clearEditOps();
    expect(editOps()).toHaveLength(0);
    expect(renderedAtoms()).toBe(3);
    expect(usePipelineStore.getState().undoEditOp()).toBeNull();
  });

  it("replaceLastEditOp / clearEditOps are no-ops without an edit node", () => {
    const s = usePipelineStore.getState();
    s.replaceLastEditOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    s.clearEditOps();
    expect(usePipelineStore.getState().nodes.some((n) => n.type === "edit")).toBe(false);
    // …and replaceLastEditOp with an empty op list leaves it empty.
    s.pushEditOp({ op: "delete_atoms", atoms: [0] });
    usePipelineStore.getState().clearEditOps();
    usePipelineStore.getState().replaceLastEditOp({ op: "delete_atoms", atoms: [1] });
    expect(editOps()).toHaveLength(0);
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
    expect(usePipelineStore.getState().nodes.some((n) => n.type === "edit")).toBe(false);
  });

  it("edits survive a serialize → deserialize round trip", () => {
    const s = usePipelineStore.getState();
    s.pushEditOp({ op: "add_atom", id: "n1", element: 7, position: [2, 2, 2], bondTo: 0 });
    const json = usePipelineStore.getState().serialize();
    const serialized = json.nodes.find((n) => n.id === BUILD_EDIT_NODE_ID) as unknown as EditParams;
    expect(serialized.type).toBe("edit");
    expect(serialized.ops).toHaveLength(1);
    expect(serialized.sourceAtomCount).toBe(3);
    usePipelineStore.getState().deserialize(json);
    expect(editOps()).toHaveLength(1);
  });
});
