import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "@/pipeline/execute";
import { createDefaultPipeline } from "@/pipeline/defaults";
import {
  applyQuickStyle,
  readQuickStyle,
  quickStyleDefaults,
  QUICK_STYLE_IDS,
} from "@/pipeline/quickStyle";
import { reconcileInspectorLayers, defaultInspectorAppearance } from "@/pipeline/inspectorSync";
import { serializePipeline, deserializePipeline } from "@/pipeline/serialize";
import { createPipelineStore } from "@/pipeline/store";
import { PIPELINE_TEMPLATES } from "@/pipeline/templates";
import type {
  AddBondParams,
  ColorParams,
  CoordinationGeneratorParams,
  LabelGeneratorParams,
  ModifyParams,
  PolyhedronGeneratorParams,
  VectorOverlayParams,
  ViewportParams,
} from "@/pipeline/types";
import type { Snapshot } from "@/types";

type G = { nodes: Node<PipelineNodeData>[]; edges: Edge[] };

function base(): G {
  return createDefaultPipeline();
}

function feeders(g: G, target: string, port: string): string[] {
  return g.edges
    .filter((e) => e.target === target && (e.targetHandle ?? "") === port)
    .map((e) => `${e.source}.${e.sourceHandle}`);
}

function edgeSet(g: G): string[] {
  return g.edges.map((e) => `${e.source}.${e.sourceHandle}->${e.target}.${e.targetHandle}`).sort();
}

function apply(g: G, patch: Parameters<typeof applyQuickStyle>[2]): G {
  return applyQuickStyle(g.nodes, g.edges, patch);
}

function params<T>(g: G, id: string): T {
  return g.nodes.find((n) => n.id === id)!.data.params as T;
}

function has(g: G, id: string): boolean {
  return g.nodes.some((n) => n.id === id);
}

/** The Solid template: the pipeline draws polyhedra of its own (`polyhedron-1`). */
function solid(): G {
  return PIPELINE_TEMPLATES.find((t) => t.id === "solid")!.create();
}

describe("readQuickStyle", () => {
  it("reads defaults from an untouched default pipeline", () => {
    const g = base();
    const { style, available } = readQuickStyle(g.nodes, g.edges);
    expect(style).toMatchObject({
      representation: null,
      colorMode: null,
      atomScale: 1,
      atomOpacity: 1,
      bondScale: 1,
      bondOpacity: 1,
      bondTolerance: null, // bonds come from the structure file, not distance
      labels: "none",
      perspective: false,
      cellAxesVisible: true,
      vectorScale: null,
      polyhedra: false,
      pipelinePolyhedra: null,
      polyhedronOpacity: 0.5,
      polyhedronEdges: false,
    });
    expect(available).toEqual({
      viewport: true,
      bonds: true,
      foreignLabels: false,
      foreignStyleNodes: 0,
    });
  });

  it("reports no viewport on an empty graph", () => {
    expect(readQuickStyle([], []).available.viewport).toBe(false);
  });
});

