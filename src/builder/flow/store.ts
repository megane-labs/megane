/**
 * State of the Builder's Flow mode: which mode the Builder is in, the graph
 * of blocks, and the last run of each block.
 *
 * One store per mounted Builder (`BuilderStores`), like the document and the
 * tools store. The graph is kept as xyflow nodes and edges, so the editor
 * (`FlowPanel`) applies xyflow's own changes to them and hands the result
 * back (`setNodes`, `setEdges`), and deletions come through `removeNodes` /
 * `removeEdges`. The store only uses xyflow's types: the library itself is
 * loaded with the editor, not with every Builder. The engine (`engine.ts`)
 * only reads ids, params and handles from the graph.
 *
 * Editing a block, or a wire into it, marks its last result and everything
 * downstream `stale`: still shown, but redone (or taken from the cache when
 * the key comes back the same) by the next Run. So does a change to the
 * Manual document under a *Manual structure* block (`documentChanged`).
 *
 * The structure itself is shared with Manual mode: a Run makes its output
 * the Manual document (`shared.ts`), and `adoptedKey` remembers which result
 * that was, so running an unchanged flow again leaves Manual edits alone.
 */

import type { Connection, Edge, Node } from "@xyflow/react";
import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { registerTestStores, GLOBAL_BUNDLE_ID } from "../../stores/testRegistry";
import { downstream, nodeKey, runFlow, topoOrder, wouldCycle, type FlowDeps } from "./engine";
import {
  IDLE_RUN,
  OUTPUT_HANDLE,
  type FlowData,
  type FlowMode,
  type FlowNodeData,
  type FlowParams,
  type NodeRun,
} from "./types";

export type FlowNode = Node<FlowNodeData>;

/** A flow as saved: the blocks, where they sit, and the wires. */
export interface SerializedFlow {
  version: 1;
  nodes: { id: string; position: { x: number; y: number }; params: FlowParams }[];
  edges: { source: string; target: string; targetHandle: string }[];
}

export interface FlowStore {
  mode: FlowMode;
  nodes: FlowNode[];
  edges: Edge[];
  runs: Record<string, NodeRun>;
  /** The run in progress, or null. */
  running: AbortController | null;
  /** The block whose result the 3D view shows when no block is selected. */
  viewNodeId: string | null;
  /** Cache key of the result last made the Manual document, or null. */
  adoptedKey: string | null;

  setMode: (mode: FlowMode) => void;
  /** Take the editor's nodes after a move, a resize or a selection. */
  setNodes: (nodes: FlowNode[]) => void;
  /** Take the editor's edges after a selection. */
  setEdges: (edges: Edge[]) => void;
  /** Delete blocks and their wires; what was downstream goes stale. */
  removeNodes: (ids: string[]) => void;
  /** Delete wires; what was downstream of them goes stale. */
  removeEdges: (ids: string[]) => void;
  /**
   * Wire `connection`. A single input takes one wire, so a new one replaces
   * the old (`multiple` false); a table input takes any number. Returns false
   * when the wire is refused (a loop, a duplicate, a missing handle).
   */
  connect: (connection: Connection, multiple: boolean) => boolean;
  /** Add a block; returns its id. Without a position it goes under the others. */
  addNode: (params: FlowParams, position?: { x: number; y: number }) => string;
  /** Merge `patch` into a block's params. */
  updateParams: (id: string, patch: Partial<FlowParams>) => void;
  removeNode: (id: string) => void;
  /**
   * The Manual document changed (its key is `docKey`, null when none is
   * open): the results of *Manual structure* blocks read from another
   * document, and they and everything downstream go stale.
   */
  documentChanged: (docKey: string | null) => void;
  /** Remember that the result with this key is now the Manual document. */
  setAdoptedKey: (key: string | null) => void;
  /** Select one block (and nothing else). */
  selectNode: (id: string | null) => void;
  /** Run the graph (or what `targets` need) with `deps`. */
  run: (deps: FlowDeps, targets?: string[]) => Promise<void>;
  cancel: () => void;
  clear: () => void;
  serialize: () => SerializedFlow;
  load: (flow: SerializedFlow) => void;
}

/** Vertical step between a new block and the lowest one. */
const STEP_Y = 110;

function nextId(nodes: FlowNode[]): string {
  let max = 0;
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

function edgeId(source: string, target: string, handle: string): string {
  return `e-${source}-${target}-${handle}`;
}

/** Where a new block goes: under the lowest block, at the left. */
function nextPosition(nodes: FlowNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 40, y: 40 };
  const bottom = Math.max(...nodes.map((n) => n.position.y));
  return { x: 40, y: bottom + STEP_Y };
}

