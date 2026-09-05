import { describe, it, expect } from "vitest";
import { serializePipeline, deserializePipeline } from "@/pipeline/serialize";
import type { PipelineNodeData } from "@/pipeline/execute";
import type { Node, Edge } from "@xyflow/react";
import { NODE_PORTS, defaultParams } from "@/pipeline/types";
import type { SerializedPipeline, PipelineNodeType } from "@/pipeline/types";

function makeNode(
  id: string,
  type: string,
  params: Record<string, unknown>,
  position = { x: 0, y: 0 },
  enabled = true,
): Node<PipelineNodeData> {
  return {
    id,
    type,
    position,
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
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  };
}

describe("serializePipeline", () => {
  it("serializes nodes and edges to version 3 format", () => {
    const nodes = [
      makeNode("n1", "load_structure", { fileName: null, hasTrajectory: false, hasCell: false }),
      makeNode("n2", "viewport", { perspective: false, cellAxesVisible: true }, { x: 200, y: 0 }),
    ];
    const edges = [makeEdge("n1", "particle", "n2", "particle")];

    const result = serializePipeline(nodes, edges);

    expect(result.version).toBe(3);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes[0].id).toBe("n1");
    expect(result.nodes[0].type).toBe("load_structure");
    expect(result.nodes[1].position).toEqual({ x: 200, y: 0 });
    expect(result.edges[0].source).toBe("n1");
    expect(result.edges[0].targetHandle).toBe("particle");
  });

  it("preserves enabled state", () => {
    const nodes = [makeNode("n1", "filter", { query: 'element == "C"' }, { x: 0, y: 0 }, false)];
    const result = serializePipeline(nodes, []);
    expect(result.nodes[0].enabled).toBe(false);
  });
});

describe("deserializePipeline", () => {
  it("throws on unsupported version", () => {
    const json = { version: 1, nodes: [], edges: [] } as any;
    expect(() => deserializePipeline(json)).toThrow("Unsupported pipeline version");
  });

  it("throws on unknown node type", () => {
    const json: any = {
      version: 3,
      nodes: [{ id: "n1", type: "unknown_type", position: { x: 0, y: 0 } }],
      edges: [],
    };
    expect(() => deserializePipeline(json)).toThrow("Unknown node type");
  });

  it("round-trips every supported node type (regression: surface_mesh / load_volumetric / isosurface)", () => {
    // Regression guard for the previously hardcoded VALID_NODE_TYPES set, which
    // omitted surface_mesh, load_volumetric, and isosurface and therefore made
    // deserializePipeline throw "Unknown node type" on any pipeline using them.
    const allTypes = Object.keys(NODE_PORTS) as PipelineNodeType[];
    const nodes = allTypes.map((type, i) =>
      makeNode(`${type}-${i}`, type, defaultParams(type) as Record<string, unknown>, {
        x: i * 100,
        y: 0,
      }),
    );

    const serialized = serializePipeline(nodes, []);
    expect(() => deserializePipeline(serialized)).not.toThrow();

    const { nodes: restored } = deserializePipeline(serialized);
    const restoredTypes = new Set(restored.map((n) => (n.data.params as { type: string }).type));
    for (const type of allTypes) {
      expect(restoredTypes.has(type), `${type} was dropped on round-trip`).toBe(true);
    }
  });

  it("applies default params on deserialize", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [{ id: "n1", type: "filter", position: { x: 0, y: 0 } } as any],
      edges: [],
    };
    const { nodes } = deserializePipeline(json);
    expect((nodes[0].data.params as any).query).toBe(""); // default
  });

  it("defaults position to {x:0, y:0} when missing", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [{ id: "n1", type: "viewport" } as any],
      edges: [],
    };
    const { nodes } = deserializePipeline(json);
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("keeps Polyhedra appearance-only when legacy search fields are present", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [
        {
          id: "poly",
          type: "polyhedron_generator",
          position: { x: 0, y: 0 },
          centerElements: [22],
          ligandElements: [8],
          maxDistance: 2.5,
          opacity: 0.7,
          showEdges: true,
          edgeColor: "#abcdef",
          edgeWidth: 4,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      edges: [],
    };
    const { nodes } = deserializePipeline(json);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = nodes[0].data.params as any;
    expect(params.excludedCenters).toBeUndefined();
    expect(params.excludedLigands).toBeUndefined();
    expect(params.cutoffTolerance).toBeUndefined();
    // Non-legacy fields the user set should still survive.
    expect(params.opacity).toBe(0.7);
    expect(params.showEdges).toBe(true);
    expect(params.edgeColor).toBe("#abcdef");
    expect(params.edgeWidth).toBe(4);
    // Legacy fields are gone.
    expect(params.centerElements).toBeUndefined();
    expect(params.ligandElements).toBeUndefined();
    expect(params.maxDistance).toBeUndefined();
  });

  it("defaults enabled to true when not specified", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [{ id: "n1", type: "viewport", position: { x: 0, y: 0 } } as any],
      edges: [],
    };
    const { nodes } = deserializePipeline(json);
    expect(nodes[0].data.enabled).toBe(true);
  });

  it("generates deterministic edge IDs", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [
        { id: "a", type: "load_structure", position: { x: 0, y: 0 } } as any,
        { id: "b", type: "viewport", position: { x: 200, y: 0 } } as any,
      ],
      edges: [{ source: "a", target: "b", sourceHandle: "particle", targetHandle: "particle" }],
    };
    const { edges } = deserializePipeline(json);
    expect(edges[0].id).toBe("e-a-particle-b-particle-0");
  });
});