describe("applyQuickStyle — particle chain", () => {
  it("splices an atoms modify between the trunk and the viewport", () => {
    const g = apply(base(), { atomScale: 0.5 });
    expect(params<ModifyParams>(g, QUICK_STYLE_IDS.atoms)).toMatchObject({
      scale: 0.5,
      opacity: 1,
    });
    expect(feeders(g, "viewport-1", "particle")).toEqual([`${QUICK_STYLE_IDS.atoms}.out`]);
    expect(feeders(g, QUICK_STYLE_IDS.atoms, "in")).toEqual(["replicate-1.particle"]);
    // add_bond keeps reading the unstyled trunk.
    expect(feeders(g, "addbond-1", "particle")).toEqual(["replicate-1.particle"]);
    expect(readQuickStyle(g.nodes, g.edges).style.atomScale).toBe(0.5);
  });

  it("orders color → representation → atoms and rebuilds idempotently", () => {
    const g1 = apply(base(), {
      colorMode: "uniform",
      uniformColor: "#123456",
      representation: "licorice",
      atomOpacity: 0.4,
    });
    expect(feeders(g1, QUICK_STYLE_IDS.color, "in")).toEqual(["replicate-1.particle"]);
    expect(feeders(g1, QUICK_STYLE_IDS.representation, "in")).toEqual([
      `${QUICK_STYLE_IDS.color}.out`,
    ]);
    expect(feeders(g1, QUICK_STYLE_IDS.atoms, "in")).toEqual([
      `${QUICK_STYLE_IDS.representation}.out`,
    ]);
    expect(params<ColorParams>(g1, QUICK_STYLE_IDS.color).uniformColor).toBe("#123456");

    const g2 = apply(g1, {});
    expect(edgeSet(g2)).toEqual(edgeSet(g1));
    expect(g2.nodes.map((n) => n.id).sort()).toEqual(g1.nodes.map((n) => n.id).sort());
  });

  it("drops a node once its control is back at the default", () => {
    const g1 = apply(base(), { colorMode: "byChain", atomScale: 0.5 });
    const g2 = apply(g1, { colorMode: null });
    expect(g2.nodes.some((n) => n.id === QUICK_STYLE_IDS.color)).toBe(false);
    expect(feeders(g2, QUICK_STYLE_IDS.atoms, "in")).toEqual(["replicate-1.particle"]);
  });

  it("restores the original graph on Reset", () => {
    const g0 = base();
    const styled = apply(g0, {
      colorMode: "byElement",
      representation: "line",
      atomScale: 2,
      bondScale: 2,
      labels: "element",
      polyhedra: true,
      polyhedronOpacity: 0.2,
    });
    const reset = apply(styled, quickStyleDefaults());
    expect(edgeSet(reset)).toEqual(edgeSet(g0));
    expect(reset.nodes.map((n) => n.id).sort()).toEqual(g0.nodes.map((n) => n.id).sort());
  });

  it("keeps a position the user dragged a node to", () => {
    const g1 = apply(base(), { atomScale: 0.5 });
    const moved = {
      ...g1,
      nodes: g1.nodes.map((n) =>
        n.id === QUICK_STYLE_IDS.atoms ? { ...n, position: { x: 7, y: 9 } } : n,
      ),
    };
    const g2 = apply(moved, { atomScale: 0.8 });
    expect(g2.nodes.find((n) => n.id === QUICK_STYLE_IDS.atoms)!.position).toEqual({ x: 7, y: 9 });
  });

  it("keeps a node the user disabled in the Editor disabled", () => {
    const g1 = apply(base(), { atomScale: 0.5 });
    const off = {
      ...g1,
      nodes: g1.nodes.map((n) =>
        n.id === QUICK_STYLE_IDS.atoms ? { ...n, data: { ...n.data, enabled: false } } : n,
      ),
    };
    const g2 = apply(off, { atomScale: 0.8 });
    expect(g2.nodes.find((n) => n.id === QUICK_STYLE_IDS.atoms)!.data.enabled).toBe(false);
  });

  it("moves Inspector layers behind the chain and back again", () => {
    const g0 = base();
    const layered = reconcileInspectorLayers(
      g0.nodes,
      g0.edges,
      [{ id: "layer-1", name: "Layer 1", query: "", appearance: defaultInspectorAppearance() }],
      { nodeId: "replicate-1", handle: "particle" },
      "viewport-1",
    );
    const g1 = apply(layered, { atomScale: 0.5 });
    expect(feeders(g1, "insp-layer-1-filter", "in")).toEqual([`${QUICK_STYLE_IDS.atoms}.out`]);
    // The layer's own output still reaches the viewport.
    expect(feeders(g1, "viewport-1", "particle")).toContain("insp-layer-1-color.out");

    const g2 = apply(g1, { atomScale: 1 });
    expect(feeders(g2, "insp-layer-1-filter", "in")).toEqual(["replicate-1.particle"]);
  });

  it("leaves a graph without a viewport untouched", () => {
    const nodes = base().nodes.filter((n) => n.type !== "viewport");
    const out = applyQuickStyle(nodes, [], { atomScale: 0.5 });
    expect(out.nodes).toBe(nodes);
  });

  it("creates no chain when nothing feeds the viewport's particle input", () => {
    const g0 = base();
    const edges = g0.edges.filter(
      (e) => !(e.target === "viewport-1" && e.targetHandle === "particle"),
    );
    const out = applyQuickStyle(g0.nodes, edges, {
      atomScale: 0.5,
      labels: "index",
      polyhedra: true,
    });
    expect(out.nodes.some((n) => n.id === QUICK_STYLE_IDS.atoms)).toBe(false);
    expect(out.nodes.some((n) => n.id === QUICK_STYLE_IDS.labels)).toBe(false);
    expect(out.nodes.some((n) => n.id === QUICK_STYLE_IDS.polyhedra)).toBe(false);
  });
});

