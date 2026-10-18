/**
 * Selection Inspector → pipeline authoring.
 *
 * The Inspector is a lightweight third editing surface (alongside the visual
 * pipeline editor and the AI chat) for "select a subset, change how it looks".
 * Rather than maintaining a parallel rendering path, every Inspector *layer*
 * compiles down to ordinary pipeline nodes — a `filter` (the selection) chained
 * into optional `color` / `representation` / `modify` nodes, terminating at the
 * viewport. Because the pipeline store is the single source of truth, the nodes
 * an Inspector layer produces show up verbatim in the visual editor: editing in
 * the Inspector *is* editing the pipeline.
 *
 * Inspector-owned nodes are identified by their id alone,
 * `insp-<layerId>-<role>`. The id is deterministic (re-runs don't remount the
 * React Flow node, so positions stay put) and, unlike anything in `data`, it is
 * kept by `serializePipeline` — so a saved and re-opened pipeline still knows
 * which nodes the Inspector owns, and `layersFromGraph` can rebuild the layers.
 *
 * The `insp-global-*` ids belong to the Quick Style chain (`quickStyle.ts`),
 * not to a layer: layer reconciliation leaves them alone.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type {
  ColorMode,
  RepresentationMode,
  FilterParams,
  ColorParams,
  RepresentationParams,
  ModifyParams,
} from "./types";

/** Prefix shared by every node/edge the Inspector owns. */
export const INSPECTOR_NODE_PREFIX = "insp-";

/** Prefix of the Quick Style nodes (see `quickStyle.ts`). */
export const QUICK_STYLE_NODE_PREFIX = `${INSPECTOR_NODE_PREFIX}global-`;

/** Visual settings a single Inspector layer applies to its selection. */
export interface InspectorAppearance {
  /** Emit a `color` node when true. */
  colorEnabled: boolean;
  colorMode: ColorMode;
  /** Hex color used when `colorMode === "uniform"`. */
  uniformColor: string;
  /** Emit a `representation` node when true. */
  representationEnabled: boolean;
  representation: RepresentationMode;
  /** Atom scale factor (1 = unchanged). */
  scale: number;
  /** Opacity 0–1 (1 = fully opaque); ignored when `visible` is false. */
  opacity: number;
  /** When false the layer's atoms are driven to opacity 0 (hidden). */
  visible: boolean;
}

/** One selection + appearance rule authored in the Inspector. */
export interface InspectorLayer {
  /** Stable id; drives the deterministic node ids for this layer. */
  id: string;
  name: string;
  /** Atom selection expression (Filter node `query`). */
  query: string;
  appearance: InspectorAppearance;
}

/** Sensible starting appearance for a freshly created layer. */
export function defaultInspectorAppearance(): InspectorAppearance {
  return {
    colorEnabled: true,
    colorMode: "uniform",
    uniformColor: "#ff8800",
    representationEnabled: false,
    representation: "atoms",
    scale: 1.0,
    opacity: 1.0,
    visible: true,
  };
}

/** True when a modify node is needed to realize this layer's appearance. */
function needsModify(a: InspectorAppearance): boolean {
  return a.scale !== 1.0 || a.opacity !== 1.0 || !a.visible;
}

/** The particle source an Inspector layer branches from. */
export interface InspectorSource {
  nodeId: string;
  handle: string;
}

type Role = "filter" | "color" | "representation" | "modify";

/** `insp-<layerId>-<role>`; the layer id may itself contain hyphens. */
const LAYER_NODE_ID = /^insp-(.+)-(filter|color|representation|modify)$/;

function nodeId(layerId: string, role: Role): string {
  return `${INSPECTOR_NODE_PREFIX}${layerId}-${role}`;
}

/** True when a node/edge id belongs to the Inspector (a layer or Quick Style). */
export function isInspectorId(id: string): boolean {
  return id.startsWith(INSPECTOR_NODE_PREFIX);
}

/** True when a node id belongs to the Quick Style chain. */
export function isQuickStyleId(id: string): boolean {
  return id.startsWith(QUICK_STYLE_NODE_PREFIX);
}

/** True when a node id belongs to an Inspector selection layer. */
export function isInspectorLayerId(id: string): boolean {
  return isInspectorId(id) && !isQuickStyleId(id);
}

/** Display name for a layer id: `layer-3` → "Layer 3", anything else verbatim. */
export function layerDisplayName(layerId: string): string {
  const m = layerId.match(/^layer-(\d+)$/);
  return m ? `Layer ${m[1]}` : layerId;
}

function makeNode(
  id: string,
  type: Role,
  position: { x: number; y: number },
  params: PipelineNodeData["params"],
): Node<PipelineNodeData> {
  return {
    id,
    type,
    position,
    data: { params, enabled: true },
  };
}

/**
 * Build the nodes and edges realizing a single layer, branching from `source`
 * and terminating at the viewport's `particle` input.
 */
