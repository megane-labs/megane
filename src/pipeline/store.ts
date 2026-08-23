/**
 * Zustand store for pipeline state management.
 * Manages xyflow nodes/edges, pipeline execution, and serialization.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Node, Edge, OnNodesChange, OnEdgesChange, Connection } from "@xyflow/react";
import { applyNodeChanges, applyEdgeChanges, addEdge } from "@xyflow/react";
import type { PipelineNodeData, PipelineExecutionContext, NodeSnapshotData } from "./execute";
import type { NodeStreamingData } from "./executors/streaming";
import type { Snapshot, Frame, TrajectoryMeta, VectorFrame } from "../types";
import type {
  PipelineNodeType,
  ViewportState,
  SerializedPipeline,
  NodeError,
  FrameProvider,
} from "./types";
import { defaultParams, DEFAULT_VIEWPORT_STATE, canConnect } from "./types";
import { LazyFrameProvider } from "../stream/LazyFrameProvider";
import { executePipeline } from "./execute";
import { validatePipeline } from "./validate";
import { serializePipeline, deserializePipeline } from "./serialize";
import { createDefaultPipeline, createDemoPipeline, createEmptyPipeline } from "./defaults";
import { PIPELINE_TEMPLATES } from "./templates";
import { getLayoutedElements } from "./layout";
import { performOpenFile, type OpenFileOptions } from "./openFile";
import { reconcileInspectorLayers, isInspectorId, type InspectorLayer } from "./inspectorSync";

let nextNodeId = 1;

function generateNodeId(): string {
  return `node-${nextNodeId++}`;
}

export interface PipelineStore {
  // xyflow state
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
  viewportState: ViewportState;
  nodeErrors: Record<string, NodeError[]>;

  // Molecular data for pipeline execution context
  snapshot: Snapshot | null;
  atomLabels: string[] | null;
  structureFrames: Frame[] | null;
  structureMeta: TrajectoryMeta | null;
  /** Pre-built lazy/streaming provider for a multi-frame structure file (mutually exclusive with structureFrames). */
  structureProvider: FrameProvider | null;
  fileFrames: Frame[] | null;
  fileMeta: TrajectoryMeta | null;
  /** Pre-built lazy/streaming provider for the file trajectory (mutually exclusive with fileFrames). */
  fileProvider: FrameProvider | null;
  fileVectors: VectorFrame[] | null;
  /**
   * Vector channels embedded in the loaded structure/trajectory file (GRO
   * velocities, LAMMPS dump vx/vy/vz, ...). These are OFFERED to the user —
   * nothing renders until a load_vector node activates one; a parse must not
   * switch a visual overlay on as a side effect.
   */
  embeddedVectorChannels: { name: string; frames: VectorFrame[] }[] | null;
  /** Name of the embedded channel currently feeding `fileVectors`, if any. */
  activeEmbeddedVectorChannel: string | null;

  // Per-node snapshot storage (keyed by load_structure node ID)
  nodeSnapshots: Record<string, NodeSnapshotData>;
  nodeParseErrors: Record<string, string>;

  // Per-node streaming data (keyed by streaming node ID)
  nodeStreamingData: Record<string, NodeStreamingData>;

  setSnapshot: (s: Snapshot | null) => void;
  setAtomLabels: (labels: string[] | null) => void;
  setStructureFrames: (frames: Frame[] | null, meta: TrajectoryMeta | null) => void;
  setStructureProvider: (provider: FrameProvider | null) => void;
  setFileFrames: (frames: Frame[] | null, meta: TrajectoryMeta | null) => void;
  setFileProvider: (provider: FrameProvider | null) => void;
  setFileVectors: (vectors: VectorFrame[] | null) => void;
  setEmbeddedVectorChannels: (channels: { name: string; frames: VectorFrame[] }[] | null) => void;
  activateEmbeddedVectorChannel: (name: string | null) => void;
  setNodeSnapshot: (nodeId: string, data: NodeSnapshotData) => void;
  removeNodeSnapshot: (nodeId: string) => void;
  setNodeParseError: (nodeId: string, message: string) => void;
  clearNodeParseError: (nodeId: string) => void;
  setNodeStreamingData: (nodeId: string, data: NodeStreamingData) => void;
  removeNodeStreamingData: (nodeId: string) => void;

  // xyflow change handlers
  onNodesChange: OnNodesChange<Node<PipelineNodeData>>;
  onEdgesChange: OnEdgesChange;
  onConnect: (connection: Connection) => void;

  // Node operations
  addNode: (type: PipelineNodeType, position?: { x: number; y: number }) => string;
  removeNode: (id: string) => void;
  updateNodeParams: (id: string, params: Record<string, unknown>) => void;
  toggleNode: (id: string) => void;

  // Pipeline execution
  execute: () => void;

  // Single canonical file ingestion entry. Classifies by extension and
  // configures the pipeline accordingly. See openFile.ts for details.
  openFile: (file: File, opts?: OpenFileOptions) => Promise<void>;

  // Serialization
  serialize: () => SerializedPipeline;
  deserialize: (json: SerializedPipeline) => void;

  // Atomically replace the graph and per-node snapshots. Used by anywidget
  // hosts (Jupyter widget, VSCode webview) when Python pushes a new pipeline
  // alongside the per-node binary snapshot blobs. `deserialize` alone wipes
  // `nodeSnapshots` (so that opening a new .megane.json doesn't bleed state
  // across documents in JupyterLab); calling `setNodeSnapshot` *before*
  // `deserialize` therefore loses the snapshot. `loadPipeline` performs both
  // updates inside a single store transaction so the post-deserialize
  // execute() sees the matching per-node snapshots.
  loadPipeline: (json: SerializedPipeline, nodeSnapshots: Record<string, NodeSnapshotData>) => void;

  // Selection Inspector: replace the Inspector-owned subgraph with the nodes
  // realizing `layers` (filter → color/representation/modify → viewport),
  // branching from whatever currently feeds viewport.particle so replicate /
  // supercell effects are preserved. Non-Inspector nodes are left untouched.
  setInspectorLayers: (layers: InspectorLayer[]) => void;

  // Templates
  pendingTemplateId: string | null;
  applyTemplate: (templateId: string) => void;
  clearPendingTemplate: () => void;

  // Layout
  autoLayout: () => void;

  // Reset
  reset: () => void;
}

