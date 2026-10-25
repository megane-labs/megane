/**
 * Applying an AI-generated pipeline on top of a graph that already has data
 * loaded into it.
 *
 * The model edits the *graph*; it cannot load files. A generated pipeline
 * therefore arrives with `fileName: null` loaders and none of the ephemeral
 * data (parsed snapshots, volumetric grids, spectra, topology bonds) the
 * serialized form drops. `mergeGeneratedGraph` carries all of that over from
 * the graph being replaced, so asking the assistant for a change restyles the
 * structure on screen instead of unloading it:
 *
 *  - a node the model kept (same id, same type) keeps its file-bound params
 *    and its per-node snapshot / parse error / streaming entry;
 *  - when the model rebuilt the graph from scratch (new loader ids), the
 *    structure of the old primary loader is re-attached to the first new
 *    `load_structure` node that has no data of its own.
 *
 * The store-wide execution context (`snapshot`, trajectory frames and
 * providers, …) is not touched at all — it belongs to the files, not to the
 * graph — which is what keeps a loaded trajectory playing across chat edits.
 */

import type { Node, Edge } from "@xyflow/react";
import type { NodeSnapshotData, PipelineNodeData } from "./execute";
import type { SerializedPipeline } from "./types";
import type { NodeStreamingData } from "./executors/streaming";

/**
 * Params that describe the file a node was fed rather than how it is drawn.
 * The model never sees their real values (ephemeral ones are not serialized)
 * and has no way to load a file, so the loaded values always win.
 */
export const FILE_BOUND_PARAM_KEYS = [
  "fileName",
  "fileUrl",
  "hasTrajectory",
  "hasCell",
  "edits",
  "bondFileName",
  "bondFileData",
  "volumetricData",
  "spectrumData",
  "parseError",
] as const;

/** The per-node data maps, keyed by node id, that follow a node across an apply. */
export interface GraphData {
  nodeSnapshots: Record<string, NodeSnapshotData>;
  nodeParseErrors: Record<string, string>;
  nodeStreamingData: Record<string, NodeStreamingData>;
}

/** Everything `undoGeneratedPipeline` needs to put the previous graph back. */
export interface GraphCheckpoint extends GraphData {
  /** Monotonic id, so the chat can tell which apply a checkpoint undoes. */
  id: number;
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
}

function fileBoundParams(node: Node<PipelineNodeData>): Record<string, unknown> {
  const params = node.data.params as unknown as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of FILE_BOUND_PARAM_KEYS) {
    if (params[key] !== undefined) kept[key] = params[key];
  }
  return kept;
}

function withParams(
  node: Node<PipelineNodeData>,
  extra: Record<string, unknown>,
): Node<PipelineNodeData> {
  if (Object.keys(extra).length === 0) return node;
  return {
    ...node,
    data: { ...node.data, params: { ...node.data.params, ...extra } as typeof node.data.params },
  };
}

function pick<T>(map: Record<string, T>, ids: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(map)) {
    if (ids.has(id)) out[id] = value;
  }
  return out;
}

/**
 * Merge the data of `prev` into the freshly generated `nextNodes`. Returns the
 * nodes to install and the per-node maps that go with them; neither input is
 * mutated.
 */
export function mergeGeneratedGraph(
  prev: GraphData & { nodes: Node<PipelineNodeData>[] },
  nextNodes: Node<PipelineNodeData>[],
): GraphData & { nodes: Node<PipelineNodeData>[] } {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]));
  const kept = new Set<string>();

  let nodes = nextNodes.map((node) => {
    const old = prevById.get(node.id);
    if (!old || old.type !== node.type) return node;
    kept.add(node.id);
    const merged = withParams(node, fileBoundParams(old));
    return old.selected ? { ...merged, selected: true } : merged;
  });

  const nodeSnapshots = pick(prev.nodeSnapshots, kept);
  const nodeParseErrors = pick(prev.nodeParseErrors, kept);
  const nodeStreamingData = pick(prev.nodeStreamingData, kept);

  // A from-scratch graph: hand the old primary structure to the first new
  // loader that has nothing loaded, so it does not vanish from the viewport.
  const oldLoader = prev.nodes.find((n) => n.type === "load_structure");
  const oldSnapshot = oldLoader ? prev.nodeSnapshots[oldLoader.id] : undefined;
  if (oldLoader && oldSnapshot && !kept.has(oldLoader.id)) {
    const target = nodes.find((n) => n.type === "load_structure" && !kept.has(n.id));
    if (target) {
      nodeSnapshots[target.id] = oldSnapshot;
      const carried = fileBoundParams(oldLoader);
      nodes = nodes.map((n) => (n.id === target.id ? withParams(n, carried) : n));
    }
  }

  return { nodes, nodeSnapshots, nodeParseErrors, nodeStreamingData };
}

/**
 * `json` with the file-bound params of `merged` (the result of
 * {@link mergeGeneratedGraph} on its deserialized nodes) written onto the
 * serialized node of the same id.
 *
 * The deserializer derives edges from those params: a loader that holds a
 * trajectory (`hasTrajectory`) gets its `trajectory → viewport` edge. The model
 * writes its loaders as the prompt's examples do, with no file and no
 * trajectory, so deserializing its JSON as-is wires the graph for data that is
 * not there; deserializing this instead wires it for the data that stays
 * loaded.
 */
export function withFileBoundParams(
  json: SerializedPipeline,
  merged: Node<PipelineNodeData>[],
): SerializedPipeline {
  const byId = new Map(merged.map((n) => [n.id, n]));
  return {
    ...json,
    nodes: json.nodes.map((node) => {
      const m = byId.get(node.id);
      return m ? ({ ...node, ...fileBoundParams(m) } as typeof node) : node;
    }),
  };
}
