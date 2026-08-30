/**
 * Self-check for LLM-generated pipelines — the layer between "the JSON parses"
 * and "the pipeline actually shows what the user asked for".
 *
 * `pipelineSchema.ts` checks the *shape* of the graph (known node types, one
 * viewport, edges that reference real nodes) and `validatePipeline.ts` checks
 * the selection-DSL *syntax*. Both can pass while the pipeline still renders
 * the wrong thing, because the failures that survive them are semantic:
 *
 *   - an edge whose ports type-check individually but carry incompatible data
 *     (`particle` into a `bond` port) — the executor silently drops it;
 *   - two `filter` branches that both reach the viewport and overlap, so the
 *     shared atoms are drawn twice (the "hide the water" bug the system prompt
 *     warns about three separate times);
 *   - a syntactically valid query that matches zero atoms because the model
 *     invented a resname the structure doesn't carry;
 *   - a node whose upstream never produces data, so nothing renders at all.
 *
 * The first two are found statically. The rest are found by *running* the
 * candidate pipeline through the real executor against the structure the user
 * currently has loaded and reading back the same `nodeErrors` / `ViewportState`
 * the viewport itself consumes — so the check sees exactly what would be drawn,
 * not a re-implementation of it. Findings are phrased as instructions to the
 * model and fed back through the repair round trip in `client.ts`.
 */

import type { Snapshot } from "../types";
import type { SerializedPipeline, PipelineNodeType } from "../pipeline/types";
import { NODE_PORTS, NODE_TYPE_LABELS, canConnect } from "../pipeline/types";
import type { PipelineExecutionContext } from "../pipeline/execute";
import { executePipeline } from "../pipeline/execute";
import { deserializePipeline } from "../pipeline/serialize";
import { validatePipeline } from "../pipeline/validate";
import { evaluateSelection } from "../pipeline/selection";

/**
 * The execution context the checks run against — the same fields the pipeline
 * store feeds `executePipeline`, narrowed to what a candidate pipeline can use.
 * `snapshot` doubles as the "is a structure loaded?" switch: without it the
 * runtime checks are skipped, because a pipeline that renders nothing when
 * nothing is loaded is correct, not broken.
 */
export type SelfCheckContext = Pick<
  PipelineExecutionContext,
  "snapshot" | "atomLabels" | "structureFrames" | "structureMeta"
>;

/** Node types that pass a particle stream through without changing membership. */
const PARTICLE_PASSTHROUGH: ReadonlySet<string> = new Set([
  "filter",
  "modify",
  "color",
  "representation",
  "symmetry",
  "wrap",
  "replicate",
  "drawing_boundary",
  "boundary_completion",
]);

/** `validatePipeline` findings already reported by `collectQueryErrors`. */
const QUERY_SYNTAX_PREFIX = "Query syntax error";

/**
 * Node types with no output ports: the graph's legitimate sinks. That is the
 * viewport, and `spectrum_plot`, which draws into its own node body rather than
 * the 3D scene. A stream that ends at either of these has arrived somewhere.
 */
const SINK_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.entries(NODE_PORTS)
    .filter(([, ports]) => ports.outputs.length === 0)
    .map(([type]) => type),
);

// ─── Edge typing ─────────────────────────────────────────────────────

/** Render a node's ports as `name (type)` for an error message. */
function describePorts(type: PipelineNodeType, direction: "inputs" | "outputs"): string {
  const ports = NODE_PORTS[type][direction];
  if (ports.length === 0) return "none";
  return ports.map((p) => `${p.name} (${p.dataType})`).join(", ");
}

/**
 * Report every edge whose source output cannot legally drive its target input.
 * `canConnect` is the exact predicate the editor enforces when a user drags a
 * connection, so an edge that fails here is one the UI would have refused —
 * the executor just drops it silently, leaving the downstream node with no data.
 */
export function collectEdgeTypeErrors(pipeline: SerializedPipeline): string[] {
  const errors: string[] = [];
  const typeById = new Map<string, string>();
  for (const node of pipeline.nodes) {
    if (typeof node.id === "string" && typeof node.type === "string") {
      typeById.set(node.id, node.type);
    }
  }

  for (const edge of pipeline.edges) {
    const sourceType = typeById.get(edge.source);
    const targetType = typeById.get(edge.target);
    // Unknown ids / types are already reported by collectSchemaErrors.
    if (!sourceType || !targetType) continue;
    if (!(sourceType in NODE_PORTS) || !(targetType in NODE_PORTS)) continue;

    const s = sourceType as PipelineNodeType;
    const t = targetType as PipelineNodeType;
    if (canConnect(s, edge.sourceHandle, t, edge.targetHandle)) continue;

    errors.push(
      `edge "${edge.source}".${edge.sourceHandle} -> "${edge.target}".${edge.targetHandle}: ` +
        `incompatible ports. ${NODE_TYPE_LABELS[s]} outputs: ${describePorts(s, "outputs")}; ` +
        `${NODE_TYPE_LABELS[t]} inputs: ${describePorts(t, "inputs")}.`,
    );
  }

  return errors;
}