/** `runs` with every done run in `ids` marked stale. */
function markStale(runs: Record<string, NodeRun>, ids: Iterable<string>): Record<string, NodeRun> {
  let out = runs;
  for (const id of ids) {
    const run = runs[id];
    if (run && run.status === "done") {
      if (out === runs) out = { ...runs };
      out[id] = { ...run, status: "stale" };
    }
  }
  return out;
}

function makeEdge(source: string, target: string, targetHandle: string): Edge {
  return {
    id: edgeId(source, target, targetHandle),
    source,
    sourceHandle: OUTPUT_HANDLE,
    target,
    targetHandle,
    type: "deletable",
  };
}

/** A flow from untrusted JSON (a file), or an error naming what is wrong. */
export function parseSerializedFlow(raw: unknown): SerializedFlow {
  if (!raw || typeof raw !== "object") throw new Error("Not a Flow file.");
  const flow = raw as Partial<SerializedFlow>;
  if (flow.version !== 1) throw new Error("Unsupported Flow file version.");
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) throw new Error("Not a Flow file.");
  const ids = new Set<string>();
  for (const n of flow.nodes) {
    const type = (n?.params as { type?: unknown } | undefined)?.type;
    if (
      typeof n?.id !== "string" ||
      (type !== "molecule" && type !== "document" && type !== "tool")
    ) {
      throw new Error("A block in the file is not one Flow mode knows.");
    }
    ids.add(n.id);
  }
  for (const e of flow.edges) {
    if (!ids.has(e?.source) || !ids.has(e?.target) || typeof e?.targetHandle !== "string") {
      throw new Error("A wire in the file connects blocks that are not there.");
    }
  }
  return flow as SerializedFlow;
}

