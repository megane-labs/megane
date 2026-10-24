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
 * `pinnedDocument` remembers the document from before that: while the Manual
 * document is still the flow's own result, a *Manual structure* block reads
 * the earlier one, so Run after Run does not build on its own output (a
 * supercell of the supercell of …).
 *
 * Every change to the graph (add, remove, wire, settings, a template, Clear,
 * Open) first records the graph in `past`, so Undo and Redo step through it.
 */

import type { Connection, Edge, Node } from "@xyflow/react";
import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { registerTestStores, GLOBAL_BUNDLE_ID } from "../../stores/testRegistry";
import type { BuilderToolInfo } from "../tools/contract";
import {
  downstream,
  nodeKey,
  runFlow,
  stableStringify,
  topoOrder,
  wouldCycle,
  type FlowDeps,
} from "./engine";
import { completeToolParams } from "./ports";
import {
  FLOW_NODE_TYPES,
  IDLE_RUN,
  OUTPUT_HANDLE,
  type FlowData,
  type FlowMode,
  type FlowNodeData,
  type FlowParams,
  type NodeRun,
} from "./types";

export type FlowNode = Node<FlowNodeData>;

/** The graph as one Undo step restores it. */
export interface FlowGraphState {
  nodes: FlowNode[];
  edges: Edge[];
  /** On the step an AI assistant's apply recorded: that apply's checkpoint id. */
  generated?: number;
}

/** Most graph states Undo keeps. */
export const FLOW_HISTORY_LIMIT = 100;

/** How a Run ended: ran (some blocks may have failed), stopped, or not started (one was running). */
export type RunOutcome = "finished" | "cancelled" | "busy";

/** The Manual document as a *Manual structure* block reads it, and its key. */
export interface FlowDocument {
  data: FlowData;
  key: string;
}

/**
 * The document a Run replaced with the flow's result: while the Manual
 * document's key is still `adoptedDocKey`, *Manual structure* blocks read
 * `base` instead.
 */
export interface PinnedDocument {
  adoptedDocKey: string;
  base: FlowDocument;
}

/** What `load` is told besides the flow. */
export interface LoadOptions {
  /** Name of the file or template it came from (the name Save suggests), or null. */
  name?: string | null;
  /** Record the graph it replaces for Undo. Default true. */
  history?: boolean;
}

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
  /** The document the flow's result replaced, while the result is still the document. */
  pinnedDocument: PinnedDocument | null;
  /** Stop was pressed and the run has not ended yet. */
  stopping: boolean;
  /** Graph states before each change, most recent last (Undo). */
  past: FlowGraphState[];
  /** Graph states Undo stepped back from, most recent last (Redo). */
  future: FlowGraphState[];
  /**
   * The block and fields the last settings edit changed: further edits of the
   * same fields (typing in one box) join that Undo step. Any other change
   * resets it.
   */
  editKey: string | null;
  /** Name of the file or template the flow came from, or null (Save's suggestion). */
  fileName: string | null;

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
  /**
   * Give every tool block the default of each form field it lacks, from the
   * tool `toolOf` finds (a template's blocks fill in once the server is
   * connected). Changes no result: a block missing a field never ran.
   */
  completeTools: (toolOf: (name: string) => BuilderToolInfo | null) => void;
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
  /** Remember (or forget) the document the flow's result replaced. */
  setPinnedDocument: (pin: PinnedDocument | null) => void;
  /**
   * The document a *Manual structure* block reads when the Manual document
   * is `doc`: the pinned one while `doc` is the flow's own adopted result.
   */
  readDocument: (doc: FlowDocument | null) => FlowDocument | null;
  /** Record the graph for Undo before a change made outside the store's actions (a layout). */
  checkpoint: () => void;
  /** Step the graph back (or forward) one change; ignored while a run is in progress. */
  undo: () => void;
  redo: () => void;
  /** Select one block (and nothing else). */
  selectNode: (id: string | null) => void;
  /** Run the graph (or what `targets` need) with `deps`. */
  run: (deps: FlowDeps, targets?: string[]) => Promise<RunOutcome>;
  /** Stop the run in progress; `stopping` stays on until it has ended. */
  cancel: () => void;
  clear: () => void;
  serialize: () => SerializedFlow;
  load: (flow: SerializedFlow, options?: LoadOptions) => void;
  /**
   * Replace the graph with one the AI assistant generated. Unlike `load`, it
   * keeps what the new graph keeps: a block with the same id, settings and
   * wires keeps its result (one that changed goes stale, so the next Run
   * redoes only what changed), a kept block stays selected, and the link
   * between the flow and the Manual document (`adoptedKey`,
   * `pinnedDocument`) and the file name stay. A run in progress is stopped,
   * as `load` stops it.
   *
   * `checkpoint` (default true) records the graph it replaces as one Undo
   * step tagged with a new checkpoint id, which it returns; a later apply for
   * the same request passes false, replacing the graph again within that
   * step, and gets null.
   */
  applyGenerated: (flow: SerializedFlow, options?: { checkpoint?: boolean }) => number | null;
  /**
   * Undo the apply that recorded checkpoint `id`, while it is still the last
   * change (and no run is in progress). Returns whether it did.
   */
  undoGenerated: (id: number) => boolean;
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

