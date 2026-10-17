import { describe, it, expect, beforeEach } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import { usePipelineStore } from "@/pipeline/store";
import type { PipelineNodeData } from "@/pipeline/execute";
import type { SerializedPipeline } from "@/pipeline/types";
import { defaultParams } from "@/pipeline/types";

type PNode = Node<PipelineNodeData>;

function node(id: string, y: number, height: number, x = 0): PNode {
  return {
    id,
    type: "filter",
    position: { x, y },
    measured: { width: 340, height },
    data: { params: defaultParams("filter"), enabled: true },
  };
}

function seed(nodes: PNode[]): void {
  usePipelineStore.setState({ nodes, edges: [], pendingReflow: {}, layoutPending: false });
}

function byId(id: string): PNode {
  return usePipelineStore.getState().nodes.find((n) => n.id === id)!;
}

function resize(id: string, height: number): void {
  const change: NodeChange<PNode> = {
    type: "dimensions",
    id,
    dimensions: { width: 340, height },
  };
  usePipelineStore.getState().onNodesChange([change]);
}

const STACKED: SerializedPipeline = {
  version: 3,
  nodes: [
    {
      type: "load_structure",
      id: "loader-1",
      position: { x: 0, y: 0 },
      fileName: null,
      hasTrajectory: false,
      hasCell: false,
      enabled: true,
    },
    {
      type: "viewport",
      id: "viewport-1",
      position: { x: 0, y: 0 },
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
} as unknown as SerializedPipeline;

describe("pipeline store — collapsing nodes", () => {
  beforeEach(() => {
    seed([node("a", 0, 200), node("b", 300, 100), node("side", 0, 150, 400)]);
  });

  it("toggleNodeCollapsed flips the flag and queues a reflow", () => {
    usePipelineStore.getState().toggleNodeCollapsed("a");
    expect(byId("a").data.collapsed).toBe(true);
    expect(usePipelineStore.getState().pendingReflow).toEqual({ a: true });
    usePipelineStore.getState().toggleNodeCollapsed("a");
    expect(byId("a").data.collapsed).toBe(false);
  });

  it("pulls the nodes below up when a collapsed node shrinks", () => {
    usePipelineStore.getState().toggleNodeCollapsed("a");
    resize("a", 80);
    expect(byId("a").measured?.height).toBe(80);
    // b started below a's old bottom (200): moves up by 120.
    expect(byId("b").position.y).toBe(180);
    // side shares a's rank (same top): stays put.
    expect(byId("side").position.y).toBe(0);
    expect(usePipelineStore.getState().pendingReflow).toEqual({});
  });

  it("pushes the nodes below down when a node expands", () => {
    usePipelineStore.getState().toggleNodeCollapsed("a");
    resize("a", 350);
    expect(byId("b").position.y).toBe(450);
  });

  it("does not reflow on resizes it did not ask for", () => {
    resize("a", 80);
    expect(byId("b").position.y).toBe(300);
  });

  it("ignores a pending reflow without a previous measurement or a size change", () => {
    seed([{ ...node("a", 0, 200), measured: undefined }, node("b", 300, 100)]);
    usePipelineStore.getState().toggleNodeCollapsed("a");
    resize("a", 80);
    expect(byId("b").position.y).toBe(300);

    seed([node("a", 0, 200), node("b", 300, 100)]);
    usePipelineStore.getState().toggleNodeCollapsed("a");
    resize("a", 200);
    expect(byId("b").position.y).toBe(300);
    expect(usePipelineStore.getState().pendingReflow).toEqual({});
  });

  it("setAllNodesCollapsed collapses and expands every node", () => {
    usePipelineStore.getState().toggleNodeCollapsed("a");
    usePipelineStore.getState().setAllNodesCollapsed(true);
    expect(usePipelineStore.getState().nodes.every((n) => n.data.collapsed === true)).toBe(true);
    expect(usePipelineStore.getState().pendingReflow).toEqual({});
    const unchanged = byId("a");
    usePipelineStore.getState().setAllNodesCollapsed(true);
    expect(byId("a")).toBe(unchanged);
    usePipelineStore.getState().setAllNodesCollapsed(false);
    expect(usePipelineStore.getState().nodes.every((n) => n.data.collapsed === false)).toBe(true);
  });

  it("does not serialize the collapsed flag", () => {
    usePipelineStore.getState().setAllNodesCollapsed(true);
    const json = JSON.stringify(usePipelineStore.getState().serialize());
    expect(json).not.toContain("collapsed");
  });
});

describe("pipeline store — layoutPending", () => {
  it("autoLayout clears it only once every node is measured", () => {
    seed([node("a", 0, 100), { ...node("b", 0, 100), measured: undefined }]);
    usePipelineStore.setState({ layoutPending: true });
    usePipelineStore.getState().autoLayout();
    expect(usePipelineStore.getState().layoutPending).toBe(true);

    seed([node("a", 0, 100), node("b", 0, 100)]);
    usePipelineStore.setState({ layoutPending: true });
    usePipelineStore.getState().autoLayout();
    expect(usePipelineStore.getState().layoutPending).toBe(false);
  });

  it("applyTemplate and reset ask for a measured re-layout", () => {
    usePipelineStore.setState({ layoutPending: false });
    usePipelineStore.getState().applyTemplate("molecule");
    expect(usePipelineStore.getState().layoutPending).toBe(true);
    usePipelineStore.setState({ layoutPending: false });
    usePipelineStore.getState().reset();
    expect(usePipelineStore.getState().layoutPending).toBe(true);
  });

  it("deserialize keeps saved positions", () => {
    const saved = {
      ...STACKED,
      nodes: STACKED.nodes.map((n, i) => ({ ...n, position: { x: 17, y: i * 333 } })),
    } as SerializedPipeline;
    usePipelineStore.getState().deserialize(saved);
    expect(byId("viewport-1").position).toEqual({ x: 17, y: 333 });
    expect(usePipelineStore.getState().layoutPending).toBe(false);
  });

  it("deserialize lays out a graph whose nodes are all stacked on one spot", () => {
    usePipelineStore.getState().deserialize(STACKED);
    expect(byId("viewport-1").position.y).toBeGreaterThan(byId("loader-1").position.y);
    expect(usePipelineStore.getState().layoutPending).toBe(true);
  });

  it("loadPipeline lays out a stacked graph too", () => {
    usePipelineStore.getState().loadPipeline(STACKED, {});
    expect(byId("viewport-1").position.y).toBeGreaterThan(byId("loader-1").position.y);
    expect(usePipelineStore.getState().layoutPending).toBe(true);
  });

  it("a single node is not considered stacked", () => {
    usePipelineStore.getState().deserialize({ ...STACKED, nodes: [STACKED.nodes[1]], edges: [] });
    expect(byId("viewport-1").position).toEqual({ x: 0, y: 0 });
    expect(usePipelineStore.getState().layoutPending).toBe(false);
  });
});