// ─── Overlapping viewport branches ───────────────────────────────────

/** One particle path from a `load_structure` node to the viewport. */
interface ParticleBranch {
  /** Node feeding the viewport (the last node on the path). */
  endId: string;
  /** The `load_structure` ancestor, or null when the path could not be traced. */
  loaderId: string | null;
  /** `filter` queries applied along the path, source-order irrelevant. */
  queries: string[];
}

/**
 * Trace one viewport-bound particle edge back to its `load_structure` ancestor,
 * collecting the `filter` queries applied on the way.
 *
 * Walks only linear chains: a node fed by more than one particle edge merges
 * two streams, which this check can't reason about, so the trace gives up and
 * reports `loaderId: null` (the branch is then excluded from overlap testing
 * rather than guessed at).
 */
function traceParticleBranch(
  startId: string,
  nodeById: Map<string, { type: string; query?: unknown }>,
  incoming: Map<string, { source: string; targetHandle: string }[]>,
): ParticleBranch {
  const queries: string[] = [];
  const seen = new Set<string>();
  let currentId: string | null = startId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const node = nodeById.get(currentId);
    if (!node) break;

    if (node.type === "load_structure") {
      return { endId: startId, loaderId: currentId, queries };
    }
    if (!PARTICLE_PASSTHROUGH.has(node.type)) break;
    if (node.type === "filter" && typeof node.query === "string" && node.query.trim() !== "") {
      queries.push(node.query);
    }

    // Follow the single particle-bearing input; anything else ends the trace.
    const feeds: { source: string; targetHandle: string }[] = (
      incoming.get(currentId) ?? []
    ).filter((e) => e.targetHandle !== "cell");
    if (feeds.length !== 1) break;
    currentId = feeds[0].source;
  }

  return { endId: startId, loaderId: null, queries };
}

/**
 * Intersect a running selection with another. `null` on the left means "every
 * atom so far", so the result is simply the right-hand side.
 */
function intersectSelection(current: Set<number> | null, next: Set<number>): Set<number> {
  if (current === null) return new Set(next);
  const out = new Set<number>();
  for (const index of next) {
    if (current.has(index)) out.add(index);
  }
  return out;
}

/** How many atoms two branch selections share (`null` meaning "every atom"). */
function sharedAtomCount(a: Set<number> | null, b: Set<number> | null, nAtoms: number): number {
  if (a === null && b === null) return nAtoms;
  if (a === null) return b!.size;
  if (b === null) return a.size;
  return intersectSelection(a, b).size;
}

/**
 * Resolve a branch's effective atom selection against a loaded structure.
 * Returns `null` for "every atom" (no filters, or every filter selects all),
 * or the intersection of its filter queries. An unparsable query aborts the
 * resolution (`undefined`) — `collectQueryErrors` reports it separately, and
 * guessing at its membership here would produce a bogus overlap claim.
 */
function resolveBranchSelection(
  branch: ParticleBranch,
  snapshot: Snapshot,
  atomLabels: string[] | null,
): Set<number> | null | undefined {
  let selection: Set<number> | null = null;
  for (const query of branch.queries) {
    let matched: Set<number> | null;
    try {
      matched = evaluateSelection(query, snapshot, atomLabels);
    } catch {
      return undefined;
    }
    if (matched === null) continue; // this filter selects everything
    selection = intersectSelection(selection, matched);
  }
  return selection;
}

/**
 * Report pairs of particle branches that deliver the *same* atoms to the
 * viewport. Overlapping branches render on top of each other, which is how
 * "hide the water" silently fails: the model fades one branch to `opacity: 0`
 * but also leaves the unfiltered structure connected, so the water is redrawn
 * at full opacity through the second path.
 *
 * With a structure loaded the overlap is computed exactly (evaluating each
 * branch's filters); without one, only the unmistakable case is reported — a
 * branch with no filters at all shares every atom with any other branch off the
 * same loader.
 */
