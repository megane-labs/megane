import { describe, it, expect } from "vitest";
import { validatePipeline } from "@/pipeline/validate";
import type { PipelineNodeData } from "@/pipeline/execute";
import type { Node, Edge } from "@xyflow/react";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeNode(
  id: string,
  type: string,
  params: Record<string, unknown>,
  enabled = true,
): Node<PipelineNodeData> {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      params: { type, ...params } as any,
      enabled,
    },
  };
}

function makeEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): Edge {
  return {
    id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("validatePipeline", () => {
  it("returns no errors for a valid simple pipeline", () => {
    const nodes = [
      makeNode("ls", "load_structure", {
        fileName: "test.pdb",
        hasTrajectory: false,
        hasCell: false,
      }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("ls", "particle", "vp", "particle")];
    const errors = validatePipeline(nodes, edges);
    expect(errors.size).toBe(0);
  });

  it("reports error when required input is not connected", () => {
    const nodes = [
      makeNode("f", "filter", { query: "" }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("f", "out", "vp", "particle")];
    const errors = validatePipeline(nodes, edges);
    expect(errors.has("f")).toBe(true);
    const filterErrors = errors.get("f")!;
    expect(filterErrors.some((e) => e.message === "No input connected")).toBe(true);
  });

  it("does not report missing input for load_structure (no required inputs)", () => {
    const nodes = [
      makeNode("ls", "load_structure", {
        fileName: "test.pdb",
        hasTrajectory: false,
        hasCell: false,
      }),
    ];
    const errors = validatePipeline(nodes, []);
    // load_structure has no required inputs, but it's not connected to viewport
    const lsErrors = errors.get("ls") ?? [];
    expect(lsErrors.every((e) => e.message !== "No input connected")).toBe(true);
  });

  it("warns when node is not connected to viewport", () => {
    const nodes = [
      makeNode("ls", "load_structure", {
        fileName: "test.pdb",
        hasTrajectory: false,
        hasCell: false,
      }),
      makeNode("f", "filter", { query: "" }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    // Only ls→vp connected, filter is isolated
    const edges = [makeEdge("ls", "particle", "vp", "particle")];
    const errors = validatePipeline(nodes, edges);
    expect(errors.has("f")).toBe(true);
    const filterErrors = errors.get("f")!;
    expect(filterErrors.some((e) => e.message === "Not connected to Viewport")).toBe(true);
  });

  it("detects cycles", () => {
    const nodes = [makeNode("a", "filter", { query: "" }), makeNode("b", "filter", { query: "" })];
    const edges = [makeEdge("a", "out", "b", "in"), makeEdge("b", "out", "a", "in")];
    const errors = validatePipeline(nodes, edges);
    // At least one node should have a cycle error
    const allErrors = [...errors.values()].flat();
    expect(allErrors.some((e) => e.message === "Cycle detected")).toBe(true);
  });

  it("warns when load_structure has no fileName", () => {
    const nodes = [
      makeNode("ls", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("ls", "particle", "vp", "particle")];
    const errors = validatePipeline(nodes, edges);
    expect(errors.has("ls")).toBe(true);
    const lsErrors = errors.get("ls")!;
    expect(lsErrors.some((e) => e.message === "No structure file loaded")).toBe(true);
  });

  it("warns when load_trajectory has no fileName", () => {
    const nodes = [
      makeNode("lt", "load_trajectory", { fileName: null }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("lt", "trajectory", "vp", "trajectory")];
    const errors = validatePipeline(nodes, edges);
    const ltErrors = errors.get("lt") ?? [];
    expect(ltErrors.some((e) => e.message === "No trajectory file loaded")).toBe(true);
  });

  it("warns when load_vector has no fileName", () => {
    const nodes = [
      makeNode("lv", "load_vector", { fileName: null }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("lv", "vector", "vp", "vector")];
    const errors = validatePipeline(nodes, edges);
    const lvErrors = errors.get("lv") ?? [];
    expect(lvErrors.some((e) => e.message === "No vector file loaded")).toBe(true);
  });

  it("reports error for filter with invalid query syntax", () => {
    const nodes = [
      makeNode("ls", "load_structure", {
        fileName: "test.pdb",
        hasTrajectory: false,
        hasCell: false,
      }),
      makeNode("f", "filter", { query: 'foo == "bar"' }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("ls", "particle", "f", "in"), makeEdge("f", "out", "vp", "particle")];
    const errors = validatePipeline(nodes, edges);
    expect(errors.has("f")).toBe(true);
    const filterErrors = errors.get("f")!;
    expect(filterErrors.some((e) => e.message.includes("Query syntax error"))).toBe(true);
  });

  it("reports center / neighbor query syntax errors on Coordination", () => {
    const coordination = (centerQuery: string, neighborQuery: string) => [
      makeNode("ls", "load_structure", {
        fileName: "test.pdb",
        hasTrajectory: false,
        hasCell: false,
      }),
      makeNode("coord", "coordination_generator", {
        excludedCenters: [],
        excludedLigands: [],
        centerQuery,
        neighborQuery,
        cutoffTolerance: 1.15,
        boundaryMode: "complete",
      }),
    ];
    const edges = [makeEdge("ls", "particle", "coord", "particle")];
    const bad = validatePipeline(coordination("element ==", 'foo == "bar"'), edges).get("coord")!;
    const messages = bad.filter((e) => e.severity === "error").map((e) => e.message);
    expect(messages.some((m) => m.startsWith("Center query syntax error"))).toBe(true);
    expect(messages.some((m) => m.startsWith("Neighbor query syntax error"))).toBe(true);
    const good = validatePipeline(coordination('element == "P"', ""), edges).get("coord") ?? [];
    expect(good.some((e) => e.message.includes("query syntax error"))).toBe(false);
  });

  it("does not raise config errors for a Coordination -> Polyhedra graph", () => {
    const nodes = [
      makeNode("ls", "load_structure", {
        fileName: "test.pdb",
        hasTrajectory: false,
        hasCell: false,
      }),
      makeNode("coord", "coordination_generator", {
        excludedCenters: [],
        excludedLigands: [],
        cutoffTolerance: 1.15,
        boundaryMode: "complete",
      }),
      makeNode("pg", "polyhedron_generator", {
        opacity: 0.5,
        showEdges: false,
        edgeColor: "#dddddd",
        edgeWidth: 3,
      }),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [
      makeEdge("ls", "particle", "coord", "particle"),
      makeEdge("coord", "coordination", "pg", "coordination"),
      makeEdge("pg", "mesh", "vp", "mesh"),
    ];
    const errors = validatePipeline(nodes, edges);
    const pgErrors = errors.get("pg") ?? [];
    expect(pgErrors.some((e) => e.severity === "error")).toBe(false);
  });

  it("skips config validation for disabled nodes", () => {
    const nodes = [
      makeNode(
        "ls",
        "load_structure",
        { fileName: null, hasTrajectory: false, hasCell: false },
        false,
      ),
      makeNode("vp", "viewport", { perspective: false, cellAxesVisible: true }),
    ];
    const edges = [makeEdge("ls", "particle", "vp", "particle")];
    const errors = validatePipeline(nodes, edges);
    const lsErrors = errors.get("ls") ?? [];
    // Disabled node should not get config warnings like "No structure file loaded"
    expect(lsErrors.some((e) => e.message === "No structure file loaded")).toBe(false);
  });

  it("handles empty pipeline", () => {
    const errors = validatePipeline([], []);
    expect(errors.size).toBe(0);
  });
});
