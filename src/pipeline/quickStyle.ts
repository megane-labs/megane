/**
 * Quick Style — the Inspector's "change how the whole structure looks" panel.
 *
 * A handful of global controls (style, color, atom size / opacity, bond width /
 * opacity, labels, perspective, cell axes, …) that each map onto ordinary
 * pipeline state. There is no separate rendering path: every control either
 * edits a parameter of a node the graph already has (viewport, add_bond,
 * vector_overlay, polyhedron_generator) or owns one of a few `insp-global-*`
 * nodes spliced into the graph:
 *
 *   <trunk> → insp-global-color → insp-global-rep → insp-global-atoms → viewport.particle
 *         │                                                          ↘ insp-global-labels → viewport.label
 *         └→ insp-global-coord → insp-global-poly → viewport.mesh
 *   <bond source> → insp-global-bonds → viewport.bond
 *
 * The chain is spliced inline rather than branched beside the trunk: the
 * renderer draws only the first bond / label stream, and two parallel particle
 * branches styling the same atoms is what the AI self-check flags as a
 * conflict. Inspector selection layers branch from the chain's tail, so they
 * inherit the global style and override it for their own atoms. The
 * polyhedra branch reads the unstyled trunk: which atoms coordinate which does
 * not depend on how they are drawn.
 *
 * A control left at its default removes its node, so an untouched Quick Style
 * leaves the graph exactly as it was. The graph is the only state: the panel
 * reads it back with `readQuickStyle` on every render.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type {
  AddBondParams,
  ColorMode,
  ColorParams,
  LabelGeneratorParams,
  ModifyParams,
  PolyhedronGeneratorParams,
  RepresentationMode,
  RepresentationParams,
  VectorOverlayParams,
  ViewportParams,
} from "./types";
import { defaultParams } from "./types";
import { QUICK_STYLE_NODE_PREFIX, isInspectorLayerId, isQuickStyleId } from "./inspectorSync";
import { DEFAULT_VDW_BOND_FACTOR } from "../parsers/inferBondsJS";

export type QuickStyleLabels = "none" | LabelGeneratorParams["source"];

/** The values the Quick Style panel shows and edits. */
export interface QuickStyle {
  /** null = no override (whatever the pipeline draws). */
  representation: RepresentationMode | null;
  /** null = no override (the default per-element colors). */
  colorMode: ColorMode | null;
  uniformColor: string;
  atomScale: number;
  atomOpacity: number;
  bondScale: number;
  bondOpacity: number;
  /** add_bond's distance tolerance; null when bonds are not inferred by distance. */
  bondTolerance: number | null;
  labels: QuickStyleLabels;
  perspective: boolean;
  cellAxesVisible: boolean;
  /** vector_overlay arrow scale; null without a vector overlay. */
  vectorScale: number | null;
  /**
   * Quick Style's own coordination polyhedra. Never added beside polyhedra the
   * pipeline already draws; those are switched with `pipelinePolyhedra`.
   */
  polyhedra: boolean;
  /** Whether the pipeline's own polyhedron node is enabled; null without one. */
  pipelinePolyhedra: boolean | null;
  /** Face opacity of the polyhedra (Quick Style's, else the pipeline's). */
  polyhedronOpacity: number;
  /** Whether those polyhedra draw their edges. */
  polyhedronEdges: boolean;
}

/** Which controls the current graph can honor. */
export interface QuickStyleAvailability {
  /** False without a viewport (nothing Quick Style could style). */
  viewport: boolean;
  /** A bond stream feeds the viewport. */
  bonds: boolean;
  /** A non-Quick-Style label stream already feeds the viewport. */
  foreignLabels: boolean;
  /** Color / representation / modify nodes the user (or chat) authored. */
  foreignStyleNodes: number;
}

export interface QuickStyleState {
  style: QuickStyle;
  available: QuickStyleAvailability;
}

export const QUICK_STYLE_IDS = {
  color: `${QUICK_STYLE_NODE_PREFIX}color`,
  representation: `${QUICK_STYLE_NODE_PREFIX}rep`,
  atoms: `${QUICK_STYLE_NODE_PREFIX}atoms`,
  bonds: `${QUICK_STYLE_NODE_PREFIX}bonds`,
  labels: `${QUICK_STYLE_NODE_PREFIX}labels`,
  coordination: `${QUICK_STYLE_NODE_PREFIX}coord`,
  polyhedra: `${QUICK_STYLE_NODE_PREFIX}poly`,
} as const;

