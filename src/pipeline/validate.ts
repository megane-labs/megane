/**
 * Pipeline graph validation.
 * Detects structural errors (missing connections, cycles, config issues)
 * independently of pipeline execution.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import type {
  PipelineNodeType,
  NodeError,
  CoordinationGeneratorParams,
  FilterParams,
  LoadStructureParams,
  LoadTrajectoryParams,
  LoadVectorParams,
  StreamingParams,
} from "./types";
import { NODE_PORTS } from "./types";
import { topologicalSort } from "./graph";
import { validateQuery } from "./selection";

/**
 * Run all graph-level and configuration validations.
 * Returns a map of nodeId → errors.
 */
export function validatePipeline(
  nodes: Node<PipelineNodeData>[],
  edges: Edge[],
): Map<string, NodeError[]> {
  const errors = new Map<string, NodeError[]>();

  const addError = (nodeId: string, error: NodeError) => {
    if (!errors.has(nodeId)) errors.set(nodeId, []);
    errors.get(nodeId)!.push(error);
  };

  // Build lookup structures
  const incomingEdges = new Map<string, Edge[]>();
  for (const node of nodes) {
    incomingEdges.set(node.id, []);
  }
  for (const edge of edges) {
    incomingEdges.get(edge.target)?.push(edge);
  }

  // 1. Required input not connected
  for (const node of nodes) {
    const nodeType = node.type as PipelineNodeType;
    if (!nodeType) continue;
    const ports = NODE_PORTS[nodeType];
    if (!ports || ports.inputs.length === 0) continue;

    const connectedInputs = new Set((incomingEdges.get(node.id) ?? []).map((e) => e.targetHandle));

    const hasAnyInput = ports.inputs.some((p) => connectedInputs.has(p.name));
    if (!hasAnyInput) {
      addError(node.id, { message: "No input connected", severity: "error" });
    }
  }

  // 2. Viewport reachability check
  const viewportIds = nodes.filter((n) => n.type === "viewport").map((n) => n.id);

  if (viewportIds.length > 0) {
    // BFS backwards from viewport nodes
    const queue = [...viewportIds];
    const visited = new Set<string>(viewportIds);
    // Build backward adjacency
    const backwardAdj = new Map<string, Set<string>>();
    for (const node of nodes) {
      backwardAdj.set(node.id, new Set());
    }
    for (const edge of edges) {
      backwardAdj.get(edge.target)?.add(edge.source);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const prev of backwardAdj.get(current) ?? []) {
        if (!visited.has(prev)) {
          visited.add(prev);
          queue.push(prev);
        }
      }
    }

    for (const node of nodes) {
      if (node.type === "viewport") continue;
      if (!visited.has(node.id)) {
        addError(node.id, {
          message: "Not connected to Viewport",
          severity: "warning",
        });
      }
    }
  }

  // 3. Cycle detection
  const sorted = topologicalSort(nodes, edges);
  if (sorted.length < nodes.length) {
    const sortedSet = new Set(sorted);
    for (const node of nodes) {
      if (!sortedSet.has(node.id)) {
        addError(node.id, { message: "Cycle detected", severity: "error" });
      }
    }
  }

  // 4. Node configuration errors
  for (const node of nodes) {
    if (!node.data.enabled) continue;
    const params = node.data.params;

    switch (params.type) {
      case "load_structure": {
        const p = params as LoadStructureParams;
        if (!p.fileName) {
          addError(node.id, {
            message: "No structure file loaded",
            severity: "warning",
          });
        }
        break;
      }
      case "load_trajectory": {
        const p = params as LoadTrajectoryParams;
        if (!p.fileName) {
          addError(node.id, {
            message: "No trajectory file loaded",
            severity: "warning",
          });
        }
        break;
      }
      case "streaming": {
        const p = params as StreamingParams;
        if (!p.connected) {
          addError(node.id, {
            message: "Not connected to server",
            severity: "warning",
          });
        }
        break;
      }
      case "load_vector": {
        const p = params as LoadVectorParams;
        if (!p.fileName) {
          addError(node.id, {
            message: "No vector file loaded",
            severity: "warning",
          });
        }
        break;
      }
      case "filter": {
        const p = params as FilterParams;
        if (p.query.trim()) {
          const result = validateQuery(p.query);
          if (!result.valid) {
            addError(node.id, {
              message: `Query syntax error: ${result.error}`,
              severity: "error",
            });
          }
        }
        break;
      }
      case "coordination_generator": {
        const p = params as CoordinationGeneratorParams;
        for (const [label, query] of [
          ["Center", p.centerQuery],
          ["Neighbor", p.neighborQuery],
        ] as const) {
          if (!query?.trim()) continue;
          const result = validateQuery(query);
          if (!result.valid) {
            addError(node.id, {
              message: `${label} query syntax error: ${result.error}`,
              severity: "error",
            });
          }
        }
        break;
      }
    }
  }

  return errors;
}