function getInitialPipeline() {
  const search = new URLSearchParams(globalThis.location?.search ?? "");
  if (search.has("demo")) return createDemoPipeline();
  if ((globalThis as any).__MEGANE_CONTEXT__ === "vscode") return createEmptyPipeline();
  return createDefaultPipeline();
}

const rawDefault = getInitialPipeline();
const defaultState = getLayoutedElements(rawDefault.nodes, rawDefault.edges);

const CLEARED_EXECUTION_CONTEXT = {
  snapshot: null,
  atomLabels: null,
  structureFrames: null,
  structureMeta: null,
  structureProvider: null,
  fileFrames: null,
  fileMeta: null,
  fileProvider: null,
  fileVectors: null,
  embeddedVectorChannels: null,
  activeEmbeddedVectorChannel: null,
  nodeSnapshots: {} as Record<string, NodeSnapshotData>,
  nodeParseErrors: {} as Record<string, string>,
  nodeStreamingData: {} as Record<string, NodeStreamingData>,
} as const;

/** Free a lazy trajectory provider's worker decoder when it is replaced/cleared. */
function disposeIfLazy(provider: FrameProvider | null | undefined): void {
  if (provider instanceof LazyFrameProvider) provider.dispose();
}

const pipelineStateCreator: StateCreator<PipelineStore> = (set, get, api) => ({
  nodes: defaultState.nodes,
  edges: defaultState.edges,
  viewportState: { ...DEFAULT_VIEWPORT_STATE },
  nodeErrors: {},
  snapshot: null,
  atomLabels: null,
  structureFrames: null,
  structureMeta: null,
  structureProvider: null,
  fileFrames: null,
  fileMeta: null,
  fileProvider: null,
  fileVectors: null,
  embeddedVectorChannels: null,
  activeEmbeddedVectorChannel: null,
  nodeSnapshots: {},
  nodeParseErrors: {},
  nodeStreamingData: {},

  setSnapshot: (s) => {
    set({ snapshot: s });
    get().execute();
  },
  setAtomLabels: (labels) => {
    set({ atomLabels: labels });
    get().execute();
  },
  setStructureFrames: (frames, meta) => {
    // Eager frames and a lazy provider are mutually exclusive; installing frames
    // releases any active lazy structure decoder.
    disposeIfLazy(get().structureProvider);
    set({ structureFrames: frames, structureMeta: meta, structureProvider: null });
    get().execute();
  },
  setStructureProvider: (provider) => {
    const prev = get().structureProvider;
    if (prev !== provider) disposeIfLazy(prev);
    // Clear the eager structure-frame channel so executeLoadStructure sees only the provider.
    set({ structureProvider: provider, structureFrames: null, structureMeta: null });
    get().execute();
  },
  setFileFrames: (frames, meta) => {
    // Eager frames and a lazy provider are mutually exclusive inputs; installing
    // frames releases any active lazy decoder.
    disposeIfLazy(get().fileProvider);
    set({ fileFrames: frames, fileMeta: meta, fileProvider: null });
    get().execute();
  },
  setFileProvider: (provider) => {
    const prev = get().fileProvider;
    if (prev !== provider) disposeIfLazy(prev);
    // Clear the eager frame channel so executeLoadTrajectory sees only the provider.
    set({ fileProvider: provider, fileFrames: null, fileMeta: null });
    get().execute();
  },
  setFileVectors: (vectors) => {
    set({ fileVectors: vectors });
    get().execute();
  },
  setEmbeddedVectorChannels: (channels) => {
    const active = get().activeEmbeddedVectorChannel;
    if (active === null) {
      set({ embeddedVectorChannels: channels });
      return;
    }
    // An activated channel follows its source data: refresh the overlay when
    // the channel still exists (e.g. lazy decode streamed in more frames),
    // deactivate it when the new file no longer carries it.
    const match = channels?.find((c) => c.name === active) ?? null;
    set({
      embeddedVectorChannels: channels,
      activeEmbeddedVectorChannel: match ? active : null,
      fileVectors: match ? match.frames : null,
    });
    get().execute();
  },
  activateEmbeddedVectorChannel: (name) => {
    const match =
      name === null ? null : (get().embeddedVectorChannels?.find((c) => c.name === name) ?? null);
    set({
      activeEmbeddedVectorChannel: match ? name : null,
      fileVectors: match ? match.frames : null,
    });
    get().execute();
  },

  setNodeSnapshot: (nodeId, data) => {
    set((state) => ({
      nodeSnapshots: { ...state.nodeSnapshots, [nodeId]: data },
    }));
    get().execute();
  },

  removeNodeSnapshot: (nodeId) => {
    set((state) => {
      const { [nodeId]: _, ...rest } = state.nodeSnapshots;
      const { [nodeId]: __, ...restErrors } = state.nodeParseErrors;
      return { nodeSnapshots: rest, nodeParseErrors: restErrors };
    });
    get().execute();
  },

  setNodeParseError: (nodeId, message) => {
    set((state) => ({
      nodeParseErrors: { ...state.nodeParseErrors, [nodeId]: message },
    }));
    get().execute();
  },

  clearNodeParseError: (nodeId) => {
    set((state) => {
      const { [nodeId]: _, ...rest } = state.nodeParseErrors;
      return { nodeParseErrors: rest };
    });
  },

  setNodeStreamingData: (nodeId, data) => {
    set((state) => ({
      nodeStreamingData: { ...state.nodeStreamingData, [nodeId]: data },
    }));
    get().execute();
  },

  removeNodeStreamingData: (nodeId) => {
    set((state) => {
      const { [nodeId]: _, ...rest } = state.nodeStreamingData;
      return { nodeStreamingData: rest };
    });
    get().execute();
  },

  onNodesChange: (changes) => {
    // Prevent viewport nodes from being deleted (via keyboard Delete etc.)
    const { nodes } = get();
    const filtered = changes.filter((change) => {
      if (change.type === "remove") {
        const node = nodes.find((n) => n.id === change.id);
        if (node?.type === "viewport") return false;
      }
      return true;
    });
    if (filtered.length === 0) return;
    set((state) => ({
      nodes: applyNodeChanges(filtered, state.nodes),
    }));
    // Only re-execute pipeline for structural changes (node removal),
    // not for position/dimension/selection changes which don't affect pipeline logic.
    if (filtered.some((c) => c.type === "remove")) {
      get().execute();
    }
  },

  onEdgesChange: (changes) => {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
    get().execute();
  },

  onConnect: (connection) => {
    const { nodes } = get();
    const sourceNode = nodes.find((n) => n.id === connection.source);
    const targetNode = nodes.find((n) => n.id === connection.target);
    if (!sourceNode?.type || !targetNode?.type) return;

    if (
      !canConnect(
        sourceNode.type as PipelineNodeType,
        connection.sourceHandle ?? null,
        targetNode.type as PipelineNodeType,
        connection.targetHandle ?? null,
      )
    ) {
      return;
    }

    set((state) => ({
      edges: addEdge(
        {
          ...connection,
          id: `e-${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
        },
        state.edges,
      ),
    }));
    get().execute();
  },

  addNode: (type, position) => {
    const id = generateNodeId();
    let fallbackPosition = { x: 425, y: 50 };
    if (!position) {
      const currentNodes = get().nodes;
      if (currentNodes.length > 0) {
        const maxY = Math.max(...currentNodes.map((n) => n.position.y));
        fallbackPosition = { x: 425, y: maxY + 200 };
      }
    }
    const newNode: Node<PipelineNodeData> = {
      id,
      type,
      position: position ?? fallbackPosition,
      data: {
        params: defaultParams(type),
        enabled: true,
      },
    };
    set((state) => ({
      nodes: [...state.nodes, newNode],
    }));
    return id;
  },

  removeNode: (id) => {
    set((state) => {
      const { [id]: _, ...restSnapshots } = state.nodeSnapshots;
      const { [id]: __, ...restParseErrors } = state.nodeParseErrors;
      const { [id]: ___, ...restStreaming } = state.nodeStreamingData;
      return {
        nodes: state.nodes.filter((n) => n.id !== id),
        edges: state.edges.filter((e) => e.source !== id && e.target !== id),
        nodeSnapshots: restSnapshots,
        nodeParseErrors: restParseErrors,
        nodeStreamingData: restStreaming,
      };
    });
    get().execute();
  },

  updateNodeParams: (id, params) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== id) return n;
        return {
          ...n,
          data: {
            ...n.data,
            params: { ...n.data.params, ...params },
          },
        };
      }),
    }));
    get().execute();
  },

  toggleNode: (id) => {
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== id) return n;
        return {
          ...n,
          data: { ...n.data, enabled: !n.data.enabled },
        };
      }),
    }));
    get().execute();
  },

  execute: () => {
    const {
      nodes,
      edges,
      snapshot,
      atomLabels,
      structureFrames,
      structureMeta,
      structureProvider,
      fileFrames,
      fileMeta,
      fileProvider,
      fileVectors,
      nodeSnapshots,
      nodeParseErrors,
      nodeStreamingData,
    } = get();
    const ctx: PipelineExecutionContext = {
      snapshot,
      atomLabels,
      structureFrames,
      structureMeta,
      structureProvider,
      fileFrames,
      fileMeta,
      fileProvider,
      fileVectors,
      nodeSnapshots,
      nodeStreamingData,
    };

    // Run validation and execution
    const validationErrors = validatePipeline(nodes, edges);
    const { viewportState, nodeErrors: executionErrors } = executePipeline(nodes, edges, ctx);

    // Merge validation, execution, and parse errors
    const merged: Record<string, NodeError[]> = {};
    for (const [id, errs] of validationErrors) {
      merged[id] = [...errs];
    }
    for (const [id, errs] of executionErrors) {
      if (!merged[id]) merged[id] = [];
      merged[id].push(...errs);
    }
    for (const [id, message] of Object.entries(nodeParseErrors)) {
      if (!merged[id]) merged[id] = [];
      merged[id].push({ message, severity: "error" });
    }

    set({ viewportState, nodeErrors: merged });
  },

  openFile: async (file, opts) => {
    await performOpenFile(api, file, opts);
  },

  serialize: () => {
    const { nodes, edges } = get();
    return serializePipeline(nodes, edges);
  },

  deserialize: (json) => {
    const { nodes, edges } = deserializePipeline(json);
    // Clear all execution context tied to the previous graph: per-node
    // snapshots are keyed by node ID and would orphan across opens, but
    // worse, the global snapshot/frames/vectors fields would silently
    // bleed into the new pipeline's execution. Hosts (JupyterLab,
    // VSCode) reuse this singleton store across documents, so every
    // .megane.json open must start from a clean slate.
    disposeIfLazy(get().fileProvider);
    disposeIfLazy(get().structureProvider);
    set({
      nodes,
      edges,
      viewportState: { ...DEFAULT_VIEWPORT_STATE },
      ...CLEARED_EXECUTION_CONTEXT,
    });
    get().execute();
  },

  loadPipeline: (json, nodeSnapshots) => {
    const { nodes, edges } = deserializePipeline(json);
    // Pick a primary snapshot for the legacy `snapshot` field so the
    // Viewport's loadSnapshot path still has data to render. Iterate in
    // node-id order to be deterministic across hosts.
    const sortedIds = Object.keys(nodeSnapshots).sort();
    const primarySnapshot = sortedIds.length > 0 ? nodeSnapshots[sortedIds[0]].snapshot : null;
    disposeIfLazy(get().fileProvider);
    disposeIfLazy(get().structureProvider);
    set({
      nodes,
      edges,
      viewportState: { ...DEFAULT_VIEWPORT_STATE },
      ...CLEARED_EXECUTION_CONTEXT,
      nodeSnapshots: { ...nodeSnapshots },
      snapshot: primarySnapshot,
    });
    get().execute();
  },

  setInspectorLayers: (layers) => {
    const { nodes, edges } = get();
    const viewport = nodes.find((n) => n.type === "viewport");
    if (!viewport) return;

    // Prefer the node currently feeding viewport.particle (e.g. replicate) as
    // the branch source so filtered layers inherit any supercell expansion.
    const baseEdge = edges.find(
      (e) =>
        e.target === viewport.id &&
        (e.targetHandle ?? "") === "particle" &&
        !isInspectorId(e.source),
    );
    let source: { nodeId: string; handle: string } | null = null;
    if (baseEdge) {
      source = { nodeId: baseEdge.source, handle: baseEdge.sourceHandle ?? "particle" };
    } else {
      const loader = nodes.find((n) => n.type === "load_structure");
      if (loader) source = { nodeId: loader.id, handle: "particle" };
    }
    if (!source) return;

    const next = reconcileInspectorLayers(nodes, edges, layers, source, viewport.id);
    set({ nodes: next.nodes, edges: next.edges });
    get().execute();
  },

  pendingTemplateId: null,

  applyTemplate: (templateId) => {
    const template = PIPELINE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    const raw = template.create();
    const { nodes, edges } = getLayoutedElements(raw.nodes, raw.edges);
    disposeIfLazy(get().fileProvider);
    disposeIfLazy(get().structureProvider);
    set({
      nodes,
      edges,
      viewportState: { ...DEFAULT_VIEWPORT_STATE },
      pendingTemplateId: templateId,
      ...CLEARED_EXECUTION_CONTEXT,
    });
    get().execute();
  },

  clearPendingTemplate: () => {
    set({ pendingTemplateId: null });
  },

  autoLayout: () => {
    const { nodes, edges } = get();
    const { nodes: layoutedNodes } = getLayoutedElements(nodes, edges);
    set({ nodes: layoutedNodes });
  },

  reset: () => {
    const def = getInitialPipeline();
    disposeIfLazy(get().fileProvider);
    disposeIfLazy(get().structureProvider);
    set({
      nodes: def.nodes,
      edges: def.edges,
      viewportState: { ...DEFAULT_VIEWPORT_STATE },
      ...CLEARED_EXECUTION_CONTEXT,
    });
  },
});

// Default app-wide singleton — used by the webapp, PipelineEditor, node
// components, and any host that wants a shared global pipeline. The Jupyter
// widget intentionally does NOT use this: each MolecularViewer needs an
// isolated store so that two viewers in the same notebook don't stomp on
// each other's pipeline (loadPipeline replaces nodes/edges/snapshot).
export const usePipelineStore = create<PipelineStore>(pipelineStateCreator);

// Factory for hosts that need a private pipeline store (e.g. each Jupyter
// widget instance). Returns a vanilla Zustand store; consume with `useStore`
// from "zustand" inside React.
export function createPipelineStore(): StoreApi<PipelineStore> {
  return createStore<PipelineStore>(pipelineStateCreator);
}

// ── Test-only window hook ──────────────────────────────────────────────
// When testMode is detected we expose the Zustand store on the global so
// Playwright specs (under tests/e2e/lib/pipeline.ts) can drive
// addNode / removeNode / connectEdge / updateNodeParams without scripting
// React Flow mouse interactions. No-op outside testMode.
(() => {
  if (typeof window === "undefined") return;
  try {
    const g = globalThis as { __MEGANE_TEST__?: boolean };
    let testMode = g.__MEGANE_TEST__ === true;
    if (!testMode) {
      const params = new URLSearchParams(window.location?.search ?? "");
      if (params.get("test") === "1") testMode = true;
    }
    if (!testMode && window.parent && window.parent !== window) {
      const pg = (window.parent as Window & { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__;
      if (pg) testMode = true;
    }
    if (!testMode) return;
    (
      window as Window & { __megane_test_pipeline_store?: typeof usePipelineStore }
    ).__megane_test_pipeline_store = usePipelineStore;
  } catch {
    /* noop — same-origin checks may throw inside cross-origin frames */
  }
})();
