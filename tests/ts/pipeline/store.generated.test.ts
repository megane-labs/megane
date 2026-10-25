import { describe, it, expect, beforeEach } from "vitest";
import { createPipelineStore } from "@/pipeline/store";
import type { LoadStructureParams, SerializedPipeline } from "@/pipeline/types";
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

const base: SerializedPipeline = {
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
} as SerializedPipeline;

/** What the model sends back: the same graph plus a filter, file name lost. */
function generated(): SerializedPipeline {
  return {
    version: 3,
    nodes: [
      { ...base.nodes[0], fileName: null } as SerializedPipeline["nodes"][number],
      base.nodes[1],
      {
        type: "filter",
        id: "filter-1",
        position: { x: 0, y: 0 },
        query: 'element == "O"',
        bond_query: "",
      } as unknown as SerializedPipeline["nodes"][number],
    ],
    edges: [
      {
        source: "loader-1",
        target: "filter-1",
        sourceHandle: "particle",
        targetHandle: "in",
      },
      {
        source: "filter-1",
        target: "viewport-1",
        sourceHandle: "out",
        targetHandle: "particle",
      },
    ],
  };
}

describe("pipeline store — generated pipelines", () => {
  let store: ReturnType<typeof createPipelineStore>;

  beforeEach(() => {
    store = createPipelineStore();
    store.getState().deserialize(base);
    store.getState().setNodeSnapshot("loader-1", {
      snapshot: water(),
      frames: null,
      meta: null,
      labels: null,
    });
  });

  it("replaces the graph but keeps the loaded structure and its file", () => {
    const id = store.getState().applyGeneratedPipeline(generated(), { checkpoint: true });

    const state = store.getState();
    expect(id).toEqual(expect.any(Number));
    expect(state.nodes.map((n) => n.id)).toContain("filter-1");
    const loader = state.nodes.find((n) => n.id === "loader-1")!;
    expect((loader.data.params as LoadStructureParams).fileName).toBe("water.xyz");
    expect(state.nodeSnapshots["loader-1"]?.snapshot.nAtoms).toBe(3);
    expect(state.layoutPending).toBe(true);
    // The new graph runs against the structure that stayed loaded.
    expect(state.viewportState.particles[0]?.source.nAtoms).toBe(3);
    expect(state.generatedUndoStack.map((c) => c.id)).toEqual([id]);
  });

  it("does not stack a checkpoint when re-applying within the same request", () => {
    store.getState().applyGeneratedPipeline(generated(), { checkpoint: true });
    expect(store.getState().applyGeneratedPipeline(generated())).toBeNull();
    expect(store.getState().generatedUndoStack).toHaveLength(1);
  });

  it("undo restores the graph and data from before the request", () => {
    const before = store.getState().nodes;
    store.getState().applyGeneratedPipeline(generated(), { checkpoint: true });

    expect(store.getState().undoGeneratedPipeline()).toBe(true);
    const state = store.getState();
    expect(state.nodes).toBe(before);
    expect(state.nodes.map((n) => n.id)).not.toContain("filter-1");
    expect(state.nodeSnapshots["loader-1"]?.snapshot.nAtoms).toBe(3);
    expect(state.generatedUndoStack).toHaveLength(0);
    expect(store.getState().undoGeneratedPipeline()).toBe(false);
  });

  it("forgets the checkpoints once new data is loaded or the pipeline replaced", () => {
    const clearers: Array<() => void> = [
      () => store.getState().setSnapshot(water()),
      () => store.getState().setStructureFrames(null, null),
      () => store.getState().setStructureProvider(null),
      () => store.getState().setFileFrames(null, null),
      () => store.getState().setFileProvider(null),
      () =>
        store.getState().setNodeSnapshot("loader-1", {
          snapshot: water(),
          frames: null,
          meta: null,
          labels: null,
        }),
      () => store.getState().removeNodeSnapshot("loader-1"),
      () => store.getState().deserialize(base),
      () => store.getState().loadPipeline(base, {}),
      () => store.getState().applyTemplate("molecule"),
      () => store.getState().reset(),
    ];
    for (const clear of clearers) {
      store.getState().applyGeneratedPipeline(generated(), { checkpoint: true });
      expect(store.getState().generatedUndoStack.length).toBeGreaterThan(0);
      clear();
      expect(store.getState().generatedUndoStack).toEqual([]);
    }
  });

  it("caps the undo history", () => {
    for (let i = 0; i < 25; i++) {
      store.getState().applyGeneratedPipeline(generated(), { checkpoint: true });
    }
    expect(store.getState().generatedUndoStack).toHaveLength(20);
  });
});

describe("pipeline store — generated pipelines on a loaded trajectory", () => {
  const frames = [0, 1, 2].map((i) => ({
    frameId: i,
    nAtoms: 3,
    positions: new Float32Array([0, 0, i, 0.757, 0.586, i, -0.757, 0.586, i]),
  }));
  const loaded = {
    version: 3,
    nodes: [
      {
        type: "load_structure",
        id: "loader-1",
        position: { x: 0, y: 0 },
        fileName: "md.xyz",
        hasTrajectory: true,
        hasCell: false,
        enabled: true,
      },
      { type: "viewport", id: "viewport-1", position: { x: 0, y: 200 }, enabled: true },
    ],
    edges: [
      {
        source: "loader-1",
        target: "viewport-1",
        sourceHandle: "particle",
        targetHandle: "particle",
      },
    ],
  } as SerializedPipeline;

  /** The model's edit, shaped like the prompt's examples: its loader holds no trajectory. */
  function restyled(loaderId: string): SerializedPipeline {
    return {
      version: 3,
      nodes: [
        {
          type: "load_structure",
          id: loaderId,
          position: { x: 0, y: 0 },
          fileName: null,
          hasTrajectory: false,
          hasCell: false,
        },
        { type: "representation", id: "rep-1", position: { x: 0, y: 100 }, mode: "licorice" },
        { type: "viewport", id: "viewport-1", position: { x: 0, y: 200 } },
      ],
      edges: [
        { source: loaderId, target: "rep-1", sourceHandle: "particle", targetHandle: "particle" },
        { source: "rep-1", target: "viewport-1", sourceHandle: "out", targetHandle: "particle" },
      ],
    } as SerializedPipeline;
  }

  let store: ReturnType<typeof createPipelineStore>;
  const trajectoryEdges = () =>
    store
      .getState()
      .edges.filter((e) => e.targetHandle === "trajectory")
      .map((e) => `${e.source}.${e.sourceHandle}->${e.target}`);

  beforeEach(() => {
    store = createPipelineStore();
    store.getState().loadPipeline(loaded, {
      "loader-1": {
        snapshot: water(),
        frames,
        meta: { nFrames: 3, timestepPs: 1, nAtoms: 3 } as never,
        labels: null,
      },
    });
  });

  it.each([
    ["keeps the loader", "loader-1"],
    ["rebuilds the loader", "loader-new"],
  ])("keeps the trajectory playing when the model %s", (_label, loaderId) => {
    expect(trajectoryEdges()).toEqual(["loader-1.trajectory->viewport-1"]);
    expect(store.getState().viewportState.trajectories).toHaveLength(1);

    store.getState().applyGeneratedPipeline(restyled(loaderId), { checkpoint: true });

    const loader = store.getState().nodes.find((n) => n.id === loaderId)!;
    expect((loader.data.params as LoadStructureParams).hasTrajectory).toBe(true);
    expect(trajectoryEdges()).toEqual([`${loaderId}.trajectory->viewport-1`]);
    expect(store.getState().viewportState.trajectories).toHaveLength(1);
  });
});