describe("applyQuickStyle — polyhedra", () => {
  it("adds coordination polyhedra reading the unstyled trunk", () => {
    const g = apply(base(), { polyhedra: true, atomScale: 0.5 });
    expect(feeders(g, QUICK_STYLE_IDS.coordination, "particle")).toEqual(["replicate-1.particle"]);
    expect(feeders(g, QUICK_STYLE_IDS.polyhedra, "coordination")).toEqual([
      `${QUICK_STYLE_IDS.coordination}.coordination`,
    ]);
    expect(feeders(g, "viewport-1", "mesh")).toEqual([`${QUICK_STYLE_IDS.polyhedra}.mesh`]);
    // The atom style still sits between the trunk and the viewport.
    expect(feeders(g, "viewport-1", "particle")).toEqual([`${QUICK_STYLE_IDS.atoms}.out`]);
    expect(params<PolyhedronGeneratorParams>(g, QUICK_STYLE_IDS.polyhedra)).toMatchObject({
      opacity: 0.5,
      showEdges: false,
    });
    expect(readQuickStyle(g.nodes, g.edges).style).toMatchObject({
      polyhedra: true,
      pipelinePolyhedra: null,
    });
  });

  it("edits the opacity and edges, and removes the branch when switched off", () => {
    const g1 = apply(base(), { polyhedra: true });
    const g2 = apply(g1, { polyhedronOpacity: 0.3, polyhedronEdges: true });
    expect(params<PolyhedronGeneratorParams>(g2, QUICK_STYLE_IDS.polyhedra)).toMatchObject({
      opacity: 0.3,
      showEdges: true,
    });
    expect(readQuickStyle(g2.nodes, g2.edges).style).toMatchObject({
      polyhedronOpacity: 0.3,
      polyhedronEdges: true,
    });
    // Rebuilding keeps the same branch.
    expect(edgeSet(apply(g2, {}))).toEqual(edgeSet(g2));

    const off = apply(g2, { polyhedra: false });
    expect(has(off, QUICK_STYLE_IDS.coordination)).toBe(false);
    expect(has(off, QUICK_STYLE_IDS.polyhedra)).toBe(false);
    expect(feeders(off, "viewport-1", "mesh")).toEqual([]);
    expect(edgeSet(off)).toEqual(edgeSet(base()));
    // Switched back on, it starts from the defaults again.
    expect(
      params<PolyhedronGeneratorParams>(apply(off, { polyhedra: true }), QUICK_STYLE_IDS.polyhedra)
        .opacity,
    ).toBe(0.5);
  });

  it("keeps choices made on its nodes in the Editor", () => {
    const g1 = apply(base(), { polyhedra: true });
    const edited: G = {
      ...g1,
      nodes: g1.nodes.map((n) => {
        if (n.id === QUICK_STYLE_IDS.coordination) {
          const p = n.data.params as CoordinationGeneratorParams;
          return { ...n, data: { ...n.data, params: { ...p, centerQuery: 'element == "Ti"' } } };
        }
        if (n.id === QUICK_STYLE_IDS.polyhedra) {
          const p = n.data.params as PolyhedronGeneratorParams;
          return {
            ...n,
            position: { x: 3, y: 4 },
            data: { enabled: false, params: { ...p, edgeColor: "#123456" } },
          };
        }
        return n;
      }),
    };
    const g2 = apply(edited, { atomScale: 0.5, polyhedronOpacity: 0.8 });
    expect(params<CoordinationGeneratorParams>(g2, QUICK_STYLE_IDS.coordination).centerQuery).toBe(
      'element == "Ti"',
    );
    const poly = g2.nodes.find((n) => n.id === QUICK_STYLE_IDS.polyhedra)!;
    expect(poly.data.params).toMatchObject({ edgeColor: "#123456", opacity: 0.8 });
    expect(poly.data.enabled).toBe(false);
    expect(poly.position).toEqual({ x: 3, y: 4 });
  });

  it("switches and edits the pipeline's own polyhedra in place", () => {
    const g0 = solid();
    expect(readQuickStyle(g0.nodes, g0.edges).style).toMatchObject({
      polyhedra: false,
      pipelinePolyhedra: true,
      polyhedronOpacity: 0.5,
      polyhedronEdges: false,
    });

    // Quick Style never adds a second set beside them.
    const asked = apply(g0, { polyhedra: true });
    expect(has(asked, QUICK_STYLE_IDS.polyhedra)).toBe(false);

    const edited = apply(g0, { polyhedronOpacity: 0.25, polyhedronEdges: true });
    expect(params<PolyhedronGeneratorParams>(edited, "polyhedron-1")).toMatchObject({
      opacity: 0.25,
      showEdges: true,
    });

    const off = apply(edited, { pipelinePolyhedra: false });
    const poly = off.nodes.find((n) => n.id === "polyhedron-1")!;
    expect(poly.data.enabled).toBe(false);
    // Only the polyhedron node: the coordination node still draws its bonds.
    expect(off.nodes.find((n) => n.id === "coordination-1")!.data.enabled).toBe(true);
    expect(edgeSet(off)).toEqual(edgeSet(g0));
    expect(readQuickStyle(off.nodes, off.edges).style.pipelinePolyhedra).toBe(false);

    // Reset leaves the pipeline's own node alone.
    const reset = apply(off, quickStyleDefaults());
    expect(reset.nodes.find((n) => n.id === "polyhedron-1")!.data.enabled).toBe(false);
    expect(
      apply(off, { pipelinePolyhedra: true }).nodes.find((n) => n.id === "polyhedron-1")!.data
        .enabled,
    ).toBe(true);
  });

  it("drops its own polyhedra once the pipeline draws some", () => {
    const g1 = apply(base(), { polyhedra: true });
    const withOwn: G = {
      nodes: [
        ...g1.nodes,
        {
          id: "poly-9",
          type: "polyhedron_generator",
          position: { x: 0, y: 0 },
          data: { params: defaultPolyhedron(), enabled: true },
        },
      ],
      edges: [
        ...g1.edges,
        {
          id: "ep",
          source: "poly-9",
          target: "viewport-1",
          sourceHandle: "mesh",
          targetHandle: "mesh",
        },
      ],
    };
    const out = apply(withOwn, { atomScale: 0.5 });
    expect(has(out, QUICK_STYLE_IDS.polyhedra)).toBe(false);
    expect(feeders(out, "viewport-1", "mesh")).toEqual(["poly-9.mesh"]);
  });
});

