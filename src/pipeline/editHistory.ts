/**
 * Build panel → structure edit history.
 *
 * Edits live on the primary `load_structure` node (`LoadStructureParams.edits`),
 * not in a pipeline node of their own: they change what the molecule *is*,
 * while the graph describes how it is *shown*. The loader replays the list on
 * the file as loaded (see `executors/loadStructure.ts`), so the rest of the
 * pipeline only ever sees the edited structure. The history rides in the
 * `.megane.json` with the loader and is cleared when a different file is
 * loaded into it.
 */

import type { Node } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type { EditOp, LoadStructureParams } from "./types";

/** The loader whose structure the Build panel edits: the first `load_structure`. */
export function findPrimaryLoader(nodes: Node<PipelineNodeData>[]): Node<PipelineNodeData> | null {
  return nodes.find((n) => n.type === "load_structure") ?? null;
}

/** The edit list of a loader node (empty when absent or malformed). */
export function loaderEdits(node: Node<PipelineNodeData> | null | undefined): EditOp[] {
  const edits = (node?.data.params as LoadStructureParams | undefined)?.edits;
  return Array.isArray(edits) ? edits : [];
}
