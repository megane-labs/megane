import { describe, it, expect } from "vitest";
import {
  createDefaultPipeline,
  createEmptyPipeline,
  createDemoPipeline,
} from "@/pipeline/defaults";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Check that every edge references existing node IDs. */
function assertEdgesValid(nodes: { id: string }[], edges: { source: string; target: string }[]) {
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    expect(ids.has(e.source), `edge source "${e.source}" not in nodes`).toBe(true);
    expect(ids.has(e.target), `edge target "${e.target}" not in nodes`).toBe(true);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("createDefaultPipeline", () => {
  it("returns nodes and edges", () => {
    const { nodes, edges } = createDefaultPipeline();
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("contains a load_structure and viewport node", () => {
    const { nodes } = createDefaultPipeline();
    expect(nodes.some((n) => n.type === "load_structure")).toBe(true);
    expect(nodes.some((n) => n.type === "viewport")).toBe(true);
  });

  it("all edges reference valid node IDs", () => {
    const { nodes, edges } = createDefaultPipeline();
    assertEdgesValid(nodes, edges);
  });

  it("has no duplicate node IDs", () => {
    const { nodes } = createDefaultPipeline();
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a symmetry node in expand mode between loader and wrap", () => {
    const { nodes, edges } = createDefaultPipeline();
    const symmetry = nodes.find((n) => n.type === "symmetry")!;
    expect(symmetry).toBeDefined();
    expect(symmetry.data.params).toEqual({ type: "symmetry", mode: "expand" });
    const loader = nodes.find((n) => n.type === "load_structure")!;
    const wrap = nodes.find((n) => n.type === "wrap")!;
    expect(
      edges.some(
        (e) => e.source === loader.id && e.target === symmetry.id && e.sourceHandle === "particle",
      ),
    ).toBe(true);
    expect(edges.some((e) => e.source === symmetry.id && e.target === wrap.id)).toBe(true);
  });
});

describe("createEmptyPipeline", () => {
  it("returns 6 nodes: LoadStructure, Symmetry, Wrap, Replicate, AddBond, Viewport", () => {
    const { nodes } = createEmptyPipeline();
    expect(nodes.length).toBe(6);
    expect(nodes[0].type).toBe("load_structure");
    expect(nodes[1].type).toBe("symmetry");
    expect(nodes[2].type).toBe("wrap");
    expect(nodes[3].type).toBe("replicate");
    expect(nodes[4].type).toBe("add_bond");
    expect(nodes[5].type).toBe("viewport");
  });

  it("keeps the wrap node in pass-through mode by default", () => {
    const { nodes } = createEmptyPipeline();
    const wrap = nodes.find((n) => n.type === "wrap")!;
    expect(wrap.data.params).toEqual({ type: "wrap", mode: "none" });
  });

  it("seeds the symmetry node in expand mode between loader and wrap", () => {
    const { nodes, edges } = createEmptyPipeline();
    const symmetry = nodes.find((n) => n.type === "symmetry")!;
    expect(symmetry.data.params).toEqual({ type: "symmetry", mode: "expand" });
    const loader = nodes.find((n) => n.type === "load_structure")!;
    const wrap = nodes.find((n) => n.type === "wrap")!;
    expect(
      edges.some(
        (e) =>
          e.source === loader.id &&
          e.target === symmetry.id &&
          e.sourceHandle === "particle" &&
          e.targetHandle === "particle",
      ),
    ).toBe(true);
    expect(
      edges.some(
        (e) =>
          e.source === symmetry.id &&
          e.target === wrap.id &&
          e.sourceHandle === "particle" &&
          e.targetHandle === "particle",
      ),
    ).toBe(true);
  });

  it("all edges reference valid node IDs", () => {
    const { nodes, edges } = createEmptyPipeline();
    assertEdgesValid(nodes, edges);
  });

  it("has edges connecting the chain", () => {
    const { edges } = createEmptyPipeline();
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });
});

describe("createDemoPipeline", () => {
  it("contains filter and modify nodes", () => {
    const { nodes } = createDemoPipeline();
    expect(nodes.some((n) => n.type === "filter")).toBe(true);
    expect(nodes.some((n) => n.type === "modify")).toBe(true);
  });

  it("all edges reference valid node IDs", () => {
    const { nodes, edges } = createDemoPipeline();
    assertEdgesValid(nodes, edges);
  });

  it("all nodes are enabled", () => {
    const { nodes } = createDemoPipeline();
    for (const node of nodes) {
      expect(node.data.enabled).toBe(true);
    }
  });
});
