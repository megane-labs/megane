import { describe, it, expect } from "vitest";
import {
  canConnect,
  defaultParams,
  NODE_PORTS,
  NODE_TYPE_LABELS,
  NODE_CATEGORY,
  DATA_TYPE_COLORS,
} from "@/pipeline/types";
import type { PipelineNodeType } from "@/pipeline/types";

// ─── canConnect ─────────────────────────────────────────────────────

describe("canConnect", () => {
  it("allows particle → viewport particle", () => {
    expect(canConnect("load_structure", "particle", "viewport", "particle")).toBe(true);
  });

  it("allows trajectory → viewport trajectory", () => {
    expect(canConnect("load_structure", "trajectory", "viewport", "trajectory")).toBe(true);
  });

  it("allows cell → viewport cell", () => {
    expect(canConnect("load_structure", "cell", "viewport", "cell")).toBe(true);
  });

  it("allows particle → filter (generic node accepts particle)", () => {
    expect(canConnect("load_structure", "particle", "filter", "in")).toBe(true);
  });

  it("allows particle → modify (generic node accepts particle)", () => {
    expect(canConnect("load_structure", "particle", "modify", "in")).toBe(true);
  });

  it("rejects mismatched types: trajectory → viewport particle", () => {
    expect(canConnect("load_structure", "trajectory", "viewport", "particle")).toBe(false);
  });

  it("rejects cell → filter (generic only accepts particle/bond)", () => {
    expect(canConnect("load_structure", "cell", "filter", "in")).toBe(false);
  });

  it("returns false for null source handle", () => {
    expect(canConnect("load_structure", null, "viewport", "particle")).toBe(false);
  });

  it("returns false for null target handle", () => {
    expect(canConnect("load_structure", "particle", "viewport", null)).toBe(false);
  });

  it("returns false for non-existent source handle", () => {
    expect(canConnect("load_structure", "nonexistent", "viewport", "particle")).toBe(false);
  });

  it("returns false for non-existent target handle", () => {
    expect(canConnect("load_structure", "particle", "viewport", "nonexistent")).toBe(false);
  });

  it("allows bond → viewport bond (add_bond output → viewport)", () => {
    expect(canConnect("add_bond", "bond", "viewport", "bond")).toBe(true);
  });

  it("allows label → viewport label", () => {
    expect(canConnect("label_generator", "label", "viewport", "label")).toBe(true);
  });

  it("allows mesh → viewport mesh", () => {
    expect(canConnect("polyhedron_generator", "mesh", "viewport", "mesh")).toBe(true);
  });

  it("requires Coordination data for Polyhedra", () => {
    expect(
      canConnect("coordination_generator", "coordination", "polyhedron_generator", "coordination"),
    ).toBe(true);
    expect(canConnect("load_structure", "particle", "polyhedron_generator", "coordination")).toBe(
      false,
    );
  });

  it("allows particle → add_bond particle", () => {
    expect(canConnect("load_structure", "particle", "add_bond", "particle")).toBe(true);
  });
});

// ─── defaultParams ──────────────────────────────────────────────────