/** Leaf nodes: dropped with their edges rather than spliced out. */
const LEAF_NODES = new Set<string>([
  QUICK_STYLE_IDS.labels,
  QUICK_STYLE_IDS.coordination,
  QUICK_STYLE_IDS.polyhedra,
]);

/** Particle-chain nodes in trunk order. */
const PARTICLE_CHAIN = [
  QUICK_STYLE_IDS.color,
  QUICK_STYLE_IDS.representation,
  QUICK_STYLE_IDS.atoms,
];

export const DEFAULT_UNIFORM_COLOR = "#ff8800";

const POLYHEDRON_DEFAULTS = defaultParams("polyhedron_generator") as PolyhedronGeneratorParams;

type Graph = { nodes: Node<PipelineNodeData>[]; edges: Edge[] };

function findViewport(nodes: Node<PipelineNodeData>[]): Node<PipelineNodeData> | undefined {
  return nodes.find((n) => n.type === "viewport");
}

function intoPort(edges: Edge[], target: string, port: string): Edge[] {
  return edges.filter((e) => e.target === target && (e.targetHandle ?? "") === port);
}

/** The node feeding viewport.bond (skipping Quick Style's own bond modify). */
function bondSourceNode(graph: Graph, viewportId: string): Node<PipelineNodeData> | undefined {
  let edge = intoPort(graph.edges, viewportId, "bond")[0];
  if (edge && edge.source === QUICK_STYLE_IDS.bonds) {
    edge = intoPort(graph.edges, QUICK_STYLE_IDS.bonds, "in")[0];
  }
  return edge ? graph.nodes.find((n) => n.id === edge.source) : undefined;
}

function vectorOverlayNode(graph: Graph, viewportId: string): Node<PipelineNodeData> | undefined {
  const ids = new Set(intoPort(graph.edges, viewportId, "vector").map((e) => e.source));
  return graph.nodes.find((n) => n.type === "vector_overlay" && ids.has(n.id));
}

/**
 * The pipeline's own polyhedron node drawing into the viewport (the first one
 * when there are several), skipping Quick Style's.
 */
function pipelinePolyhedronNode(
  graph: Graph,
  viewportId: string,
): Node<PipelineNodeData> | undefined {
  const ids = new Set(intoPort(graph.edges, viewportId, "mesh").map((e) => e.source));
  return graph.nodes.find(
    (n) => n.type === "polyhedron_generator" && ids.has(n.id) && !isQuickStyleId(n.id),
  );
}

function paramsOf<T>(nodes: Node<PipelineNodeData>[], id: string): T | undefined {
  return nodes.find((n) => n.id === id)?.data.params as T | undefined;
}

/** Read the Quick Style values (and what the graph supports) back from a graph. */
export function readQuickStyle(nodes: Node<PipelineNodeData>[], edges: Edge[]): QuickStyleState {
  const graph = { nodes, edges };
  const viewport = findViewport(nodes);
  const vp = viewport?.data.params as ViewportParams | undefined;

  const color = paramsOf<ColorParams>(nodes, QUICK_STYLE_IDS.color);
  const rep = paramsOf<RepresentationParams>(nodes, QUICK_STYLE_IDS.representation);
  const atoms = paramsOf<ModifyParams>(nodes, QUICK_STYLE_IDS.atoms);
  const bonds = paramsOf<ModifyParams>(nodes, QUICK_STYLE_IDS.bonds);
  const labels = paramsOf<LabelGeneratorParams>(nodes, QUICK_STYLE_IDS.labels);
  const ownPolyhedra = paramsOf<PolyhedronGeneratorParams>(nodes, QUICK_STYLE_IDS.polyhedra);

  const bondSrc = viewport ? bondSourceNode(graph, viewport.id) : undefined;
  const addBond = bondSrc?.type === "add_bond" ? (bondSrc.data.params as AddBondParams) : undefined;
  const vectors = viewport ? vectorOverlayNode(graph, viewport.id) : undefined;
  const pipelinePolyhedra = viewport ? pipelinePolyhedronNode(graph, viewport.id) : undefined;
  const polyhedra =
    ownPolyhedra ??
    (pipelinePolyhedra?.data.params as PolyhedronGeneratorParams | undefined) ??
    POLYHEDRON_DEFAULTS;

  const foreignLabels = viewport
    ? intoPort(edges, viewport.id, "label").some((e) => e.source !== QUICK_STYLE_IDS.labels)
    : false;
  const foreignStyleNodes = nodes.filter(
    (n) =>
      (n.type === "color" || n.type === "representation" || n.type === "modify") &&
      !isQuickStyleId(n.id) &&
      !isInspectorLayerId(n.id),
  ).length;

  return {
    style: {
      representation: rep?.mode ?? null,
      colorMode: color?.mode ?? null,
      uniformColor: color?.uniformColor ?? DEFAULT_UNIFORM_COLOR,
      atomScale: atoms?.scale ?? 1,
      atomOpacity: atoms?.opacity ?? 1,
      bondScale: bonds?.scale ?? 1,
      bondOpacity: bonds?.opacity ?? 1,
      bondTolerance:
        addBond?.bondSource === "distance" ? (addBond.vdwScale ?? DEFAULT_VDW_BOND_FACTOR) : null,
      labels: labels?.source ?? "none",
      perspective: vp?.perspective ?? false,
      cellAxesVisible: vp?.cellAxesVisible ?? true,
      vectorScale: vectors ? (vectors.data.params as VectorOverlayParams).scale : null,
      polyhedra: !!ownPolyhedra,
      pipelinePolyhedra: pipelinePolyhedra ? pipelinePolyhedra.data.enabled : null,
      polyhedronOpacity: polyhedra.opacity,
      polyhedronEdges: polyhedra.showEdges,
    },
    available: {
      viewport: !!viewport,
      bonds: !!bondSrc,
      foreignLabels,
      foreignStyleNodes,
    },
  };
}