function buildLayer(
  layer: InspectorLayer,
  layerIndex: number,
  source: InspectorSource,
  viewportId: string,
): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  const a = layer.appearance;
  const nodes: Node<PipelineNodeData>[] = [];
  const edges: Edge[] = [];

  // Lay each layer out in its own column to the right of the main graph so the
  // generated nodes are visible (and non-overlapping) in the editor.
  const colX = 900 + layerIndex * 280;
  let rowY = 40;
  const rowStep = 150;

  const roles: Role[] = ["filter"];
  if (a.colorEnabled) roles.push("color");
  if (a.representationEnabled) roles.push("representation");
  if (needsModify(a)) roles.push("modify");

  const paramsFor = (role: Role): PipelineNodeData["params"] => {
    switch (role) {
      case "filter":
        return { type: "filter", query: layer.query, bond_query: "" } as FilterParams;
      case "color":
        return {
          type: "color",
          mode: a.colorMode,
          uniformColor: a.uniformColor,
        } as ColorParams;
      case "representation":
        return { type: "representation", mode: a.representation } as RepresentationParams;
      case "modify":
        return {
          type: "modify",
          scale: a.scale,
          opacity: a.visible ? a.opacity : 0,
        } as ModifyParams;
    }
  };

  // Create the chain nodes.
  const ids = roles.map((role) => nodeId(layer.id, role));
  roles.forEach((role, i) => {
    nodes.push(makeNode(ids[i], role, { x: colX, y: rowY }, paramsFor(role)));
    rowY += rowStep;
  });

  // Wire: source.particle → first.in, then out→in along the chain,
  // finally last.out → viewport.particle.
  edges.push({
    id: `e-${INSPECTOR_NODE_PREFIX}${layer.id}-src`,
    source: source.nodeId,
    target: ids[0],
    sourceHandle: source.handle,
    targetHandle: "in",
  });
  for (let i = 0; i < ids.length - 1; i++) {
    edges.push({
      id: `e-${INSPECTOR_NODE_PREFIX}${layer.id}-${roles[i]}-${roles[i + 1]}`,
      source: ids[i],
      target: ids[i + 1],
      sourceHandle: "out",
      targetHandle: "in",
    });
  }
  edges.push({
    id: `e-${INSPECTOR_NODE_PREFIX}${layer.id}-vp`,
    source: ids[ids.length - 1],
    target: viewportId,
    sourceHandle: "out",
    targetHandle: "particle",
  });

  return { nodes, edges };
}

/**
 * Rebuild the Inspector layers' portion of the graph from `layers`, leaving
 * every other node and edge (Quick Style's included) untouched. Idempotent: running it again with the same
 * layers produces the same node ids and positions.
 *
 * `source` is the particle stream the layers branch from (typically whatever
 * node currently feeds `viewport.particle`, so replicate/supercell effects are
 * preserved). `viewportId` is where each layer terminates.
 */
export function reconcileInspectorLayers(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  layers: InspectorLayer[],
  source: InspectorSource,
  viewportId: string,
): { nodes: Node<PipelineNodeData>[]; edges: Edge[] } {
  // Drop the previous layer nodes and any edge touching them.
  const keptNodes = nodes.filter((n) => !isInspectorLayerId(n.id));
  const keptEdges = edges.filter(
    (e) => !isInspectorLayerId(e.source) && !isInspectorLayerId(e.target),
  );

  const newNodes: Node<PipelineNodeData>[] = [];
  const newEdges: Edge[] = [];
  layers.forEach((layer, i) => {
    const built = buildLayer(layer, i, source, viewportId);
    newNodes.push(...built.nodes);
    newEdges.push(...built.edges);
  });

  return {
    nodes: [...keptNodes, ...newNodes],
    edges: [...keptEdges, ...newEdges],
  };
}

/**
 * Reconstruct Inspector layer models from a graph by parsing the
 * `insp-<layerId>-<role>` node ids. Works on a live graph and on one just
 * re-opened from a saved `.megane.json`. Layers are returned in ascending
 * layer-id order (numeric-aware, so `layer-10` follows `layer-9`).
 */
export function layersFromGraph(nodes: Node<PipelineNodeData>[]): InspectorLayer[] {
  const byLayer = new Map<string, Node<PipelineNodeData>[]>();
  for (const n of nodes) {
    if (!isInspectorLayerId(n.id)) continue;
    const m = n.id.match(LAYER_NODE_ID);
    if (!m || n.type !== m[2]) continue;
    const layerId = m[1];
    const group = byLayer.get(layerId);
    if (group) group.push(n);
    else byLayer.set(layerId, [n]);
  }

  const layers: InspectorLayer[] = [];
  for (const [layerId, group] of byLayer) {
    const find = (role: Role) => group.find((n) => n.id === nodeId(layerId, role));
    const filter = find("filter");
    if (!filter) continue; // a layer without a filter is malformed; skip it
    const appearance = defaultInspectorAppearance();

    const colorNode = find("color");
    if (colorNode) {
      const p = colorNode.data.params as ColorParams;
      appearance.colorEnabled = true;
      appearance.colorMode = p.mode;
      appearance.uniformColor = p.uniformColor;
    } else {
      appearance.colorEnabled = false;
    }

    const repNode = find("representation");
    if (repNode) {
      const p = repNode.data.params as RepresentationParams;
      appearance.representationEnabled = true;
      appearance.representation = p.mode;
    } else {
      appearance.representationEnabled = false;
    }

    const modifyNode = find("modify");
    if (modifyNode) {
      const p = modifyNode.data.params as ModifyParams;
      appearance.scale = p.scale;
      if (p.opacity === 0) {
        appearance.visible = false;
        appearance.opacity = 1.0;
      } else {
        appearance.visible = true;
        appearance.opacity = p.opacity;
      }
    }

    layers.push({
      id: layerId,
      name: layerDisplayName(layerId),
      query: (filter.data.params as FilterParams).query,
      appearance,
    });
  }

  layers.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return layers;
}
