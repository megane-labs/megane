/**
 * Helpers for inspecting upstream pipeline state from a node's perspective.
 *
 * Pipeline node UI components sometimes need to know what data is flowing in
 * (e.g. which atomic numbers are present in the input structure) so they can
 * render structure-aware controls. The single source of truth for "what
 * elements exist" is the `load_structure` node's snapshot stored in
 * `state.nodeSnapshots`. This module walks the graph backwards from a target
 * node, transparently traversing filter / modify / color / representation /
 * drawing-boundary nodes that don't change the underlying element list, and returns
 * the upstream load_structure (or its element set).
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type { NodeSnapshotData } from "./execute";

/**
 * Node types that pass the upstream particle stream through unchanged in element
 * identity. The crystal nodes copy, move or symmetry-expand atoms but never
 * change which elements exist; the Solid template runs loader → symmetry → wrap
 * → drawing boundary → coordination.
 */
const TRANSPARENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "filter",
  "modify",
  "color",
  "representation",
  "drawing_boundary",
  "boundary_completion",
  "add_bond",
  "label_generator",
  "symmetry",
  "wrap",
  "replicate",
]);

/**
 * Walk backwards through `edges` starting at `targetNodeId` and return the id
 * of the first `load_structure` ancestor reached via particle-bearing edges.
 * Returns null if no such ancestor exists (e.g. node is not yet connected).
 */
export function findUpstreamLoadStructureId(
  targetNodeId: string,
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
): string | null {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([targetNodeId]);
  const stack: string[] = [targetNodeId];

  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.target !== id) continue;
      const src = nodeById.get(e.source);
      if (!src) continue;
      if (src.type === "load_structure") return src.id;
      if (!TRANSPARENT_NODE_TYPES.has(src.type ?? "")) continue;
      if (!visited.has(src.id)) {
        visited.add(src.id);
        stack.push(src.id);
      }
    }
  }

  return null;
}

/**
 * Return the set of atomic numbers present in the structure flowing into
 * `targetNodeId`. Returns null when the upstream load_structure cannot be
 * located, or when its snapshot has not yet been recorded.
 */
export function getElementsPresentInUpstream(
  targetNodeId: string,
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  nodeSnapshots: Record<string, NodeSnapshotData>,
): Set<number> | null {
  const loaderId = findUpstreamLoadStructureId(targetNodeId, nodes, edges);
  if (!loaderId) return null;
  const snap = nodeSnapshots[loaderId];
  if (!snap) return null;
  const out = new Set<number>();
  const elements = snap.snapshot.elements;
  for (let i = 0; i < elements.length; i++) out.add(elements[i]);
  return out;
}
