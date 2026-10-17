/**
 * Auto-layout utility for pipeline DAG using dagre (Sugiyama algorithm).
 * Computes layered node positions optimized for top-to-bottom data flow.
 *
 * Node sizes come from xyflow's measured dimensions when the node has been
 * rendered, and from a per-state estimate otherwise (a template or a chat
 * pipeline is laid out before React has drawn it). The editor re-runs the
 * layout once every node is measured — see `layoutPending` in the store — so
 * the estimate only has to be close enough for the first frame.
 *
 * dagre's coordinates are kept as-is: each node sits under its parents, so
 * the edges run straight down instead of zig-zagging across re-centred rows.
 * Within a rank, nodes are top-aligned so their input handles line up.
 */

import type { Node, Edge } from "@xyflow/react";
import Dagre from "@dagrejs/dagre";

/** Fallback width for a node that has not been measured yet. */
export const ESTIMATED_NODE_WIDTH = 340;
/** Fallback height for an expanded node that has not been measured yet. */
export const ESTIMATED_NODE_HEIGHT = 160;
/** Fallback height for a collapsed (compact) node that has not been measured yet. */
export const ESTIMATED_COLLAPSED_NODE_HEIGHT = 80;
/** Horizontal gap between nodes in the same rank. */
const NODE_SEP = 40;
/**
 * Vertical gap between ranks. Port labels hang 22px above inputs and below
 * outputs, so the gap must clear both plus room for the edge to bend.
 */
const RANK_SEP = 70;

function isCollapsed(node: Node): boolean {
  return (node.data as { collapsed?: unknown } | undefined)?.collapsed === true;
}

/** Best known size of a node: measured, then explicit, then estimated. */
export function nodeSize(node: Node): { width: number; height: number } {
  const width = node.measured?.width ?? node.width ?? ESTIMATED_NODE_WIDTH;
  const height =
    node.measured?.height ??
    node.height ??
    (isCollapsed(node) ? ESTIMATED_COLLAPSED_NODE_HEIGHT : ESTIMATED_NODE_HEIGHT);
  return { width, height };
}

/** True once xyflow has measured every node, so a layout uses real sizes. */
export function allNodesMeasured(nodes: Node[]): boolean {
  return nodes.every((n) => n.measured?.width !== undefined && n.measured?.height !== undefined);
}

export function getLayoutedElements<T extends Node>(
  nodes: T[],
  edges: Edge[],
): { nodes: T[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes, edges };

  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: NODE_SEP, ranksep: RANK_SEP });

  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of nodes) {
    const size = nodeSize(node);
    sizes.set(node.id, size);
    g.setNode(node.id, size);
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    // An edge to a node that is not in the graph would make dagre invent a
    // zero-sized placeholder node and skew the ranks.
    if (ids.has(edge.source) && ids.has(edge.target)) g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  // dagre centres every node vertically on its rank; top-align the rank
  // instead so nodes of different heights keep their input handles level.
  const rankTop = new Map<number, number>();
  for (const node of nodes) {
    const { y } = g.node(node.id);
    const { height } = sizes.get(node.id)!;
    const key = Math.round(y);
    rankTop.set(key, Math.min(rankTop.get(key) ?? Infinity, y - height / 2));
  }

  const layoutedNodes: T[] = nodes.map((node) => {
    const { x, y } = g.node(node.id);
    const { width } = sizes.get(node.id)!;
    return {
      ...node,
      position: { x: x - width / 2, y: rankTop.get(Math.round(y))! },
    };
  });

  return { nodes: layoutedNodes, edges };
}
