import { describe, it, expect, beforeEach } from "vitest";
import type { Node } from "@xyflow/react";
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
  usePipelineStore.setState({ nodes, edges: [], layoutPending: false });
}

function byId(id: string): PNode {
  return usePipelineStore.getState().nodes.find((n) => n.id === id)!;
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

describe("pipeline store — selectNode", () => {
  beforeEach(() => {
    seed([node("a", 0, 100), node("b", 200, 100)]);
  });

  it("selects exactly one node and clears the selection with null", () => {
    usePipelineStore.getState().selectNode("a");
    expect(byId("a").selected).toBe(true);
    expect(byId("b").selected).toBeFalsy();
    const untouched = byId("a");
    usePipelineStore.getState().selectNode("b");
    expect(byId("a").selected).toBe(false);
    expect(byId("b").selected).toBe(true);
    expect(untouched).not.toBe(byId("a"));
    usePipelineStore.getState().selectNode(null);
    expect(usePipelineStore.getState().nodes.some((n) => n.selected)).toBe(false);
  });

  it("leaves nodes whose selection does not change untouched", () => {
    usePipelineStore.getState().selectNode("a");
    const b = byId("b");
    usePipelineStore.getState().selectNode("a");
    expect(byId("b")).toBe(b);
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

  it("reset lays the default graph out instead of stacking it at the origin", () => {
    seed([node("a", 0, 100)]);
    usePipelineStore.getState().reset();
    const { nodes, edges } = usePipelineStore.getState();
    expect(nodes.length).toBeGreaterThan(1);
    expect(edges.length).toBeGreaterThan(0);
    expect(byId("viewport-1").position.y).toBeGreaterThan(byId("loader-1").position.y);
    expect(new Set(nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(nodes.length);
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
