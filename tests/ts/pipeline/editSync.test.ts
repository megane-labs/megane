import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import {
  BUILD_EDIT_NODE_ID,
  ensureBuildEditNode,
  findBuildEditNode,
  findPrimaryLoader,
} from "@/pipeline/editSync";
import type { PipelineNodeData } from "@/pipeline/execute";
import { defaultParams } from "@/pipeline/types";
import type { PipelineNodeType, EditParams } from "@/pipeline/types";

function node(id: string, type: PipelineNodeType, x = 0, y = 0): Node<PipelineNodeData> {
  return { id, type, position: { x, y }, data: { params: defaultParams(type), enabled: true } };
}

function edge(source: string, sh: string, target: string, th: string): Edge {
  return {
    id: `e-${source}-${sh}-${target}-${th}`,
    source,
    target,
    sourceHandle: sh,
    targetHandle: th,
  };
}

/** loader → symmetry → viewport, loader.cell → replicate, loader → load_trajectory. */
function graph() {
  const nodes = [
    node("loader-1", "load_structure", 100, 50),
    node("sym-1", "symmetry"),
    node("rep-1", "replicate"),
    node("traj-1", "load_trajectory"),
    node("vp-1", "viewport"),
  ];
  const edges = [
    edge("loader-1", "particle", "sym-1", "particle"),
    edge("loader-1", "cell", "rep-1", "cell"),
    edge("loader-1", "particle", "traj-1", "particle"),
    edge("loader-1", "trajectory", "vp-1", "trajectory"),
    edge("sym-1", "particle", "vp-1", "particle"),
  ];
  return { nodes, edges };
}

describe("editSync", () => {
  it("finds the primary loader and no edit node on a fresh graph", () => {
    const { nodes } = graph();
    expect(findPrimaryLoader(nodes)?.id).toBe("loader-1");
    expect(findBuildEditNode(nodes)).toBeNull();
    expect(findPrimaryLoader([node("vp-1", "viewport")])).toBeNull();
  });

  it("splices an edit node between the loader and its particle / cell consumers", () => {
    const { nodes, edges } = graph();
    const out = ensureBuildEditNode(nodes, edges, "loader-1", 42);

    expect(out.editId).toBe(BUILD_EDIT_NODE_ID);
    const editNode = out.nodes.find((n) => n.id === BUILD_EDIT_NODE_ID)!;
    expect(editNode.type).toBe("edit");
    expect((editNode.data.params as EditParams).sourceAtomCount).toBe(42);
    expect(editNode.position).toEqual({ x: 460, y: 50 });
    // Untouched inputs.
    expect(nodes.length).toBe(5);
    expect(edges.length).toBe(5);

    const has = (s: string, sh: string, t: string, th: string) =>
      out.edges.some(
        (e) => e.source === s && e.sourceHandle === sh && e.target === t && e.targetHandle === th,
      );
    // Loader feeds the edit node...
    expect(has("loader-1", "particle", BUILD_EDIT_NODE_ID, "particle")).toBe(true);
    expect(has("loader-1", "cell", BUILD_EDIT_NODE_ID, "cell")).toBe(true);
    // ...which now feeds the former loader consumers.
    expect(has(BUILD_EDIT_NODE_ID, "particle", "sym-1", "particle")).toBe(true);
    expect(has(BUILD_EDIT_NODE_ID, "cell", "rep-1", "cell")).toBe(true);
    expect(has("loader-1", "particle", "sym-1", "particle")).toBe(false);
    // load_trajectory keeps reading the loader; trajectory edges are untouched.
    expect(has("loader-1", "particle", "traj-1", "particle")).toBe(true);
    expect(has("loader-1", "trajectory", "vp-1", "trajectory")).toBe(true);
    expect(out.edges.length).toBe(7);
    // Rewired edges get fresh ids so React Flow does not collide.
    const ids = new Set(out.edges.map((e) => e.id));
    expect(ids.size).toBe(out.edges.length);
  });

  it("is idempotent once the edit node exists", () => {
    const { nodes, edges } = graph();
    const first = ensureBuildEditNode(nodes, edges, "loader-1", 3);
    const second = ensureBuildEditNode(first.nodes, first.edges, "loader-1", 3);
    expect(second.nodes).toBe(first.nodes);
    expect(second.edges).toBe(first.edges);
    expect(second.editId).toBe(first.editId);
  });

  it("adopts a hand-placed edit node instead of adding a second one", () => {
    const { nodes, edges } = graph();
    const custom = node("my-edit", "edit");
    const out = ensureBuildEditNode([...nodes, custom], edges, "loader-1", null);
    expect(out.editId).toBe("my-edit");
    expect(findBuildEditNode(out.nodes)?.id).toBe("my-edit");
  });

  it("places the node at the origin when the loader id is unknown", () => {
    const { nodes, edges } = graph();
    const out = ensureBuildEditNode(nodes, edges, "nope", null);
    const editNode = out.nodes.find((n) => n.id === BUILD_EDIT_NODE_ID)!;
    expect(editNode.position).toEqual({ x: 360, y: 0 });
  });
});