function defaultPolyhedron(): PolyhedronGeneratorParams {
  return {
    type: "polyhedron_generator",
    opacity: 0.5,
    showEdges: false,
    edgeColor: "#dddddd",
    edgeWidth: 3,
  };
}

describe("applyQuickStyle — bonds, labels and existing node params", () => {
  it("splices a bond modify into the bond stream", () => {
    const g = apply(base(), { bondScale: 2, bondOpacity: 0.5 });
    expect(feeders(g, "viewport-1", "bond")).toEqual([`${QUICK_STYLE_IDS.bonds}.out`]);
    expect(feeders(g, QUICK_STYLE_IDS.bonds, "in")).toEqual(["addbond-1.bond"]);
    const s = readQuickStyle(g.nodes, g.edges).style;
    expect(s.bondScale).toBe(2);
    expect(s.bondOpacity).toBe(0.5);
    expect(readQuickStyle(g.nodes, g.edges).available.bonds).toBe(true);
  });

  it("edits add_bond's tolerance only when bonds are inferred by distance", () => {
    const g0 = base();
    const distance = {
      ...g0,
      nodes: g0.nodes.map((n) =>
        n.id === "addbond-1"
          ? {
              ...n,
              data: {
                ...n.data,
                params: { type: "add_bond", bondSource: "distance" } as AddBondParams,
              },
            }
          : n,
      ),
    };
    expect(readQuickStyle(distance.nodes, distance.edges).style.bondTolerance).toBe(0.6);
    const g1 = apply(distance, { bondTolerance: 0.8 });
    expect(params<AddBondParams>(g1, "addbond-1").vdwScale).toBe(0.8);
    // With bond width also styled the tolerance still reaches add_bond.
    const g2 = apply(g1, { bondScale: 2, bondTolerance: 0.7 });
    expect(params<AddBondParams>(g2, "addbond-1").vdwScale).toBe(0.7);
    expect(readQuickStyle(g2.nodes, g2.edges).style.bondTolerance).toBe(0.7);

    const structure = apply(base(), { bondTolerance: 0.9 });
    expect(params<AddBondParams>(structure, "addbond-1").vdwScale).toBeUndefined();
  });

  it("adds a label generator reading the styled stream", () => {
    const g = apply(base(), { atomOpacity: 0.5, labels: "index" });
    expect(params<LabelGeneratorParams>(g, QUICK_STYLE_IDS.labels).source).toBe("index");
    expect(feeders(g, QUICK_STYLE_IDS.labels, "particle")).toEqual([
      `${QUICK_STYLE_IDS.atoms}.out`,
    ]);
    expect(feeders(g, "viewport-1", "label")).toEqual([`${QUICK_STYLE_IDS.labels}.label`]);

    const off = apply(g, { labels: "none" });
    expect(off.nodes.some((n) => n.id === QUICK_STYLE_IDS.labels)).toBe(false);
    expect(feeders(off, "viewport-1", "label")).toEqual([]);
  });

  it("does not add labels beside a label stream the user wired", () => {
    const g0 = base();
    const g: G = {
      nodes: [
        ...g0.nodes,
        {
          id: "labels-1",
          type: "label_generator",
          position: { x: 0, y: 0 },
          data: { params: { type: "label_generator", source: "element" }, enabled: true },
        },
      ],
      edges: [
        ...g0.edges,
        {
          id: "el",
          source: "labels-1",
          target: "viewport-1",
          sourceHandle: "label",
          targetHandle: "label",
        },
      ],
    };
    expect(readQuickStyle(g.nodes, g.edges).available.foreignLabels).toBe(true);
    const out = apply(g, { labels: "index" });
    expect(out.nodes.some((n) => n.id === QUICK_STYLE_IDS.labels)).toBe(false);
  });

  it("writes perspective and cell axes onto the viewport node", () => {
    const g = apply(base(), { perspective: true, cellAxesVisible: false });
    expect(params<ViewportParams>(g, "viewport-1")).toMatchObject({
      perspective: true,
      cellAxesVisible: false,
    });
  });

  it("edits a vector overlay's arrow scale", () => {
    const g0 = base();
    const g: G = {
      nodes: [
        ...g0.nodes,
        {
          id: "vec-1",
          type: "vector_overlay",
          position: { x: 0, y: 0 },
          data: { params: { type: "vector_overlay", scale: 1 }, enabled: true },
        },
      ],
      edges: [
        ...g0.edges,
        {
          id: "ev",
          source: "vec-1",
          target: "viewport-1",
          sourceHandle: "vector",
          targetHandle: "vector",
        },
      ],
    };
    expect(readQuickStyle(g.nodes, g.edges).style.vectorScale).toBe(1);
    const out = apply(g, { vectorScale: 3 });
    expect(params<VectorOverlayParams>(out, "vec-1").scale).toBe(3);
  });

  it("counts style nodes it does not own", () => {
    const g0 = base();
    const nodes = [
      ...g0.nodes,
      {
        id: "color-9",
        type: "color",
        position: { x: 0, y: 0 },
        data: { params: { type: "color", mode: "byChain", uniformColor: "#fff" }, enabled: true },
      } as Node<PipelineNodeData>,
    ];
    const styled = apply({ nodes, edges: g0.edges }, { colorMode: "byElement" });
    expect(readQuickStyle(styled.nodes, styled.edges).available.foreignStyleNodes).toBe(1);
  });
});