describe("defaultParams", () => {
  it("returns correct defaults for load_structure", () => {
    const params = defaultParams("load_structure");
    expect(params).toEqual({
      type: "load_structure",
      fileName: null,
      hasTrajectory: false,
      hasCell: false,
    });
  });

  it("returns correct defaults for filter", () => {
    const params = defaultParams("filter");
    expect(params).toEqual({
      type: "filter",
      query: "",
      bond_query: "",
    }); // bond_query is included in defaults
  });

  it("returns correct defaults for modify", () => {
    const params = defaultParams("modify");
    expect(params).toEqual({
      type: "modify",
      scale: 1.0,
      opacity: 1.0,
    });
  });

  it("returns correct defaults for color", () => {
    const params = defaultParams("color");
    expect(params).toEqual({
      type: "color",
      mode: "uniform",
      uniformColor: "#ff8800",
    });
  });

  it("returns correct defaults for representation", () => {
    const params = defaultParams("representation");
    expect(params).toEqual({
      type: "representation",
      mode: "atoms",
    });
  });

  it("returns correct defaults for viewport", () => {
    const params = defaultParams("viewport");
    expect(params).toEqual({
      type: "viewport",
      perspective: false,
      cellAxesVisible: true,
      pivotMarkerVisible: true,
    });
  });

  it("returns correct defaults for add_bond", () => {
    const params = defaultParams("add_bond");
    expect(params).toEqual({
      type: "add_bond",
      bondSource: "distance",
    });
  });

  it("returns correct defaults for polyhedron_generator", () => {
    const params = defaultParams("polyhedron_generator");
    expect(params).toEqual({
      type: "polyhedron_generator",
      opacity: 0.5,
      showEdges: false,
      edgeColor: "#dddddd",
      edgeWidth: 3,
    });
  });

  it("keeps Drawing Boundary and Coordination defaults separate", () => {
    expect(defaultParams("drawing_boundary")).toEqual({
      type: "drawing_boundary",
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
      zMin: 0,
      zMax: 1,
    });
    expect(defaultParams("coordination_generator")).toEqual({
      type: "coordination_generator",
      excludedCenters: [],
      excludedLigands: [],
      cutoffTolerance: 1.15,
      boundaryMode: "complete",
    });
  });

  it("returns correct defaults for label_generator", () => {
    const params = defaultParams("label_generator");
    expect(params).toEqual({
      type: "label_generator",
      source: "element",
    });
  });

  it("returns correct defaults for vector_overlay", () => {
    const params = defaultParams("vector_overlay");
    expect(params).toEqual({
      type: "vector_overlay",
      scale: 1.0,
    });
  });

  it("returns correct defaults for load_trajectory", () => {
    const params = defaultParams("load_trajectory");
    expect(params).toEqual({
      type: "load_trajectory",
      fileName: null,
      source: "file",
    });
  });

  it("returns correct defaults for streaming", () => {
    const params = defaultParams("streaming");
    expect(params).toEqual({
      type: "streaming",
      connected: false,
    });
  });

  it("returns correct defaults for load_vector", () => {
    const params = defaultParams("load_vector");
    expect(params).toEqual({
      type: "load_vector",
      fileName: null,
    });
  });
});

// ─── NODE_PORTS completeness ────────────────────────────────────────

describe("NODE_PORTS", () => {
  const allNodeTypes: PipelineNodeType[] = [
    "load_structure",
    "load_trajectory",
    "load_vector",
    "streaming",
    "add_bond",
    "viewport",
    "filter",
    "modify",
    "color",
    "representation",
    "label_generator",
    "polyhedron_generator",
    "vector_overlay",
  ];

  it("defines ports for all node types", () => {
    for (const nodeType of allNodeTypes) {
      expect(NODE_PORTS[nodeType]).toBeDefined();
      expect(NODE_PORTS[nodeType].inputs).toBeInstanceOf(Array);
      expect(NODE_PORTS[nodeType].outputs).toBeInstanceOf(Array);
    }
  });

  it("load_structure has no inputs and 3 outputs", () => {
    const ports = NODE_PORTS["load_structure"];
    expect(ports.inputs).toHaveLength(0);
    expect(ports.outputs).toHaveLength(3);
  });

  it("viewport has 7 inputs and no outputs", () => {
    const ports = NODE_PORTS["viewport"];
    expect(ports.inputs).toHaveLength(7);
    expect(ports.outputs).toHaveLength(0);
  });
});

// ─── NODE_TYPE_LABELS ───────────────────────────────────────────────

describe("NODE_TYPE_LABELS", () => {
  it("has labels for all node types", () => {
    const allTypes: PipelineNodeType[] = [
      "load_structure",
      "load_trajectory",
      "load_vector",
      "add_bond",
      "viewport",
      "filter",
      "modify",
      "color",
      "representation",
      "label_generator",
      "polyhedron_generator",
      "vector_overlay",
    ];
    for (const t of allTypes) {
      expect(NODE_TYPE_LABELS[t]).toBeDefined();
      expect(typeof NODE_TYPE_LABELS[t]).toBe("string");
    }
  });
});

// ─── DATA_TYPE_COLORS ───────────────────────────────────────────────

describe("DATA_TYPE_COLORS", () => {
  it("defines colors for all data types", () => {
    const dataTypes = [
      "particle",
      "bond",
      "cell",
      "label",
      "mesh",
      "trajectory",
      "vector",
    ] as const;
    for (const dt of dataTypes) {
      expect(DATA_TYPE_COLORS[dt]).toBeDefined();
      expect(DATA_TYPE_COLORS[dt]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