function edgeKey(e: Edge): string {
  return `${e.source}|${e.sourceHandle ?? ""}|${e.target}|${e.targetHandle ?? ""}`;
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

/**
 * Remove node `id`, reconnecting whatever fed its `inPort` straight to every
 * consumer of its output. A missing node is a no-op.
 */
function spliceOut(graph: Graph, id: string, inPort: string): Graph {
  if (!graph.nodes.some((n) => n.id === id)) return graph;
  const feed = intoPort(graph.edges, id, inPort)[0];
  const outs = graph.edges.filter((e) => e.source === id);
  const edges = graph.edges.filter((e) => e.source !== id && e.target !== id);
  if (feed) {
    for (const o of outs) {
      edges.push(makeEdge(feed.source, feed.sourceHandle ?? "", o.target, o.targetHandle ?? ""));
    }
  }
  return { nodes: graph.nodes.filter((n) => n.id !== id), edges: dedupeEdges(edges) };
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = edgeKey(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function qsNode(
  id: string,
  type:
    | "color"
    | "representation"
    | "modify"
    | "label_generator"
    | "coordination_generator"
    | "polyhedron_generator",
  params: PipelineNodeData["params"],
  position: { x: number; y: number },
  previous: Node<PipelineNodeData> | undefined,
): Node<PipelineNodeData> {
  // Keep where the user dragged it and whether they disabled it in the Editor.
  return {
    id,
    type,
    position: previous?.position ?? position,
    data: { params, enabled: previous?.data.enabled ?? true },
  };
}

/**
 * Apply `patch` to the graph and return the new graph. Nodes the patch does not
 * need are removed (and their neighbors reconnected); nodes it needs are
 * created or have their params replaced, keeping any position the user dragged
 * them to. Graphs without a viewport come back unchanged.
 */
export function applyQuickStyle(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  patch: Partial<QuickStyle>,
): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const viewport = findViewport(nodes);
  if (!viewport) return { nodes, edges };
  const current = readQuickStyle(nodes, edges);
  const style = { ...current.style, ...patch };
  const previous = new Map(nodes.filter((n) => isQuickStyleId(n.id)).map((n) => [n.id, n]));
  const vpPos = viewport.position;

  // 1. Take every Quick Style node out; consumers fall back to the trunk. The
  // label generator and the polyhedra branch are leaves (particle in, label /
  // mesh out), so they are dropped with their edges rather than spliced.
  let graph: Graph = {
    nodes: nodes.filter((n) => !LEAF_NODES.has(n.id)),
    edges: edges.filter((e) => !LEAF_NODES.has(e.source) && !LEAF_NODES.has(e.target)),
  };
  for (const id of [...PARTICLE_CHAIN, QUICK_STYLE_IDS.bonds]) graph = spliceOut(graph, id, "in");
  let outNodes = graph.nodes;
  let outEdges = graph.edges;

  // 2. Particle chain between the trunk and its consumers.
  const chain: Node<PipelineNodeData>[] = [];
  if (style.colorMode !== null) {
    chain.push(
      qsNode(
        QUICK_STYLE_IDS.color,
        "color",
        { type: "color", mode: style.colorMode, uniformColor: style.uniformColor } as ColorParams,
        { x: vpPos.x - 340, y: vpPos.y - 480 },
        previous.get(QUICK_STYLE_IDS.color),
      ),
    );
  }
  if (style.representation !== null) {
    chain.push(
      qsNode(
        QUICK_STYLE_IDS.representation,
        "representation",
        { type: "representation", mode: style.representation } as RepresentationParams,
        { x: vpPos.x - 340, y: vpPos.y - 320 },
        previous.get(QUICK_STYLE_IDS.representation),
      ),
    );
  }
  if (style.atomScale !== 1 || style.atomOpacity !== 1) {
    chain.push(
      qsNode(
        QUICK_STYLE_IDS.atoms,
        "modify",
        { type: "modify", scale: style.atomScale, opacity: style.atomOpacity } as ModifyParams,
        { x: vpPos.x - 340, y: vpPos.y - 160 },
        previous.get(QUICK_STYLE_IDS.atoms),
      ),
    );
  }

  const trunk = intoPort(outEdges, viewport.id, "particle").find(
    (e) => !isInspectorLayerId(e.source),
  );
  let tail: { node: string; handle: string } | null = trunk
    ? { node: trunk.source, handle: trunk.sourceHandle ?? "" }
    : null;

  if (trunk && chain.length > 0) {
    const anchor = { node: trunk.source, handle: trunk.sourceHandle ?? "" };
    // Consumers that move behind the chain: the viewport's particle input and
    // the Inspector layers branching from the trunk. Other consumers of the
    // anchor (add_bond, a surface mesh, …) keep reading the unstyled stream.
    const moves = (e: Edge) =>
      e.source === anchor.node &&
      (e.sourceHandle ?? "") === anchor.handle &&
      ((e.target === viewport.id && (e.targetHandle ?? "") === "particle") ||
        isInspectorLayerId(e.target));
    const last = chain[chain.length - 1].id;
    outEdges = outEdges.map((e) =>
      moves(e) ? makeEdge(last, "out", e.target, e.targetHandle ?? "") : e,
    );
    outEdges.push(makeEdge(anchor.node, anchor.handle, chain[0].id, "in"));
    for (let i = 0; i < chain.length - 1; i++) {
      outEdges.push(makeEdge(chain[i].id, "out", chain[i + 1].id, "in"));
    }
    outNodes = [...outNodes, ...chain];
    tail = { node: last, handle: "out" };
  }

  // 3. Labels read the styled stream so a hidden atom's label hides with it.
  if (style.labels !== "none" && tail && !current.available.foreignLabels) {
    outNodes = [
      ...outNodes,
      qsNode(
        QUICK_STYLE_IDS.labels,
        "label_generator",
        { type: "label_generator", source: style.labels } as LabelGeneratorParams,
        { x: vpPos.x + 340, y: vpPos.y - 160 },
        previous.get(QUICK_STYLE_IDS.labels),
      ),
    ];
    outEdges.push(makeEdge(tail.node, tail.handle, QUICK_STYLE_IDS.labels, "particle"));
    outEdges.push(makeEdge(QUICK_STYLE_IDS.labels, "label", viewport.id, "label"));
  }

  // 4. Polyhedra from the unstyled trunk, unless the pipeline draws its own.
  if (style.polyhedra && trunk && current.style.pipelinePolyhedra === null) {
    const coordination = previous.get(QUICK_STYLE_IDS.coordination);
    const polyhedra = previous.get(QUICK_STYLE_IDS.polyhedra);
    outNodes = [
      ...outNodes,
      // Keep a center / neighbor choice the user made in the Editor.
      qsNode(
        QUICK_STYLE_IDS.coordination,
        "coordination_generator",
        coordination?.data.params ?? defaultParams("coordination_generator"),
        { x: vpPos.x - 680, y: vpPos.y - 320 },
        coordination,
      ),
      qsNode(
        QUICK_STYLE_IDS.polyhedra,
        "polyhedron_generator",
        {
          ...((polyhedra?.data.params as PolyhedronGeneratorParams | undefined) ??
            POLYHEDRON_DEFAULTS),
          opacity: style.polyhedronOpacity,
          showEdges: style.polyhedronEdges,
        },
        { x: vpPos.x - 680, y: vpPos.y - 160 },
        polyhedra,
      ),
    ];
    outEdges.push(
      makeEdge(trunk.source, trunk.sourceHandle ?? "", QUICK_STYLE_IDS.coordination, "particle"),
    );
    outEdges.push(
      makeEdge(
        QUICK_STYLE_IDS.coordination,
        "coordination",
        QUICK_STYLE_IDS.polyhedra,
        "coordination",
      ),
    );
    outEdges.push(makeEdge(QUICK_STYLE_IDS.polyhedra, "mesh", viewport.id, "mesh"));
  }

  // 5. Bond modify between the bond source and viewport.bond.
  const bondEdge = intoPort(outEdges, viewport.id, "bond")[0];
  if (bondEdge && (style.bondScale !== 1 || style.bondOpacity !== 1)) {
    outNodes = [
      ...outNodes,
      qsNode(
        QUICK_STYLE_IDS.bonds,
        "modify",
        { type: "modify", scale: style.bondScale, opacity: style.bondOpacity } as ModifyParams,
        { x: vpPos.x + 340, y: vpPos.y - 320 },
        previous.get(QUICK_STYLE_IDS.bonds),
      ),
    ];
    outEdges = outEdges.filter((e) => e !== bondEdge);
    outEdges.push(
      makeEdge(bondEdge.source, bondEdge.sourceHandle ?? "", QUICK_STYLE_IDS.bonds, "in"),
    );
    outEdges.push(makeEdge(QUICK_STYLE_IDS.bonds, "out", viewport.id, "bond"));
  }

  // 6. Parameters that live on nodes the graph already has.
  const bondSrc = bondSourceNode({ nodes: outNodes, edges: outEdges }, viewport.id);
  const vectors = vectorOverlayNode({ nodes: outNodes, edges: outEdges }, viewport.id);
  const pipelinePolyhedra = pipelinePolyhedronNode(
    { nodes: outNodes, edges: outEdges },
    viewport.id,
  );
  outNodes = outNodes.map((n) => {
    if (n.id === viewport.id) {
      const p = n.data.params as ViewportParams;
      if (p.perspective === style.perspective && p.cellAxesVisible === style.cellAxesVisible) {
        return n;
      }
      return {
        ...n,
        data: {
          ...n.data,
          params: { ...p, perspective: style.perspective, cellAxesVisible: style.cellAxesVisible },
        },
      };
    }
    if (bondSrc && n.id === bondSrc.id && n.type === "add_bond" && style.bondTolerance !== null) {
      const p = n.data.params as AddBondParams;
      if (p.bondSource !== "distance" || p.vdwScale === style.bondTolerance) return n;
      return { ...n, data: { ...n.data, params: { ...p, vdwScale: style.bondTolerance } } };
    }
    if (vectors && n.id === vectors.id && style.vectorScale !== null) {
      const p = n.data.params as VectorOverlayParams;
      if (p.scale === style.vectorScale) return n;
      return { ...n, data: { ...n.data, params: { ...p, scale: style.vectorScale } } };
    }
    if (pipelinePolyhedra && n.id === pipelinePolyhedra.id && style.pipelinePolyhedra !== null) {
      const p = n.data.params as PolyhedronGeneratorParams;
      if (
        n.data.enabled === style.pipelinePolyhedra &&
        p.opacity === style.polyhedronOpacity &&
        p.showEdges === style.polyhedronEdges
      ) {
        return n;
      }
      // Off disables just this node, as the Editor's toggle does: the
      // coordination node feeding it, and any bonds that draws, stay.
      return {
        ...n,
        data: {
          ...n.data,
          enabled: style.pipelinePolyhedra,
          params: { ...p, opacity: style.polyhedronOpacity, showEdges: style.polyhedronEdges },
        },
      };
    }
    return n;
  });

  return { nodes: outNodes, edges: dedupeEdges(outEdges) };
}

/** The values a Reset restores (graph-owned parameters keep their own defaults). */
export function quickStyleDefaults(): Partial<QuickStyle> {
  return {
    representation: null,
    colorMode: null,
    uniformColor: DEFAULT_UNIFORM_COLOR,
    atomScale: 1,
    atomOpacity: 1,
    bondScale: 1,
    bondOpacity: 1,
    labels: "none",
    polyhedra: false,
  };
}
