/**
 * Per-document snapshot helpers for the singleton pipeline store.
 *
 * JupyterLab and the VSCode extension share a single global pipeline store
 * across every open document tab. Switching tabs therefore needs to push
 * each tab's state back into the store — re-parsing the underlying file on
 * every tab activation is too slow once a workspace has multiple `.megane`
 * documents.
 *
 * `capturePipelineStore` returns a structurally cheap snapshot of every
 * field the renderer + pipeline editor read from. `restorePipelineStore`
 * applies it via zustand's bulk `setState`. We deliberately keep references
 * (no deep clone) — Snapshot/Frame/ViewportState payloads are immutable in
 * practice and the renderer keys on identity.
 */
import type { PipelineStore } from "./store";

export type PipelineStoreSnapshot = Pick<
  PipelineStore,
  | "nodes"
  | "edges"
  | "viewportState"
  | "snapshot"
  | "atomLabels"
  | "structureFrames"
  | "structureMeta"
  | "fileFrames"
  | "fileMeta"
  | "fileVectors"
  | "nodeSnapshots"
  | "nodeParseErrors"
  | "nodeStreamingData"
  | "nodeErrors"
>;

export function capturePipelineStore(state: PipelineStore): PipelineStoreSnapshot {
  return {
    nodes: state.nodes,
    edges: state.edges,
    viewportState: state.viewportState,
    snapshot: state.snapshot,
    atomLabels: state.atomLabels,
    structureFrames: state.structureFrames,
    structureMeta: state.structureMeta,
    fileFrames: state.fileFrames,
    fileMeta: state.fileMeta,
    fileVectors: state.fileVectors,
    nodeSnapshots: state.nodeSnapshots,
    nodeParseErrors: state.nodeParseErrors,
    nodeStreamingData: state.nodeStreamingData,
    nodeErrors: state.nodeErrors,
  };
}
