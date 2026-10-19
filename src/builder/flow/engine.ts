/**
 * Running a Flow graph.
 *
 * Blocks run in dependency order, each once its inputs are done. A block's
 * result is cached under `nodeKey` — its parameters plus its inputs' keys —
 * so a second Run only redoes what changed and what depends on it: change
 * the count of a liquid box and the molecules upstream are not re-embedded;
 * change nothing and nothing runs. A stochastic tool's seed is one of its
 * parameters, so a cached result is the result those parameters give.
 *
 * The built-in blocks (crystal, slab, polymer, …) run in `builtins.ts`.
 * Everything the blocks need from the outside (RDKit, the library, the
 * Manual document, the tool server) comes in through `FlowDeps`, so the
 * engine is plain data in, data out, and tests replace each dependency.
 */

import { applyEditOps } from "../../pipeline/executors/edit";
import type { Snapshot } from "../../types";
import type { LibraryMolecule } from "../library/types";
import { newFragmentId } from "../library/fragment";
import { callTimeoutMs, sanitizeName, type BuilderToolInfo } from "../tools/contract";
import type { CallOptions, CallOutcome } from "../tools/client";
import { buildArguments, validate } from "../tools/form";
import { insertOps, residueLabels, structureToSnapshot } from "../tools/payload";
import { isBuiltin, runBuiltin } from "./builtins";
import { completeToolParams, toolForm, toolPorts, type PortSources } from "./ports";
import {
  IDLE_RUN,
  type FlowData,
  type FlowParams,
  type MoleculeParams,
  type NodeRun,
  type ToolParams,
} from "./types";

/** The graph as the engine reads it (a subset of xyflow's nodes and edges). */
export interface FlowGraph {
  nodes: { id: string; data: { params: FlowParams } }[];
  edges: { id: string; source: string; target: string; targetHandle?: string | null }[];
}

export interface FlowDeps {
  /** Embed a SMILES string in 3D (RDKit) and parse the result. */
  embedSmiles: (smiles: string) => Promise<Snapshot>;
  /** The Builder library (presets and the user's molecules). */
  library: () => LibraryMolecule[];
  /** The structure open in Manual mode and a key that changes with it, or null. */
  document: () => { data: FlowData; key: string } | null;
  /** The connected server's tool of this name, or null when it has none. */
  tool: (name: string) => BuilderToolInfo | null;
  /** Call a tool on the connected server. */
  call: (
    tool: BuilderToolInfo,
    args: Record<string, unknown>,
    options: CallOptions,
  ) => Promise<CallOutcome>;
}

/** JSON with object keys sorted, so equal values always give equal text. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The cache key of a block: its parameters, its inputs' keys per input, and any outside state. */
export function nodeKey(
  params: FlowParams,
  inputKeys: Record<string, string[]>,
  extra: string | null = null,
): string {
  return stableStringify({ params, inputs: inputKeys, extra });
}

/** Upstream block ids per input handle of `nodeId`, in edge order. */
export function incoming(graph: FlowGraph, nodeId: string): PortSources {
  const out: PortSources = {};
  for (const e of graph.edges) {
    if (e.target !== nodeId) continue;
    const handle = e.targetHandle ?? "in";
    (out[handle] ??= []).push(e.source);
  }
  return out;
}

/** Block ids in dependency order, or null when the edges make a cycle. */
export function topoOrder(graph: FlowGraph): string[] | null {
  const ids = graph.nodes.map((n) => n.id);
  const known = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    indegree.set(e.target, indegree.get(e.target)! + 1);
    next.get(e.source)!.push(e.target);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of next.get(id)!) {
      indegree.set(t, indegree.get(t)! - 1);
      if (indegree.get(t) === 0) queue.push(t);
    }
  }
  return order.length === ids.length ? order : null;
}

/** `nodeId` and every block downstream of it. */
export function downstream(graph: FlowGraph, nodeId: string): Set<string> {
  const out = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of graph.edges) {
      if (e.source === id && !out.has(e.target)) {
        out.add(e.target);
        stack.push(e.target);
      }
    }
  }
  return out;
}