describe("round-trip serialization", () => {
  it("preserves structure through serialize → deserialize (auto-normalizes AddBond)", () => {
    const nodes = [
      makeNode(
        "n1",
        "load_structure",
        { fileName: "test.pdb", hasTrajectory: false, hasCell: true },
        { x: 10, y: 20 },
      ),
      makeNode("n2", "filter", { query: 'element == "C"' }, { x: 100, y: 20 }),
      makeNode("n3", "viewport", { perspective: true, cellAxesVisible: false }, { x: 200, y: 20 }),
      makeNode("ab", "add_bond", { bondSource: "structure" }, { x: 50, y: 100 }),
    ];
    const edges = [
      makeEdge("n1", "particle", "n2", "in"),
      makeEdge("n2", "out", "n3", "particle"),
      makeEdge("n1", "particle", "ab", "particle"),
      makeEdge("ab", "bond", "n3", "bond"),
    ];

    const serialized = serializePipeline(nodes, edges);
    const { nodes: restored, edges: restoredEdges } = deserializePipeline(serialized);

    expect(restored).toHaveLength(4);
    expect(restoredEdges.length).toBeGreaterThanOrEqual(4);

    // Check node params preserved
    const loader = restored.find((n) => n.id === "n1")!;
    const filter = restored.find((n) => n.id === "n2")!;
    const viewport = restored.find((n) => n.id === "n3")!;
    expect((loader.data.params as any).fileName).toBe("test.pdb");
    expect((filter.data.params as any).query).toBe('element == "C"');
    expect((viewport.data.params as any).perspective).toBe(true);
    expect((viewport.data.params as any).cellAxesVisible).toBe(false);

    // Check positions preserved
    expect(loader.position).toEqual({ x: 10, y: 20 });
  });
});