/** `past` with `state` pushed on, at most {@link FLOW_HISTORY_LIMIT} long. */
function pushed(past: FlowGraphState[], state: FlowGraphState): FlowGraphState[] {
  const out = [...past, state];
  return out.length > FLOW_HISTORY_LIMIT ? out.slice(out.length - FLOW_HISTORY_LIMIT) : out;
}

/** The ids of the wires into `id`, as one string. */
function wiresInto(edges: Edge[], id: string): string {
  return edges
    .filter((e) => e.target === id)
    .map((e) => e.id)
    .sort()
    .join("|");
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
    if (typeof n?.id !== "string" || !(FLOW_NODE_TYPES as readonly unknown[]).includes(type)) {
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

export const flowStateCreator: StateCreator<FlowStore> = (set, get) => {
  /** The last checkpoint id `applyGenerated` handed out. */
  let lastCheckpoint = 0;

  /** The history fields of a change: the graph as it is now goes on `past`. */
  const record = (): Pick<FlowStore, "past" | "future" | "editKey"> => {
    const s = get();
    return {
      past: pushed(s.past, { nodes: s.nodes, edges: s.edges }),
      future: [],
      editKey: null,
    };
  };

  /**
   * Put `target` back as the graph. Results of blocks whose settings or wires
   * differ from now go stale with what is downstream of them (the next Run
   * takes them from the cache if they come back the same); a block that is
   * gone loses its result.
   */
  const restore = (target: FlowGraphState): Partial<FlowStore> => {
    const s = get();
    const now = new Map(s.nodes.map((n) => [n.id, n]));
    const stale = new Set<string>();
    for (const n of target.nodes) {
      const cur = now.get(n.id);
      if (
        !cur ||
        cur.data.params !== n.data.params ||
        wiresInto(s.edges, n.id) !== wiresInto(target.edges, n.id)
      ) {
        downstream(target, n.id).forEach((id) => stale.add(id));
      }
    }
    const kept = new Set(target.nodes.map((n) => n.id));
    const runs = { ...markStale(s.runs, stale) };
    for (const id of Object.keys(runs)) if (!kept.has(id)) delete runs[id];
    return {
      nodes: target.nodes,
      edges: target.edges,
      runs,
      viewNodeId: s.viewNodeId && kept.has(s.viewNodeId) ? s.viewNodeId : null,
      editKey: null,
    };
  };

  return {
    mode: "manual",
    nodes: [],
    edges: [],
    runs: {},
    running: null,
    viewNodeId: null,
    adoptedKey: null,
    pinnedDocument: null,
    stopping: false,
    past: [],
    future: [],
    editKey: null,
    fileName: null,

    setMode: (mode) => set({ mode }),

    setNodes: (nodes) => set({ nodes }),
    setEdges: (edges) => set({ edges }),

    removeNodes: (ids) => {
      const s = get();
      // A run reads the graph as it was when it started: nothing goes while it runs.
      if (ids.length === 0 || s.running) return;
      const gone = new Set(ids);
      const stale = new Set<string>();
      for (const e of s.edges) {
        if (gone.has(e.source)) downstream(s, e.target).forEach((id) => stale.add(id));
      }
      const runs = { ...markStale(s.runs, stale) };
      for (const id of ids) delete runs[id];
      set({
        ...record(),
        nodes: s.nodes.filter((n) => !gone.has(n.id)),
        edges: s.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
        runs,
        viewNodeId: s.viewNodeId && gone.has(s.viewNodeId) ? null : s.viewNodeId,
      });
    },

    removeEdges: (ids) => {
      const s = get();
      if (ids.length === 0 || s.running) return;
      const gone = new Set(ids);
      const stale = new Set<string>();
      for (const e of s.edges) {
        if (gone.has(e.id)) downstream(s, e.target).forEach((id) => stale.add(id));
      }
      set({
        ...record(),
        edges: s.edges.filter((e) => !gone.has(e.id)),
        runs: markStale(s.runs, stale),
      });
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
        ...record(),
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
        ...record(),
        nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), node],
      });
      return id;
    },

    completeTools: (toolOf) => {
      const s = get();
      let changed = false;
      const nodes = s.nodes.map((n) => {
        const params = n.data.params;
        if (params.type !== "tool") return n;
        const tool = toolOf(params.tool);
        const complete = tool ? completeToolParams(params, tool) : params;
        if (complete === params) return n;
        changed = true;
        return { ...n, data: { ...n.data, params: complete } };
      });
      if (changed) set({ nodes });
    },

    updateParams: (id, patch) => {
      const s = get();
      const editKey = `${id}:${Object.keys(patch).sort().join(",")}`;
      set({
        // Typing in one field is one Undo step.
        ...(s.editKey === editKey ? {} : { ...record(), editKey }),
        nodes: s.nodes.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } as FlowParams } }
            : n,
        ),
        runs: markStale(s.runs, downstream(s, id)),
      });
    },

    removeNode: (id) => get().removeNodes([id]),

    documentChanged: (rawKey) => {
      const s = get();
      const pin = s.pinnedDocument;
      // The flow's own result in the document: its blocks still read the one before it.
      const docKey = pin && rawKey === pin.adoptedDocKey ? pin.base.key : rawKey;
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
    setPinnedDocument: (pinnedDocument) => set({ pinnedDocument }),

    readDocument: (doc) => {
      const pin = get().pinnedDocument;
      return doc && pin && doc.key === pin.adoptedDocKey ? pin.base : doc;
    },

    checkpoint: () => set(record()),

    undo: () => {
      const s = get();
      if (s.running || s.past.length === 0) return;
      const prev = s.past[s.past.length - 1];
      set({
        ...restore(prev),
        past: s.past.slice(0, -1),
        future: [...s.future, { nodes: s.nodes, edges: s.edges }],
      });
    },

    redo: () => {
      const s = get();
      if (s.running || s.future.length === 0) return;
      const next = s.future[s.future.length - 1];
      set({
        ...restore(next),
        past: pushed(s.past, { nodes: s.nodes, edges: s.edges }),
        future: s.future.slice(0, -1),
      });
    },

    selectNode: (id) =>
      set((s) => ({
        nodes: s.nodes.map((n) =>
          (n.id === id) === !!n.selected ? n : { ...n, selected: n.id === id },
        ),
      })),

    run: async (deps, targets) => {
      const s = get();
      if (s.running) return "busy";
      const controller = new AbortController();
      set({ running: controller, stopping: false });
      // Manual structure blocks read the document through the pin (`readDocument`).
      const runDeps: FlowDeps = { ...deps, document: () => get().readDocument(deps.document()) };
      try {
        const runs = await runFlow({ nodes: s.nodes, edges: s.edges }, runDeps, s.runs, {
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
        set((cur) => (cur.running === controller ? { running: null, stopping: false } : {}));
      }
      return controller.signal.aborted ? "cancelled" : "finished";
    },

    cancel: () => {
      const running = get().running;
      if (!running) return;
      set({ stopping: true });
      running.abort();
    },

    clear: () => {
      get().running?.abort();
      set({
        ...(get().nodes.length > 0 ? record() : {}),
        nodes: [],
        edges: [],
        runs: {},
        running: null,
        stopping: false,
        viewNodeId: null,
        adoptedKey: null,
        pinnedDocument: null,
        fileName: null,
      });
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

    load: (flow, options) => {
      get().running?.abort();
      set({
        ...(options?.history === false ? {} : record()),
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
        pinnedDocument: null,
        stopping: false,
        fileName: options?.name ?? null,
      });
    },

    applyGenerated: (flow, options) => {
      const s = get();
      s.running?.abort();
      const now = new Map(s.nodes.map((n) => [n.id, n]));
      const nodes: FlowNode[] = flow.nodes.map((n) => {
        const cur = now.get(n.id);
        // The same settings keep the same object, so `restore` sees the block unchanged.
        const same = cur && stableStringify(cur.data.params) === stableStringify(n.params);
        return {
          id: n.id,
          type: n.params.type,
          position: { ...n.position },
          data: { params: same ? cur.data.params : n.params },
          ...(cur?.selected ? { selected: true } : {}),
        };
      });
      const edges = flow.edges.map((e) => makeEdge(e.source, e.target, e.targetHandle));
      const checkpoint = options?.checkpoint !== false;
      const id = checkpoint ? ++lastCheckpoint : null;
      set({
        ...(checkpoint
          ? {
              past: pushed(s.past, { nodes: s.nodes, edges: s.edges, generated: id! }),
              future: [],
            }
          : {}),
        ...restore({ nodes, edges }),
        running: null,
        stopping: false,
      });
      return id;
    },

    undoGenerated: (id) => {
      const s = get();
      if (s.running || s.past[s.past.length - 1]?.generated !== id) return false;
      s.undo();
      return true;
    },
  };
};

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