export function collectOverlapErrors(
  pipeline: SerializedPipeline,
  ctx: SelfCheckContext = {},
): string[] {
  const nodeById = new Map<string, { type: string; query?: unknown }>();
  for (const node of pipeline.nodes) {
    const n = node as { id?: unknown; type?: unknown; query?: unknown };
    if (typeof n.id === "string" && typeof n.type === "string") {
      nodeById.set(n.id, { type: n.type, query: n.query });
    }
  }

  const incoming = new Map<string, { source: string; targetHandle: string }[]>();
  for (const edge of pipeline.edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target)!.push({ source: edge.source, targetHandle: edge.targetHandle });
  }

  const viewportIds = [...nodeById.entries()]
    .filter(([, n]) => n.type === "viewport")
    .map(([id]) => id);

  const branches: ParticleBranch[] = [];
  for (const viewportId of viewportIds) {
    for (const edge of incoming.get(viewportId) ?? []) {
      if (edge.targetHandle !== "particle") continue;
      branches.push(traceParticleBranch(edge.source, nodeById, incoming));
    }
  }

  const snapshot = ctx.snapshot ?? null;
  const atomLabels = ctx.atomLabels ?? null;
  const errors: string[] = [];

  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const a = branches[i];
      const b = branches[j];
      // Different structures never overlap; an untraceable branch is skipped.
      if (!a.loaderId || a.loaderId !== b.loaderId) continue;

      if (!snapshot) {
        // No data to intersect: only an entirely unfiltered branch is provably
        // overlapping, since it carries every atom the other one can select.
        if (a.queries.length === 0 || b.queries.length === 0) {
          const open = a.queries.length === 0 ? a : b;
          const other = open === a ? b : a;
          errors.push(
            `nodes "${open.endId}" and "${other.endId}" both send atoms of "${a.loaderId}" to the ` +
              `viewport, and "${open.endId}" is not filtered — the atoms selected by ` +
              `"${other.endId}" are drawn twice. Route the remainder through a second filter ` +
              `with the complementary query instead of connecting the unfiltered stream.`,
          );
        }
        continue;
      }

      const selA = resolveBranchSelection(a, snapshot, atomLabels);
      const selB = resolveBranchSelection(b, snapshot, atomLabels);
      if (selA === undefined || selB === undefined) continue;

      const shared = sharedAtomCount(selA, selB, snapshot.nAtoms);
      if (shared === 0) continue;

      errors.push(
        `nodes "${a.endId}" and "${b.endId}" both send atoms of "${a.loaderId}" to the viewport ` +
          `and their selections overlap by ${shared} atom(s), so those atoms are drawn twice. ` +
          `Make the two branches disjoint (e.g. \`resname == "HOH"\` and \`resname != "HOH"\`).`,
      );
    }
  }

  return errors;
}

// ─── Runtime execution ───────────────────────────────────────────────

/**
 * Execution warnings worth reporting back to the model.
 *
 * The executor's other warnings all reduce to "a file the user has not opened
 * yet is missing" — every AI-generated pipeline sets `fileName: null` because
 * the user loads files separately, so `No volumetric data loaded` and the
 * `No input data (check upstream nodes)` cascade it triggers downstream say
 * nothing about the pipeline's quality. Reporting them would send the model
 * chasing a problem it cannot fix, which is worse than not checking at all.
 *
 * Everything listed here can only fire when the data *is* present and the
 * pipeline asks it for something it cannot give — a genuine modelling mistake.
 * Truly unwired nodes are still caught, by `validatePipeline`'s structural
 * `No input connected` error rather than by the runtime cascade.
 */
const REPORTED_RUNTIME_WARNINGS: readonly string[] = [
  "Filter returned 0 atoms",
  "No bonds found",
  "No coordination pairs found",
  "Coordination has no hull with at least four neighbor sites",
  "Particle and bond inputs are both required",
  "Symmetry expansion requires a unit cell",
  "Symmetry expansion skipped: trajectory input present",
  "Wrap / Unwrap requires a unit cell",
  "Replicate requires a unit cell",
  "Drawing Boundary requires a unit cell",
];

/**
 * Report authored nodes whose output arrives nowhere.
 *
 * `validatePipeline` has its own version of this, but it walks back from
 * viewports only, so it condemns a perfectly good `load_spectrum ->
 * spectrum_plot` chain — and it files the finding as a warning, which the
 * severity filter drops. This walks back from every *sink* (any node type with
 * no output ports) instead, which is the honest question: does this node's work
 * end up anywhere at all? A node that fails it is dead weight — the executor
 * runs it and discards the result — and the prompt benchmark grades it as a
 * structural defect.
 *
 * The walk runs on the deserialized graph, so the edges normalization adds are
 * counted; a loader the model left dangling is connected by then and correctly
 * not reported.
 */