describe("deserializePipeline normalization", () => {
  /** loader -> add_bond, with the bond stream optionally routed via filter/modify. */
  function bondGraph(routed: boolean): SerializedPipeline {
    const nodes = [
      { id: "load-1", type: "load_structure", fileName: "s.pdb" },
      { id: "ab-1", type: "add_bond" },
      { id: "view-1", type: "viewport" },
      ...(routed
        ? [
            { id: "fb-1", type: "filter", query: "", bond_query: "both atom_index >= 24" },
            { id: "mb-1", type: "modify", scale: 1, opacity: 0 },
          ]
        : []),
    ];
    const edges = [
      { source: "load-1", sourceHandle: "particle", target: "ab-1", targetHandle: "particle" },
      { source: "load-1", sourceHandle: "particle", target: "view-1", targetHandle: "particle" },
      ...(routed
        ? [
            { source: "ab-1", sourceHandle: "bond", target: "fb-1", targetHandle: "in" },
            { source: "fb-1", sourceHandle: "out", target: "mb-1", targetHandle: "in" },
            { source: "mb-1", sourceHandle: "out", target: "view-1", targetHandle: "bond" },
          ]
        : []),
    ];
    return { version: 3, nodes, edges } as unknown as SerializedPipeline;
  }

  const rawBondEdge = (edges: Edge[]) =>
    edges.filter(
      (e) =>
        e.source === "ab-1" &&
        e.sourceHandle === "bond" &&
        e.target === "view-1" &&
        e.targetHandle === "bond",
    );

  it("wires AddBond straight to the viewport when nothing else feeds viewport.bond", () => {
    const { edges } = deserializePipeline(bondGraph(false));
    expect(rawBondEdge(edges)).toHaveLength(1);
  });

  // The raw stream would be drawn at full opacity underneath the faded copy,
  // which makes fading or hiding a species' bonds impossible — and that branch
  // is the only way to reach viewport.bond with a selection applied.
  it("leaves the raw bond stream out when a filtered branch already feeds viewport.bond", () => {
    const { edges } = deserializePipeline(bondGraph(true));
    expect(rawBondEdge(edges)).toHaveLength(0);
    expect(
      edges.some((e) => e.source === "mb-1" && e.target === "view-1" && e.targetHandle === "bond"),
    ).toBe(true);
  });

  it("migrates legacy Polyhedra wiring to Drawing Boundary and Coordination", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [
        {
          id: "load-1",
          type: "load_structure",
          fileName: "crystal.xyz",
          hasTrajectory: false,
          hasCell: true,
        } as any,
        { id: "poly-1", type: "polyhedron_generator", boundaryMode: "complete" } as any,
        { id: "viewport-1", type: "viewport" } as any,
      ],
      edges: [
        {
          source: "load-1",
          target: "poly-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        {
          source: "load-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        {
          source: "poly-1",
          target: "viewport-1",
          sourceHandle: "bond",
          targetHandle: "bond",
        },
      ],
    };

    const { nodes, edges } = deserializePipeline(json);
    expect(nodes.some((node) => node.type === "add_bond")).toBe(false);
    const boundary = nodes.find((node) => node.type === "drawing_boundary")!;
    const coordination = nodes.find((node) => node.type === "coordination_generator")!;
    expect(boundary).toBeDefined();
    expect(coordination).toBeDefined();
    expect((coordination.data.params as any).boundaryMode).toBe("complete");
    expect(
      edges.some(
        (edge) =>
          edge.source === coordination.id &&
          edge.sourceHandle === "bond" &&
          edge.target === "viewport-1" &&
          edge.targetHandle === "bond",
      ),
    ).toBe(true);
    expect(
      edges.some(
        (edge) =>
          edge.source === coordination.id &&
          edge.sourceHandle === "coordination" &&
          edge.target === "poly-1" &&
          edge.targetHandle === "coordination",
      ),
    ).toBe(true);
    expect(
      edges.some(
        (edge) =>
          edge.source === boundary.id &&
          edge.sourceHandle === "particle" &&
          edge.target === "viewport-1" &&
          edge.targetHandle === "particle",
      ),
    ).toBe(true);
  });

  /**
   * Regression: hand-written or older `.megane.json` files sometimes wired
   * LoadStructure.particle straight to Viewport with no AddBond, so the
   * graph rendered without bonds. deserialize now injects the canonical
   * LoadStructure → AddBond → Viewport scaffold (plus cell + trajectory
   * edges) when missing.
   */
  it("auto-injects an AddBond when the saved graph lacks one", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [
        {
          id: "load-1",
          type: "load_structure",
          fileName: "x.pdb",
          hasTrajectory: false,
          hasCell: true,
        } as any,
        {
          id: "viewport-1",
          type: "viewport",
          cellAxesVisible: false,
          pivotMarkerVisible: false,
        } as any,
      ],
      edges: [
        {
          source: "load-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    };
    const { nodes, edges } = deserializePipeline(json);

    const addBond = nodes.find((n) => n.type === "add_bond");
    expect(addBond, "AddBond node should be auto-injected").toBeDefined();

    const hasEdge = (s: string, sh: string, t: string, th: string) =>
      edges.some(
        (e) => e.source === s && e.sourceHandle === sh && e.target === t && e.targetHandle === th,
      );

    expect(
      hasEdge("load-1", "particle", addBond!.id, "particle"),
      "loader → AddBond.particle",
    ).toBe(true);
    expect(hasEdge(addBond!.id, "bond", "viewport-1", "bond"), "AddBond.bond → viewport.bond").toBe(
      true,
    );
    expect(hasEdge("load-1", "cell", "viewport-1", "cell"), "loader.cell → viewport.cell").toBe(
      true,
    );

    // Viewport guide settings (cellAxesVisible / pivotMarkerVisible) must
    // be preserved, not overwritten by defaults.
    const viewport = nodes.find((n) => n.id === "viewport-1")!;
    expect((viewport.data.params as any).cellAxesVisible).toBe(false);
    expect((viewport.data.params as any).pivotMarkerVisible).toBe(false);
  });

  it("adds a trajectory edge when the loader had hasTrajectory: true", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [
        {
          id: "load-1",
          type: "load_structure",
          fileName: "traj.xyz",
          hasTrajectory: true,
          hasCell: false,
        } as any,
        {
          id: "viewport-1",
          type: "viewport",
          cellAxesVisible: true,
          pivotMarkerVisible: true,
        } as any,
      ],
      edges: [
        {
          source: "load-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
      ],
    };
    const { edges } = deserializePipeline(json);
    expect(
      edges.some(
        (e) =>
          e.source === "load-1" &&
          e.sourceHandle === "trajectory" &&
          e.target === "viewport-1" &&
          e.targetHandle === "trajectory",
      ),
      "loader.trajectory → viewport.trajectory",
    ).toBe(true);
  });

  it("does not duplicate edges when the canonical wiring is already present", () => {
    const json: SerializedPipeline = {
      version: 3,
      nodes: [
        {
          id: "load-1",
          type: "load_structure",
          fileName: "x.pdb",
          hasTrajectory: false,
          hasCell: true,
        } as any,
        { id: "addbond-1", type: "add_bond", bondSource: "structure" } as any,
        { id: "viewport-1", type: "viewport" } as any,
      ],
      edges: [
        {
          source: "load-1",
          target: "addbond-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        {
          source: "load-1",
          target: "viewport-1",
          sourceHandle: "particle",
          targetHandle: "particle",
        },
        { source: "load-1", target: "viewport-1", sourceHandle: "cell", targetHandle: "cell" },
        { source: "addbond-1", target: "viewport-1", sourceHandle: "bond", targetHandle: "bond" },
      ],
    };
    const { nodes, edges } = deserializePipeline(json);
    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(4);
  });
});
