/**
 * Node ids the editor hands out must not collide with the ids of a graph
 * installed from elsewhere — a saved `.megane.json`, a share link, the AI
 * assistant — which this session's id counter never issued.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SerializedPipeline } from "@/pipeline/types";
import type { Snapshot } from "@/types";

type StoreModule = typeof import("@/pipeline/store");

let createPipelineStore: StoreModule["createPipelineStore"];

beforeEach(async () => {
  // A fresh module: the counter starts at node-1, as in a new browser session.
  vi.resetModules();
  ({ createPipelineStore } = await import("@/pipeline/store"));
});

/** What the editor saves: its own `node-N` ids. */
function savedPipeline(ids: string[]): SerializedPipeline {
  return {
    version: 3,
    nodes: [
      ...ids.map((id, i) => ({
        type: "filter" as const,
        id,
        position: { x: 0, y: i * 100 },
        query: "all",
        enabled: true,
      })),
      {
        type: "viewport",
        id: "viewport-1",
        position: { x: 0, y: 500 },
        perspective: false,
        cellAxesVisible: true,
        enabled: true,
      },
    ],
    edges: [],
  } as SerializedPipeline;
}

const snapshot: Snapshot = {
  nAtoms: 1,
  nBonds: 0,
  nFileBonds: 0,
  positions: new Float32Array(3),
  elements: new Uint8Array([6]),
  bonds: new Uint32Array(0),
  bondOrders: null,
  box: null,
  boxOrigin: null,
  atomChainIds: null,
  atomBFactors: null,
};

function expectUniqueIds(ids: string[]): void {
  expect(new Set(ids).size).toBe(ids.length);
}

describe("addNode ids", () => {
  it("does not reuse an id of an opened pipeline", () => {
    const store = createPipelineStore();
    store.getState().deserialize(savedPipeline(["node-1", "node-2"]));

    const added = store.getState().addNode("modify");
    expect(["node-1", "node-2"]).not.toContain(added);
    expectUniqueIds(store.getState().nodes.map((n) => n.id));
  });

  it("does not reuse an id of a pipeline loaded with its snapshots", () => {
    const store = createPipelineStore();
    store.getState().loadPipeline(savedPipeline(["node-1"]), {
      "node-1": { snapshot, frames: null, meta: null, labels: null },
    });

    const first = store.getState().addNode("modify");
    const second = store.getState().addNode("color");
    expect(first).not.toBe("node-1");
    expect(second).not.toBe("node-1");
    expectUniqueIds(store.getState().nodes.map((n) => n.id));
  });

  it("does not reuse an id of a graph the assistant generated", () => {
    const store = createPipelineStore();
    store.getState().applyGeneratedPipeline(savedPipeline(["node-1", "node-3"]));

    const ids = [store.getState().addNode("modify"), store.getState().addNode("color")];
    expect(ids).not.toContain("node-1");
    expect(ids).not.toContain("node-3");
    expectUniqueIds(store.getState().nodes.map((n) => n.id));
  });

  it("does not hand out an id that per-node data is still keyed by", () => {
    const store = createPipelineStore();
    store.getState().deserialize(savedPipeline([]));
    store
      .getState()
      .setNodeSnapshot("node-1", { snapshot, frames: null, meta: null, labels: null });

    const added = store.getState().addNode("load_structure");
    expect(added).not.toBe("node-1");
    expect(store.getState().nodeSnapshots[added]).toBeUndefined();
  });

  it("still counts up from node-1 in an empty graph", () => {
    const store = createPipelineStore();
    store.getState().deserialize(savedPipeline([]));
    expect(store.getState().addNode("modify")).toBe("node-1");
    expect(store.getState().addNode("modify")).toBe("node-2");
  });
});