/** Whether an edge `source → target` would close a cycle. */
export function wouldCycle(graph: FlowGraph, source: string, target: string): boolean {
  return downstream(graph, target).has(source);
}

/** A Snapshot of a library molecule's geometry (bonds as the library holds them). */
export function libraryMoleculeSnapshot(molecule: LibraryMolecule): Snapshot {
  return structureToSnapshot({
    elements: molecule.elements,
    positions: molecule.positions,
    cell: null,
    bonds: molecule.bonds,
    ...(molecule.bondOrders ? { bondOrders: molecule.bondOrders } : {}),
  });
}

/** Result of one block. */
export interface BlockResult {
  data: FlowData;
  warnings: string[];
  summary: string | null;
}

/** What one block run gets besides its parameters. */
export interface BlockContext {
  sources: PortSources;
  /** Results of the upstream blocks, by block id. */
  inputs: Record<string, FlowData>;
  deps: FlowDeps;
  signal: AbortSignal;
  onProgress: (fraction: number | null, message: string | null) => void;
}

async function runMolecule(params: MoleculeParams, deps: FlowDeps): Promise<BlockResult> {
  if (params.source === "library") {
    const molecule = deps.library().find((m) => m.id === params.libraryId);
    if (!molecule) throw new Error("Choose a molecule from the library.");
    return {
      data: {
        name: params.name.trim() || molecule.name,
        snapshot: libraryMoleculeSnapshot(molecule),
        labels: null,
      },
      warnings: [],
      summary: null,
    };
  }
  const smiles = params.smiles.trim();
  if (!smiles) throw new Error("Enter a SMILES string.");
  const snapshot = await deps.embedSmiles(smiles);
  return {
    data: { name: params.name.trim() || smiles, snapshot, labels: null },
    warnings: [],
    summary: null,
  };
}

/** Labels for `a` followed by `b`; null when neither has any. */
function joinLabels(a: FlowData, b: { n: number; labels: string[] | null }): string[] | null {
  if (!a.labels && !b.labels) return null;
  const fill = (n: number) => Array.from({ length: n }, () => "UNK1");
  return [...(a.labels ?? fill(a.snapshot.nAtoms)), ...(b.labels ?? fill(b.n))];
}

