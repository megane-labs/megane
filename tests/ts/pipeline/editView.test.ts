import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import { buildEditViewportState, emptyCellSnapshot } from "@/pipeline/editView";
import { executePipeline, type PipelineNodeData } from "@/pipeline/execute";
import type { EditOp } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(box: Float32Array | null = null, nFileBonds = 2): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds,
    positions: new Float32Array([1, 1, 1, 1.757, 1.586, 1, 0.243, 1.586, 1]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function node(id: string, type: string, params: Record<string, unknown>): Node<PipelineNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { params: { type, ...params } as PipelineNodeData["params"], enabled: true },
  };
}

function edge(source: string, sh: string, target: string, th: string): Edge {
  return {
    id: `${source}.${sh}-${target}.${th}`,
    source,
    target,
    sourceHandle: sh,
    targetHandle: th,
  };
}

/** loader → replicate(2×1×1) → filter(O only) → viewport, the kind of graph editing must ignore. */
function replicatedGraph(edits: EditOp[] = []) {
  const nodes = [
    node("loader-1", "load_structure", {
      fileName: "w.pdb",
      hasTrajectory: false,
      hasCell: true,
      edits,
    }),
    node("rep-1", "replicate", { nx: 2, ny: 1, nz: 1 }),
    node("filter-1", "filter", { query: "element == O" }),
    node("viewport-1", "viewport", { perspective: true, cellAxesVisible: false }),
  ];
  const edges = [
    edge("loader-1", "particle", "rep-1", "particle"),
    edge("loader-1", "cell", "rep-1", "cell"),
    edge("rep-1", "particle", "filter-1", "in"),
    edge("filter-1", "out", "viewport-1", "particle"),
    edge("rep-1", "cell", "viewport-1", "cell"),
  ];
  return { nodes, edges };
}

describe("buildEditViewportState", () => {
  const box = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

  it("shows the loader's output, not the graph's, with every atom and its cell", () => {
    const { nodes, edges } = replicatedGraph();
    const ctx = {
      snapshot: null,
      nodeSnapshots: {
        "loader-1": { snapshot: water(box), frames: null, meta: null, labels: null },
      },
    };
    // The graph itself doubles the atoms and then hides the hydrogens…
    const graphView = executePipeline(nodes, edges, ctx).viewportState;
    expect(graphView.particles[0].source.nAtoms).toBe(6);
    // …while the edit view is the three loaded atoms, unfiltered, with the cell.
    const view = buildEditViewportState(nodes, ctx);
    expect(view.particles).toHaveLength(1);
    expect(view.particles[0].source.nAtoms).toBe(3);
    expect(view.particles[0].indices).toBeNull();
    expect(view.particles[0].sourceNodeId).toBe("loader-1");
    expect(view.cells).toHaveLength(1);
    expect(view.cells[0].box).toBe(box);
    expect(view.trajectories).toEqual([]);
    expect(view.meshes).toEqual([]);
    expect(view.labels).toEqual([]);
    expect(view.representationMode).toBe("atoms");
    expect(view.representationByAtom).toBeNull();
    expect(view.cellAxesVisible).toBe(true);
    expect(view.pivotMarkerVisible).toBe(true);
  });

  it("keeps the viewport node's projection", () => {
    const { nodes } = replicatedGraph();
    const ctx = { snapshot: water(), nodeSnapshots: {} };
    expect(buildEditViewportState(nodes, ctx).perspective).toBe(true);
    const ortho = nodes.map((n) =>
      n.id === "viewport-1"
        ? node("viewport-1", "viewport", { perspective: false, cellAxesVisible: true })
        : n,
    );
    expect(buildEditViewportState(ortho, ctx).perspective).toBe(false);
    const noViewport = nodes.filter((n) => n.type !== "viewport");
    expect(buildEditViewportState(noViewport, ctx).perspective).toBe(false);
  });

  it("replays the edit list and draws the bonds the edits assert", () => {
    const { nodes } = replicatedGraph([
      { op: "add_atom", id: "c1", element: 6, position: [5, 5, 5], bondTo: 0, order: 1 },
    ]);
    const view = buildEditViewportState(nodes, { snapshot: water(box), nodeSnapshots: {} });
    expect(view.particles[0].source.nAtoms).toBe(4);
    expect(view.bonds).toHaveLength(1);
    // Two water bonds plus the new one; the box is 10 Å so none crosses it.
    expect(view.bonds[0].nBonds).toBe(3);
    expect(view.bonds[0].sourceNodeId).toBe("loader-1");
    expect(view.bonds[0].positions).toBeNull();
  });

  it("shows the file as loaded while the original preview is on", () => {
    const { nodes } = replicatedGraph([{ op: "delete_atoms", atoms: [1, 2] }]);
    const edited = buildEditViewportState(nodes, { snapshot: water(), nodeSnapshots: {} });
    expect(edited.particles[0].source.nAtoms).toBe(1);
    const original = buildEditViewportState(nodes, {
      snapshot: water(),
      nodeSnapshots: {},
      editsBypassed: true,
    });
    expect(original.particles[0].source.nAtoms).toBe(3);
  });

  it("draws parser-inferred bonds too (nFileBonds 0), so an XYZ shows its bonds while editing", () => {
    const { nodes } = replicatedGraph();
    const view = buildEditViewportState(nodes, { snapshot: water(null, 0), nodeSnapshots: {} });
    expect(view.bonds).toHaveLength(1);
    expect(view.bonds[0].nBonds).toBe(2);
    expect(view.cells).toEqual([]);
  });

  it("completes a bond across the cell boundary with a ghost atom", () => {
    // H at 9.9 and O at 0.1 in a 10 Å cell: bonded through the boundary.
    const wrapped: Snapshot = {
      ...water(box),
      positions: new Float32Array([0.1, 1, 1, 9.9, 1, 1, 0.243, 1.586, 1]),
    };
    const { nodes } = replicatedGraph();
    const view = buildEditViewportState(nodes, { snapshot: wrapped, nodeSnapshots: {} });
    expect(view.bonds[0].positions).not.toBeNull();
    expect(view.bonds[0].nAtoms).toBeGreaterThan(3);
  });

  it("has no bond stream for a structure without bonds", () => {
    const { nodes } = replicatedGraph();
    const lonely: Snapshot = { ...water(), nBonds: 0, nFileBonds: 0, bonds: new Uint32Array(0) };
    expect(buildEditViewportState(nodes, { snapshot: lonely, nodeSnapshots: {} }).bonds).toEqual(
      [],
    );
  });

  it("is the empty default without a loader or without a structure", () => {
    const { nodes } = replicatedGraph();
    expect(buildEditViewportState(nodes, { snapshot: null, nodeSnapshots: {} }).particles).toEqual(
      [],
    );
    const noLoader = nodes.filter((n) => n.type !== "load_structure");
    expect(
      buildEditViewportState(noLoader, { snapshot: water(), nodeSnapshots: {} }).particles,
    ).toEqual([]);
  });
});

describe("emptyCellSnapshot", () => {
  it("is an atom-less structure with a cubic cell", () => {
    const s = emptyCellSnapshot(12);
    expect(s.nAtoms).toBe(0);
    expect(s.nBonds).toBe(0);
    expect(s.positions).toHaveLength(0);
    expect(Array.from(s.box!)).toEqual([12, 0, 0, 0, 12, 0, 0, 0, 12]);
  });

  it("never produces a degenerate cell", () => {
    expect(emptyCellSnapshot(0).box![0]).toBeGreaterThan(0);
    expect(emptyCellSnapshot(-5).box![4]).toBeGreaterThan(0);
  });
});