function collectDeadEndErrors(
  graph: ReturnType<typeof deserializePipeline>,
  authored: Set<unknown>,
): string[] {
  const sinkIds = graph.nodes.filter((n) => SINK_NODE_TYPES.has(n.type ?? "")).map((n) => n.id);
  // No sink at all is "pipeline has no viewport", which the schema check owns.
  if (sinkIds.length === 0) return [];

  const predecessors = new Map<string, string[]>();
  for (const node of graph.nodes) predecessors.set(node.id, []);
  for (const edge of graph.edges) predecessors.get(edge.target)?.push(edge.source);

  const reaches = new Set(sinkIds);
  const queue = [...sinkIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const previous of predecessors.get(id) ?? []) {
      if (reaches.has(previous)) continue;
      reaches.add(previous);
      queue.push(previous);
    }
  }

  return graph.nodes
    .filter((n) => authored.has(n.id) && !reaches.has(n.id))
    .map(
      (n) =>
        `node "${n.id}": its output reaches nothing — no path leads from it to the viewport, ` +
        `so the node has no effect. Connect it downstream or remove it.`,
    );
}

/**
 * Run the candidate pipeline and report what the executor complained about.
 *
 * Graph-level problems (`No input connected`, `Cycle detected`) come from the
 * same `validatePipeline` the editor shows in the node UI; per-node runtime
 * findings come from the execution itself, filtered to
 * {@link REPORTED_RUNTIME_WARNINGS}. Query-syntax findings are dropped because
 * `collectQueryErrors` already reports them with a better message.
 *
 * Only findings against nodes the *model actually wrote* are reported.
 * `deserializePipeline` normalizes the graph on the way in — it injects an
 * `add_bond` node and wires the loader's cell/particle/trajectory outputs to
 * the viewport when the author left them out — so the executed graph is a
 * superset of the authored one. Asking the model to fix a node the deserializer
 * added for it would be both confusing and impossible to satisfy.
 *
 * Execution is skipped when no structure is loaded — there is nothing to run
 * the graph against, and every node would report missing data for reasons that
 * have nothing to do with the pipeline's quality.
 */
export function collectRuntimeErrors(
  pipeline: SerializedPipeline,
  ctx: SelfCheckContext = {},
): string[] {
  let graph: ReturnType<typeof deserializePipeline>;
  try {
    graph = deserializePipeline(pipeline);
  } catch (e) {
    return [`pipeline could not be loaded: ${(e as Error).message}`];
  }

  const authored = new Set(
    pipeline.nodes.map((n) => (n as { id?: unknown }).id).filter((id) => typeof id === "string"),
  );

  const errors: string[] = [];
  for (const [nodeId, nodeErrors] of validatePipeline(graph.nodes, graph.edges)) {
    if (!authored.has(nodeId)) continue;
    for (const err of nodeErrors) {
      if (err.severity !== "error") continue;
      if (err.message.startsWith(QUERY_SYNTAX_PREFIX)) continue;
      errors.push(`node "${nodeId}": ${err.message}`);
    }
  }
  errors.push(...collectDeadEndErrors(graph, authored));

  if (!ctx.snapshot) return errors;

  try {
    const { nodeErrors } = executePipeline(graph.nodes, graph.edges, ctx);
    for (const [nodeId, list] of nodeErrors) {
      if (!authored.has(nodeId)) continue;
      for (const err of list) {
        if (!REPORTED_RUNTIME_WARNINGS.includes(err.message)) continue;
        errors.push(`node "${nodeId}": ${err.message} (reported when the pipeline was run)`);
      }
    }
  } catch (e) {
    errors.push(`running the pipeline threw: ${(e as Error).message}`);
  }

  return errors;
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Every semantic problem with a candidate pipeline, as messages addressed to
 * the model. An empty array means the pipeline type-checks, draws each atom
 * once, and runs clean against the structure the user has loaded.
 */
export function collectSelfCheckErrors(
  pipeline: SerializedPipeline,
  ctx: SelfCheckContext = {},
): string[] {
  return [
    ...collectEdgeTypeErrors(pipeline),
    ...collectOverlapErrors(pipeline, ctx),
    ...collectRuntimeErrors(pipeline, ctx),
  ];
}