async function runTool(params: ToolParams, ctx: BlockContext): Promise<BlockResult> {
  const tool = ctx.deps.tool(params.tool);
  if (!tool) {
    throw new Error(`Connect to a tool server that offers ${params.label || params.tool}.`);
  }
  const { ports, problem } = toolPorts(tool);
  if (problem) throw new Error(problem);
  params = completeToolParams(params, tool);
  for (const port of ports) {
    if (port.required && (ctx.sources[port.key]?.length ?? 0) === 0) {
      throw new Error(
        `Connect ${port.multiple ? "at least one block" : "a block"} to ${port.label}.`,
      );
    }
  }
  const { ctx: formCtx, values, fields } = toolForm(tool, params, ctx.sources, ctx.inputs);
  const invalid = validate(fields, values, formCtx);
  if (invalid) throw new Error(invalid);
  const outcome = await ctx.deps.call(tool, buildArguments(fields, values, formCtx), {
    signal: ctx.signal,
    timeoutMs: callTimeoutMs(tool.expectedSeconds),
    onProgress: ctx.onProgress,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  const { result, summary } = outcome;
  const structure = result.structure;
  const name = sanitizeName(result.name);
  if (tool.apply === "new_document") {
    return {
      data: { name, snapshot: structureToSnapshot(structure), labels: residueLabels(structure) },
      warnings: result.warnings,
      summary,
    };
  }
  // `insert`: the result's atoms added to the `document` input (§5.2).
  const docPort = ports.find((p) => p.kind === "document");
  const docId = docPort ? ctx.sources[docPort.key]?.[0] : undefined;
  const doc = docId ? ctx.inputs[docId] : undefined;
  if (!doc) throw new Error("Connect the structure to add to.");
  const merged = applyEditOps(
    doc.snapshot,
    insertOps(structure, newFragmentId(result.name), doc.snapshot.box),
  );
  return {
    data: {
      name: doc.name,
      snapshot: merged.snapshot,
      labels: joinLabels(doc, { n: structure.elements.length, labels: residueLabels(structure) }),
    },
    warnings: [...result.warnings, ...merged.warnings],
    summary,
  };
}

/** Run one block. Rejects with the message to show on it. */
export async function runBlock(params: FlowParams, ctx: BlockContext): Promise<BlockResult> {
  switch (params.type) {
    case "molecule":
      return runMolecule(params, ctx.deps);
    case "document": {
      const doc = ctx.deps.document();
      if (!doc) throw new Error("Manual mode has no structure open.");
      return { data: doc.data, warnings: [], summary: null };
    }
    case "tool":
      return runTool(params, ctx);
    default: {
      if (!isBuiltin(params)) throw new Error("Unknown block.");
      const { data, warnings } = await runBuiltin(params, ctx.sources, ctx.inputs, ctx.deps);
      return { data, warnings, summary: null };
    }
  }
}

export interface RunOptions {
  signal: AbortSignal;
  /** Called whenever a block's run state changes. */
  onUpdate: (id: string, run: NodeRun) => void;
  /** Only run what these blocks need (themselves and their upstream); all blocks when omitted. */
  targets?: string[];
}

function upstreamOf(graph: FlowGraph, targets: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...targets];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const e of graph.edges) if (e.target === id) stack.push(e.source);
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the graph. `previous` holds the last runs: a block whose key matches
 * its previous successful run keeps that result without running. Resolves
 * to the new runs of every block (untouched blocks keep their previous run).
 * After an abort, the blocks not yet run keep their previous state.
 */
export async function runFlow(
  graph: FlowGraph,
  deps: FlowDeps,
  previous: Record<string, NodeRun>,
  { signal, onUpdate, targets }: RunOptions,
): Promise<Record<string, NodeRun>> {
  const runs: Record<string, NodeRun> = { ...previous };
  const order = topoOrder(graph);
  if (!order) throw new Error("The blocks are connected in a loop.");
  const wanted = targets ? upstreamOf(graph, targets) : null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const set = (id: string, run: NodeRun) => {
    runs[id] = run;
    onUpdate(id, run);
  };

  for (const id of order) {
    if (signal.aborted) break;
    if (wanted && !wanted.has(id)) continue;
    const params = byId.get(id)!.data.params;
    const sources = incoming(graph, id);
    const inputKeys: Record<string, string[]> = {};
    const inputs: Record<string, FlowData> = {};
    let failed: string | null = null;
    for (const [handle, ids] of Object.entries(sources)) {
      inputKeys[handle] = ids.map((src) => {
        const run = runs[src];
        if (run?.status !== "done" || !run.data || !run.key) failed ??= src;
        else inputs[src] = run.data;
        return run?.key ?? "";
      });
    }
    if (failed) {
      set(id, {
        ...IDLE_RUN,
        status: "error",
        error: "An input block did not produce a structure.",
      });
      continue;
    }
    let extra: string | null = null;
    if (params.type === "document") extra = deps.document()?.key ?? null;
    const key = nodeKey(params, inputKeys, extra);
    const prev = previous[id];
    if (
      prev &&
      prev.key === key &&
      prev.data &&
      (prev.status === "done" || prev.status === "stale")
    ) {
      set(id, { ...prev, status: "done" });
      continue;
    }
    set(id, { ...IDLE_RUN, status: "running", key });
    try {
      const result = await runBlock(params, {
        sources,
        inputs,
        deps,
        signal,
        onProgress: (fraction, msg) => {
          if (runs[id]?.status === "running") set(id, { ...runs[id], fraction, message: msg });
        },
      });
      if (signal.aborted) {
        set(id, prev ?? IDLE_RUN);
        break;
      }
      set(id, {
        ...IDLE_RUN,
        status: "done",
        key,
        data: result.data,
        warnings: result.warnings,
        summary: result.summary,
      });
    } catch (err) {
      if (signal.aborted) {
        set(id, prev ?? IDLE_RUN);
        break;
      }
      set(id, { ...IDLE_RUN, status: "error", key, error: message(err) });
    }
  }
  return runs;
}