describe("Quick Style persistence", () => {
  it("survives serialize → deserialize without extra viewport wiring", () => {
    const styled = apply(base(), {
      colorMode: "byChain",
      representation: "licorice",
      atomScale: 0.7,
      bondScale: 1.5,
      labels: "element",
      perspective: true,
      polyhedra: true,
      polyhedronEdges: true,
    });
    const reopened = deserializePipeline(serializePipeline(styled.nodes, styled.edges));
    expect(readQuickStyle(reopened.nodes, reopened.edges).style).toEqual(
      readQuickStyle(styled.nodes, styled.edges).style,
    );
    expect(feeders(reopened, "viewport-1", "particle")).toEqual([`${QUICK_STYLE_IDS.atoms}.out`]);
    expect(feeders(reopened, "viewport-1", "bond")).toEqual([`${QUICK_STYLE_IDS.bonds}.out`]);
  });
});

describe("store.setQuickStyle", () => {
  function snapshot(): Snapshot {
    return {
      nAtoms: 2,
      nBonds: 1,
      nFileBonds: 1,
      positions: new Float32Array([0, 0, 0, 1.2, 0, 0]),
      elements: new Uint8Array([6, 6]),
      bonds: new Uint32Array([0, 1]),
      bondOrders: null,
      box: null,
      boxOrigin: null,
    } as unknown as Snapshot;
  }

  it("re-executes so the viewport state carries the styled streams", () => {
    const store = createPipelineStore();
    store.getState().setNodeSnapshot("loader-1", {
      snapshot: snapshot(),
      frames: null,
      meta: null,
      labels: null,
    });
    store.getState().setQuickStyle({ atomScale: 0.5, bondScale: 2 });
    const vs = store.getState().viewportState;
    expect(vs.particles[0].scaleOverrides?.[0]).toBe(0.5);
    expect(vs.bonds[0].scale).toBe(2);
  });

  it("draws Quick Style's polyhedra around a metal center", () => {
    // A TiO6 octahedron.
    const d = 1.95;
    const store = createPipelineStore();
    store.getState().setNodeSnapshot("loader-1", {
      snapshot: {
        nAtoms: 7,
        nBonds: 0,
        nFileBonds: 0,
        positions: new Float32Array([
          0,
          0,
          0,
          d,
          0,
          0,
          -d,
          0,
          0,
          0,
          d,
          0,
          0,
          -d,
          0,
          0,
          0,
          d,
          0,
          0,
          -d,
        ]),
        elements: new Uint8Array([22, 8, 8, 8, 8, 8, 8]),
        bonds: new Uint32Array(0),
        bondOrders: null,
        box: null,
        boxOrigin: null,
      } as unknown as Snapshot,
      frames: null,
      meta: null,
      labels: null,
    });
    expect(store.getState().viewportState.meshes).toHaveLength(0);
    store.getState().setQuickStyle({ polyhedra: true, polyhedronOpacity: 0.4 });
    const meshes = store.getState().viewportState.meshes;
    expect(meshes).toHaveLength(1);
    expect(meshes[0].opacity).toBe(0.4);
    // An octahedron: eight triangular faces.
    expect(meshes[0].indices.length).toBe(8 * 3);
  });

  it("does nothing on a graph without a viewport", () => {
    const store = createPipelineStore();
    store.setState({ nodes: [], edges: [] });
    const before = store.getState().nodes;
    store.getState().setQuickStyle({ atomScale: 0.5 });
    expect(store.getState().nodes).toBe(before);
  });
});
