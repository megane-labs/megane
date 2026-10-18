/**
 * Small factories for the hand-built graphs in `defaults.ts` and
 * `templates.ts`, so each graph states only what differs from a node's
 * `defaultParams` instead of spelling out every xyflow field.
 *
 * Nodes are created unplaced (at the origin): every consumer of these graphs
 * — the store's initial graph and `reset`, `applyTemplate`, and
 * `installMinimalGraph` in `openFile.ts` — runs them through `getLayoutedElements`,
 * which positions nodes from their sizes and edges alone, and the editor
 * re-lays them out once measured (`layoutPending`). A hand-written position
 * would never be seen.
 *
 * Internal to the pipeline module; the public JS builder is `builder.ts`.
 */

import type { Node, Edge } from "@xyflow/react";
import type { PipelineNodeData } from "./execute";
import { defaultParams } from "./types";
import type { PipelineNodeParams, PipelineNodeType } from "./types";

/** A pipeline graph as xyflow holds it. */
export interface PipelineGraph {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
}

type ParamsOf<T extends PipelineNodeType> = Extract<PipelineNodeParams, { type: T }>;

/** The params a node overrides on top of its type's `defaultParams`. */
export type ParamOverrides<T extends PipelineNodeType> = Partial<Omit<ParamsOf<T>, "type">>;

/** A node with exactly these params — no defaults filled in. */
export function exactNode(id: string, params: PipelineNodeParams): Node<PipelineNodeData> {
  return {
    id,
    type: params.type,
    position: { x: 0, y: 0 },
    data: { params, enabled: true },
  };
}

/** A node of `type` with its `defaultParams`, overridden by `overrides`. */
export function node<T extends PipelineNodeType>(
  id: string,
  type: T,
  overrides: ParamOverrides<T> = {},
): Node<PipelineNodeData> {
  return exactNode(id, { ...defaultParams(type), ...overrides, type } as PipelineNodeParams);
}

/**
 * One edge: `[source, target, handle]` when both ends use the same port name,
 * `[source, target, sourceHandle, targetHandle]` otherwise.
 */
export type EdgeSpec =
  | readonly [source: string, target: string, handle: string]
  | readonly [source: string, target: string, sourceHandle: string, targetHandle: string];

/** Edges from specs, given the ids `e1`, `e2`, … in order. */
export function edges(...specs: EdgeSpec[]): Edge[] {
  return specs.map(([source, target, sourceHandle, targetHandle = sourceHandle], i) => ({
    id: `e${i + 1}`,
    source,
    target,
    sourceHandle,
    targetHandle,
  }));
}