export const flowStateCreator: StateCreator<FlowStore> = (set, get) => ({
  mode: "manual",
  nodes: [],
  edges: [],
  runs: {},
  running: null,
  viewNodeId: null,
  adoptedKey: null,

  setMode: (mode) => set({ mode }),

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  removeNodes: (ids) => {
    if (ids.length === 0) return;
    const s = get();
    const gone = new Set(ids);
    const stale = new Set<string>();
    for (const e of s.edges) {
      if (gone.has(e.source)) downstream(s, e.target).forEach((id) => stale.add(id));
    }
    const runs = { ...markStale(s.runs, stale) };
    for (const id of ids) delete runs[id];
    set({
      nodes: s.nodes.filter((n) => !gone.has(n.id)),
      edges: s.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
      runs,
      viewNodeId: s.viewNodeId && gone.has(s.viewNodeId) ? null : s.viewNodeId,
    });
  },

  removeEdges: (ids) => {
    if (ids.length === 0) return;
    const s = get();
    const gone = new Set(ids);
    const stale = new Set<string>();
    for (const e of s.edges) {
      if (gone.has(e.id)) downstream(s, e.target).forEach((id) => stale.add(id));
    }
    set({ edges: s.edges.filter((e) => !gone.has(e.id)), runs: markStale(s.runs, stale) });
  },

  connect: ({ source, target, targetHandle }, multiple) => {
    const s = get();
    if (!source || !target || !targetHandle || source === target) return false;
    if (
      s.edges.some(
        (e) => e.source === source && e.target === target && e.targetHandle === targetHandle,
      )
    ) {
      return false;
    }
    if (wouldCycle(s, source, target)) return false;
    const kept = multiple
      ? s.edges
      : s.edges.filter((e) => !(e.target === target && e.targetHandle === targetHandle));
    set({
      edges: [...kept, makeEdge(source, target, targetHandle)],
      runs: markStale(s.runs, downstream(s, target)),
    });
    return true;
  },

  addNode: (params, position) => {
    const s = get();
    const id = nextId(s.nodes);
    const node: FlowNode = {
      id,
      type: params.type,
      position: position ?? nextPosition(s.nodes),
      data: { params },
      selected: true,
    };
    set({
      nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), node],
    });
    return id;
  },

  updateParams: (id, patch) => {
    const s = get();
    set({
      nodes: s.nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } as FlowParams } }
          : n,
      ),
      runs: markStale(s.runs, downstream(s, id)),
    });
  },

  removeNode: (id) => get().removeNodes([id]),

  documentChanged: (docKey) => {
    const s = get();
    const stale = new Set<string>();
    for (const n of s.nodes) {
      const run = s.runs[n.id];
      if (n.data.params.type !== "document" || run?.status !== "done") continue;
      // A Manual structure block has no inputs: its key is its params and the document.
      if (run.key !== nodeKey(n.data.params, {}, docKey)) {
        downstream(s, n.id).forEach((id) => stale.add(id));
      }
    }
    if (stale.size > 0) set({ runs: markStale(s.runs, stale) });
  },

  setAdoptedKey: (adoptedKey) => set({ adoptedKey }),

  selectNode: (id) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        (n.id === id) === !!n.selected ? n : { ...n, selected: n.id === id },
      ),
    })),

  run: async (deps, targets) => {
    const s = get();
    if (s.running) return;
    const controller = new AbortController();
    set({ running: controller });
    try {
      const runs = await runFlow({ nodes: s.nodes, edges: s.edges }, deps, s.runs, {
        signal: controller.signal,
        targets,
        onUpdate: (id, run) => set((cur) => ({ runs: { ...cur.runs, [id]: run } })),
      });
      // Show the result of the run's last block, unless a block is already shown.
      const order = topoOrder({ nodes: get().nodes, edges: get().edges }) ?? [];
      const last = [...(targets ?? order)].reverse().find((id) => runs[id]?.status === "done");
      set((cur) => ({
        viewNodeId: cur.viewNodeId && runs[cur.viewNodeId] ? cur.viewNodeId : (last ?? null),
      }));
    } catch (err) {
      // Only a loop in the graph rejects; report it on every block.
      const error = err instanceof Error ? err.message : String(err);
      set((cur) => ({
        runs: Object.fromEntries(
          cur.nodes.map((n) => [n.id, { ...IDLE_RUN, status: "error" as const, error }]),
        ),
      }));
    } finally {
      set((cur) => (cur.running === controller ? { running: null } : {}));
    }
  },

  cancel: () => get().running?.abort(),

  clear: () => {
    get().running?.abort();
    set({ nodes: [], edges: [], runs: {}, running: null, viewNodeId: null, adoptedKey: null });
  },

  serialize: () => {
    const { nodes, edges } = get();
    return {
      version: 1,
      nodes: nodes.map((n) => ({ id: n.id, position: { ...n.position }, params: n.data.params })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        targetHandle: e.targetHandle ?? "",
      })),
    };
  },

  load: (flow) => {
    get().running?.abort();
    set({
      nodes: flow.nodes.map((n) => ({
        id: n.id,
        type: n.params.type,
        position: { ...n.position },
        data: { params: n.params },
      })),
      edges: flow.edges.map((e) => makeEdge(e.source, e.target, e.targetHandle)),
      runs: {},
      running: null,
      viewNodeId: null,
      adoptedKey: null,
    });
  },
});

/** What the 3D view shows in Flow mode; `id` is null for the shared structure. */
export interface FlowView {
  id: string | null;
  data: FlowData;
}

/**
 * What the 3D view shows in Flow mode: the selected block when it has a
 * result, else the structure shared with Manual mode (`document`), else the
 * block the last run ended on. Null when none of them has one.
 */
export function flowViewData(
  state: Pick<FlowStore, "nodes" | "runs" | "viewNodeId">,
  document: FlowData | null = null,
): FlowView | null {
  const shown = (id: string | null | undefined) => {
    const run = id ? state.runs[id] : undefined;
    return run && run.data && (run.status === "done" || run.status === "stale")
      ? { id: id!, data: run.data }
      : null;
  };
  return (
    shown(state.nodes.find((n) => n.selected)?.id) ??
    (document ? { id: null, data: document } : null) ??
    shown(state.viewNodeId)
  );
}

/**
 * The block a Run builds the model in: the last block, in dependency order,
 * that no wire leaves. Null for an empty graph or a loop.
 */
export function outputNodeId(state: Pick<FlowStore, "nodes" | "edges">): string | null {
  const order = topoOrder(state);
  if (!order) return null;
  const feeds = new Set(state.edges.map((e) => e.source));
  return [...order].reverse().find((id) => !feeds.has(id)) ?? null;
}

/** A private Flow store (tests, and one per scoped Builder). */
export function createFlowStore(): StoreApi<FlowStore> {
  return createStore<FlowStore>(flowStateCreator);
}

/** The page-wide Flow store, used by a Builder mounted without a provider. */
export const useFlowStore = create<FlowStore>(flowStateCreator);

registerTestStores(GLOBAL_BUNDLE_ID, { builderFlow: useFlowStore });
