/**
 * Running a flow the assistant wrote, the way the Builder runs it.
 *
 * The flow goes through the production engine (`runFlow`) with the case's
 * environment, and what comes out of the output block — the structure Run
 * would make the Manual document — is summarised for grading: how many atoms
 * of which elements, and whether it has a unit cell. That is the ground truth
 * the rubric's other dimensions cannot see: a graph can be well-formed,
 * wired as the rubric asks, and still build carbon monoxide as methanol.
 */

import { ELEMENT_SYMBOLS } from "@/constants";
import { runFlow, topoOrder, type FlowGraph } from "@/builder/flow/engine";
import { outputNodeId, type SerializedFlow } from "@/builder/flow/store";
import type { NodeRun } from "@/builder/flow/types";
import type { Snapshot } from "@/types";
import type { FlowEnvironment, ToolCall } from "./environment";

/** The structure a flow built, in the terms the rubric grades. */
export interface StructureSummary {
  name: string;
  atoms: number;
  /** Atoms per element symbol. */
  elements: Record<string, number>;
  /** The structure has a unit cell. */
  cell: boolean;
  /** Bonds per element pair, symbols sorted (`"C-H"`, `"H-O"`): tells isomers apart. */
  bonds: Record<string, number>;
  /** How close two different molecules come, in Å (`closestContact`); null with only one. */
  closest: number | null;
}

export interface ExecutionResult {
  /** The output block built a structure. */
  built: boolean;
  /** Why it did not: the first failed block (in run order) and its error; null when it did. */
  error: string | null;
  /** The output block's structure, or null when it did not build one. */
  output: StructureSummary | null;
  /** The tool calls the run made, with the arguments it built. */
  calls: ToolCall[];
}

/** How long one flow may run before it counts as failed. */
export const EXECUTION_TIMEOUT_MS = 120_000;

export function summarize(name: string, snapshot: Snapshot): StructureSummary {
  const symbol = (i: number) => ELEMENT_SYMBOLS[snapshot.elements[i]] ?? `Z${snapshot.elements[i]}`;
  const elements: Record<string, number> = {};
  for (let i = 0; i < snapshot.nAtoms; i++) elements[symbol(i)] = (elements[symbol(i)] ?? 0) + 1;
  const bonds: Record<string, number> = {};
  for (let b = 0; b < snapshot.nBonds; b++) {
    const pair = [symbol(snapshot.bonds[2 * b]), symbol(snapshot.bonds[2 * b + 1])]
      .sort()
      .join("-");
    bonds[pair] = (bonds[pair] ?? 0) + 1;
  }
  return {
    name,
    atoms: snapshot.nAtoms,
    elements,
    cell: !!snapshot.box,
    bonds,
    closest: closestContact(snapshot),
  };
}

/**
 * The shortest distance between atoms of two different molecules (sets of
 * atoms joined by bonds; an unbonded atom is one by itself), counting the
 * neighbouring periodic images when there is a cell — an atom's own molecule
 * included, one cell over. Null when nothing qualifies (one molecule and no
 * cell). Molecules placed on top of each other — nine waters laid on a
 * surface cell with room for one — show here and nowhere else in the
 * summary: their atom counts are right.
 */
export function closestContact(snapshot: Snapshot): number | null {
  const n = snapshot.nAtoms;
  const p = snapshot.positions;
  const molecule = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (molecule[i] !== i) i = molecule[i] = molecule[molecule[i]];
    return i;
  };
  for (let b = 0; b < snapshot.nBonds; b++) {
    molecule[find(snapshot.bonds[2 * b])] = find(snapshot.bonds[2 * b + 1]);
  }
  const box = snapshot.box;
  const shifts: number[][] = [[0, 0, 0]];
  if (box) {
    for (const u of [-1, 0, 1])
      for (const v of [-1, 0, 1])
        for (const w of [-1, 0, 1])
          if (u || v || w)
            shifts.push([0, 1, 2].map((k) => u * box[k] + v * box[3 + k] + w * box[6 + k]));
  }
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const sameMolecule = find(i) === find(j);
      const dx = p[3 * j] - p[3 * i];
      const dy = p[3 * j + 1] - p[3 * i + 1];
      const dz = p[3 * j + 2] - p[3 * i + 2];
      // Within a molecule only its images count; an atom and its own image too.
      for (let k = sameMolecule ? 1 : 0; k < shifts.length; k++) {
        const s = shifts[k];
        const d = (dx + s[0]) ** 2 + (dy + s[1]) ** 2 + (dz + s[2]) ** 2;
        if (d < best) best = d;
      }
    }
  }
  return best === Infinity ? null : Math.sqrt(best);
}

/** The graph the engine reads, from a saved flow. */
export function graphOf(flow: SerializedFlow): FlowGraph {
  return {
    nodes: flow.nodes.map((n) => ({ id: n.id, data: { params: n.params } })),
    edges: flow.edges.map((e) => ({
      id: `e-${e.source}-${e.target}-${e.targetHandle}`,
      source: e.source,
      target: e.target,
      targetHandle: e.targetHandle,
    })),
  };
}

/** The first failed block in run order, as "id (type): error". */
function firstError(graph: FlowGraph, runs: Record<string, NodeRun>): string | null {
  const order = topoOrder(graph) ?? graph.nodes.map((n) => n.id);
  const id = order.find((k) => runs[k]?.status === "error");
  if (!id) return null;
  const type = graph.nodes.find((n) => n.id === id)?.data.params.type;
  return `${id} (${type}): ${runs[id].error ?? "failed"}`;
}

/** Run `flow` in `env` and summarise what its output block built. */
export async function executeFlow(
  flow: SerializedFlow,
  env: FlowEnvironment,
  timeoutMs = EXECUTION_TIMEOUT_MS,
): Promise<ExecutionResult> {
  const graph = graphOf(flow);
  const start = env.calls.length;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const runs = await runFlow(
      graph,
      env.deps,
      {},
      {
        signal: controller.signal,
        onUpdate: () => {},
      },
    );
    const calls = env.calls.slice(start);
    if (controller.signal.aborted) {
      return {
        built: false,
        error: `the run took over ${timeoutMs / 1000} s`,
        output: null,
        calls,
      };
    }
    const outputId = outputNodeId(graph as never);
    const run = outputId ? runs[outputId] : undefined;
    if (!run || run.status !== "done" || !run.data) {
      return {
        built: false,
        error: firstError(graph, runs) ?? "no output block",
        output: null,
        calls,
      };
    }
    return { built: true, error: null, output: summarize(run.data.name, run.data.snapshot), calls };
  } catch (err) {
    return {
      built: false,
      error: err instanceof Error ? err.message : String(err),
      output: null,
      calls: env.calls.slice(start),
    };
  } finally {
    clearTimeout(timer);
  }
}
