import type { Node, Edge } from "@xyflow/react";
import { render } from "@testing-library/react";
import { NodeShellModeContext } from "@/components/nodes/NodeShell";
import { usePipelineStore } from "@/pipeline/store";
import type { PipelineNodeData } from "@/pipeline/execute";
import type { PipelineNodeType, PipelineNodeParams, NodeError } from "@/pipeline/types";
import { defaultParams } from "@/pipeline/types";

/**
 * Reset `usePipelineStore` to a known seed containing the supplied node.
 *
 * Bypasses the store's `deserialize()` action (which re-runs the pipeline
 * `execute()` side effect) by writing state directly. Tests inspect or
 * mutate the resulting `{ nodes, edges, nodeErrors }` after user
 * interactions.
 */
export function seedPipelineStore<T extends PipelineNodeType>(
  nodeType: T,
  options: {
    id?: string;
    enabled?: boolean;
    params?: Record<string, unknown>;
    errors?: NodeError[];
  } = {},
): { id: string; data: PipelineNodeData } {
  const id = options.id ?? `${nodeType}-1`;
  const enabled = options.enabled ?? true;
  const params = { ...defaultParams(nodeType), ...options.params } as PipelineNodeParams;

  const node: Node<PipelineNodeData> = {
    id,
    type: nodeType,
    position: { x: 0, y: 0 },
    data: { params, enabled },
  };

  const edges: Edge[] = [];

  usePipelineStore.setState({
    nodes: [node],
    edges,
    nodeErrors: options.errors ? { [id]: options.errors } : {},
  });

  return { id, data: { params, enabled } };
}

/**
 * Render a node component as the editor graph does: as its compact card
 * (title, summary, handles) instead of its form.
 */
export function renderCard(ui: React.ReactElement) {
  return render(<NodeShellModeContext.Provider value="card">{ui}</NodeShellModeContext.Provider>);
}
