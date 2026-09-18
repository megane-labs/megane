/**
 * Build panel → pipeline authoring.
 *
 * Like the Selection Inspector (`inspectorSync.ts`), the Build panel does not
 * own a parallel data path: every click in it becomes one `EditOp` appended
 * to a single `edit` node that sits directly downstream of the primary
 * `load_structure` node. This module owns that node's placement.
 *
 * Why directly after the loader: an op refers to input atoms by index, and
 * only the loader's output has the indices the file assigns. Nodes that
 * change the atom count (`replicate`, `symmetry`) come after the edit so the
 * refs keep their meaning; nodes that only decorate (`filter`, `color`, …)
 * pass through the edited stream unchanged.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type { EditParams } from "./types";

/** Deterministic id of the Build panel's edit node (one per pipeline). */
export const BUILD_EDIT_NODE_ID = "edit-main";

/** The edit node the Build panel writes to, if the graph has one. */
export function findBuildEditNode(nodes: Node<PipelineNodeData>[]): Node<PipelineNodeData> | null {
  return (
    nodes.find((n) => n.id === BUILD_EDIT_NODE_ID) ?? nodes.find((n) => n.type === "edit") ?? null
  );
}

/** The loader whose structure the Build panel edits: the first `load_structure`. */
export function findPrimaryLoader(nodes: Node<PipelineNodeData>[]): Node<PipelineNodeData> | null {
  return nodes.find((n) => n.type === "load_structure") ?? null;
}

/**
 * Return a graph that has an edit node wired directly after `loaderId`. When
 * one already exists the graph is returned as-is; otherwise a new node is
 * spliced in: every `particle` / `cell` edge leaving the loader (except the
 * one feeding a `load_trajectory`, which only needs the atom count of the
 * file as loaded) is re-sourced from the edit node, and the loader is wired
 * into the edit node's inputs.
 */
export function ensureBuildEditNode(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  loaderId: string,
  sourceAtomCount: number | null,
): { nodes: Node<PipelineNodeData>[]; edges: Edge[]; editId: string } {
  const existing = findBuildEditNode(nodes);
  if (existing) return { nodes, edges, editId: existing.id };

  const loader = nodes.find((n) => n.id === loaderId);
  const editId = BUILD_EDIT_NODE_ID;
  const params: EditParams = { type: "edit", ops: [], sourceAtomCount };
  const editNode: Node<PipelineNodeData> = {
    id: editId,
    type: "edit",
    position: {
      x: (loader?.position.x ?? 0) + 360,
      y: loader?.position.y ?? 0,
    },
    data: { params, enabled: true },
  };

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const rewired: Edge[] = edges.map((e) => {
    if (e.source !== loaderId) return e;
    const handle = e.sourceHandle ?? "particle";
    if (handle !== "particle" && handle !== "cell") return e;
    if (nodeById.get(e.target)?.type === "load_trajectory") return e;
    return {
      ...e,
      id: `e-${editId}-${handle}-${e.target}-${e.targetHandle ?? handle}`,
      source: editId,
    };
  });
  rewired.push(
    {
      id: `e-${loaderId}-particle-${editId}-particle`,
      source: loaderId,
      target: editId,
      sourceHandle: "particle",
      targetHandle: "particle",
    },
    {
      id: `e-${loaderId}-cell-${editId}-cell`,
      source: loaderId,
      target: editId,
      sourceHandle: "cell",
      targetHandle: "cell",
    },
  );

  return { nodes: [...nodes, editNode], edges: rewired, editId };
}
