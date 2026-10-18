/**
 * Pipeline execution engine.
 * Propagates typed data packets through the node graph.
 * ViewportNode collects all inputs and produces a ViewportState.
 */

import type { Node, Edge } from "@xyflow/react";
import type { Snapshot } from "../types";
import type {
  PipelineNodeParams,
  PipelineData,
  ViewportState,
  PipelineNodeType,
  NodeError,
  FrameProvider,
} from "./types";
import type { Frame, TrajectoryMeta, VectorFrame } from "../types";
import type { NodeStreamingData } from "./executors/streaming";
import { DEFAULT_VIEWPORT_STATE, NODE_PORTS } from "./types";
import { topologicalSort, collectInputs, type EdgeOutputs } from "./graph";
import { getNodeExecutor } from "./executors/registry";

export interface PipelineNodeData {
  params: PipelineNodeParams;
  enabled: boolean;
  [key: string]: unknown;
}

// ─── Main Execution ───────────────────────────────────────────────────

/**
 * Execute the pipeline and produce a ViewportState.
 * Returns DEFAULT_VIEWPORT_STATE if no viewport node exists.
 */
/** Per-node snapshot data stored for each load_structure node. */
export interface NodeSnapshotData {
  snapshot: Snapshot;
  frames: Frame[] | null;
  meta: TrajectoryMeta | null;
  labels: string[] | null;
}

export interface PipelineExecutionContext {
  snapshot?: Snapshot | null;
  atomLabels?: string[] | null;
  structureFrames?: Frame[] | null;
  structureMeta?: TrajectoryMeta | null;
  /** Pre-built lazy/streaming provider for a multi-frame structure file (takes precedence over structureFrames). */
  structureProvider?: FrameProvider | null;
  fileFrames?: Frame[] | null;
  fileMeta?: TrajectoryMeta | null;
  /** Pre-built lazy/streaming provider for the file trajectory (takes precedence over fileFrames). */
  fileProvider?: FrameProvider | null;
  fileVectors?: VectorFrame[] | null;
  /** Per-node snapshots keyed by load_structure node ID. */
  nodeSnapshots?: Record<string, NodeSnapshotData>;
  /** Per-node streaming data keyed by streaming node ID. */
  nodeStreamingData?: Record<string, NodeStreamingData>;
  /**
   * Show every `load_structure` node's file as loaded, ignoring its edit
   * list (a "show original" preview). Not persisted.
   */
  editsBypassed?: boolean;
}

export interface PipelineExecutionResult {
  viewportState: ViewportState;
  nodeErrors: Map<string, NodeError[]>;
}

export function executePipeline(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
  ctx: PipelineExecutionContext = {},
): PipelineExecutionResult {
  const sortedIds = topologicalSort(nodes, edges);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgeOutputs: EdgeOutputs = new Map();
  const nodeErrors = new Map<string, NodeError[]>();

  const addError = (nodeId: string, error: NodeError) => {
    if (!nodeErrors.has(nodeId)) nodeErrors.set(nodeId, []);
    nodeErrors.get(nodeId)!.push(error);
  };

  let viewportState: ViewportState = { ...DEFAULT_VIEWPORT_STATE };

  for (const id of sortedIds) {
    const node = nodeMap.get(id);
    if (!node) continue;
    const data = node.data;

    if (!data.enabled) {
      // Disabled nodes: pass through inputs as outputs (for filter/modify)
      const inputs = collectInputs(id, edges, edgeOutputs);
      const passthrough = new Map<string, PipelineData>();
      const nodeType = data.params.type as PipelineNodeType;
      const ports = NODE_PORTS[nodeType];
      for (const [portName, dataList] of inputs) {
        if (dataList.length > 0) {
          const matchingOutput = ports.outputs.find((o) => {
            const inputPort = ports.inputs.find((i) => i.name === portName);
            return inputPort && o.dataType === inputPort.dataType;
          });
          if (matchingOutput) {
            passthrough.set(matchingOutput.name, dataList[0]);
          }
        }
      }
      edgeOutputs.set(id, passthrough);
      continue;
    }

    const inputs = collectInputs(id, edges, edgeOutputs);

    // Per-type behaviour lives in the executor registry
    // (src/pipeline/executors/registry.ts). An unknown type runs nothing and
    // publishes no outputs.
    const executor = getNodeExecutor(data.params.type);
    if (!executor) continue;
    const result = executor({
      id,
      params: data.params,
      inputs,
      nodes,
      ctx,
      addError: (error) => addError(id, error),
    });
    if (result.outputs) edgeOutputs.set(id, result.outputs);
    if (result.viewportState) viewportState = result.viewportState;
  }

  return { viewportState, nodeErrors };
}
