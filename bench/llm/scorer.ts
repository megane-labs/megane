/**
 * Scorer for the megane LLM (pipeline-generation) benchmark.
 *
 * Given a model's raw response and a per-case rubric, this computes four
 * sub-scores in [0,1] and a weighted total:
 *
 *   1. schema   — structural / schema validity (reuses the production port and
 *                 connection-typing rules from `@/pipeline/types`).
 *   2. task     — task coverage: did the pipeline include the node types,
 *                 connections, and size the request implies?
 *   3. params   — parameter accuracy: are individual node parameters correct
 *                 (filter queries, bond sources, excluded centers, …)?
 *   4. format   — robustness / output-format compliance: fenced JSON-first
 *                 output with a single trailing one-sentence explanation.
 *
 * A dimension with no applicable checks for a case is reported as `null`
 * ("n/a") and excluded from the weighted total, which is renormalised over the
 * dimensions that do apply.
 */

import {
  NODE_PORTS,
  canConnect,
  type PipelineNodeType,
  type SerializedPipeline,
} from "@/pipeline/types";
import { extractPipeline, extractTrailingExplanation, type ExtractionResult } from "./extract";

/** A single serialized node (with id/position/params flattened). */
export type SerializedNode = SerializedPipeline["nodes"][number];

/** One pass/fail check with a human-readable label. */
export interface CheckResult {
  label: string;
  passed: boolean;
}

/** A dimension's outcome: `score` is null when the dimension does not apply. */
export interface DimensionResult {
  score: number | null;
  checks: CheckResult[];
}

// ─── Rubric ───────────────────────────────────────────────────────────

/** A required edge expressed in terms of the node *types* it connects. */
export interface ConnectionReq {
  label?: string;
  sourceType: PipelineNodeType;
  targetType: PipelineNodeType;
  /** Optional output-port name on the source (e.g. "bond"). */
  sourceHandle?: string;
  /** Optional input-port name on the target (e.g. "bond"). */
  targetHandle?: string;
}

/** A predicate over a node selected by type (and optional occurrence index). */
export interface ParamCheck {
  label: string;
  nodeType: PipelineNodeType;
  /** 0-based index among nodes of `nodeType`. Defaults to 0 (the first). */
  index?: number;
  test: (node: SerializedNode) => boolean;
}

/** Per-case grading rubric. Any field may be omitted. */
export interface Rubric {
  requiredNodeTypes?: PipelineNodeType[];
  forbiddenNodeTypes?: PipelineNodeType[];
  requiredConnections?: ConnectionReq[];
  minNodes?: number;
  maxNodes?: number;
  paramChecks?: ParamCheck[];
}

/** Relative weights for the weighted total (renormalised over applicable dims). */
export const DIMENSION_WEIGHTS = {
  schema: 0.35,
  task: 0.35,
  params: 0.15,
  format: 0.15,
} as const;

export type DimensionName = keyof typeof DIMENSION_WEIGHTS;

export interface CaseScore {
  schema: DimensionResult;
  task: DimensionResult;
  params: DimensionResult;
  format: DimensionResult;
  /** Weighted total in [0,1] over the dimensions that apply. */
  total: number;
  /** The pipeline recovered from the response (null when none was valid). */
  pipeline: SerializedPipeline | null;
  /** How the pipeline was recovered + fence accounting. */
  extraction: ExtractionResult;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fraction(checks: CheckResult[]): number {
  if (checks.length === 0) return 1;
  return checks.filter((c) => c.passed).length / checks.length;
}

/** Map node id -> node type for a serialized pipeline. */
function typeById(pipeline: SerializedPipeline): Map<string, PipelineNodeType> {
  const m = new Map<string, PipelineNodeType>();
  for (const n of pipeline.nodes) m.set(n.id, n.type as PipelineNodeType);
  return m;
}

/** Detect a cycle via Kahn's algorithm; true when the graph is acyclic. */
function isAcyclic(pipeline: SerializedPipeline): boolean {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of pipeline.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of pipeline.edges) {
    if (!indeg.has(e.target) || !adj.has(e.source)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return visited === pipeline.nodes.length;
}

/** Every non-viewport node must be an ancestor of a viewport node. */
function allReachToViewport(pipeline: SerializedPipeline): boolean {
  const viewportIds = pipeline.nodes.filter((n) => n.type === "viewport").map((n) => n.id);
  if (viewportIds.length === 0) return false;
  const preds = new Map<string, string[]>();
  for (const n of pipeline.nodes) preds.set(n.id, []);
  for (const e of pipeline.edges) preds.get(e.target)?.push(e.source);
  const visited = new Set(viewportIds);
  const queue = [...viewportIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const p of preds.get(id) ?? []) {
      if (!visited.has(p)) {
        visited.add(p);
        queue.push(p);
      }
    }
  }
  return pipeline.nodes.every((n) => n.type === "viewport" || visited.has(n.id));
}

// ─── Dimension 1: schema / structural validity ────────────────────────

export function scoreSchema(pipeline: SerializedPipeline | null): DimensionResult {
  if (!pipeline) {
    return { score: 0, checks: [{ label: "parses as a v3 pipeline", passed: false }] };
  }

  const types = typeById(pipeline);
  const ids = pipeline.nodes.map((n) => n.id);
  const viewportCount = pipeline.nodes.filter((n) => n.type === "viewport").length;

  const knownTypes = pipeline.nodes.every((n) => (n.type as string) in NODE_PORTS);

  const edgesReferenceExisting = pipeline.edges.every(
    (e) => types.has(e.source) && types.has(e.target),
  );

  // Type-correct edges (only meaningful when endpoints + types are known).
  const edgesTypeValid =
    edgesReferenceExisting &&
    knownTypes &&
    pipeline.edges.every((e) =>
      canConnect(
        types.get(e.source)!,
        e.sourceHandle,
        types.get(e.target)!,
        e.targetHandle,
      ),
    );

  // Nodes that declare inputs must have at least one incoming edge.
  const incoming = new Set(pipeline.edges.map((e) => e.target));
  const requiredInputsConnected =
    knownTypes &&
    pipeline.nodes.every((n) => {
      const ports = NODE_PORTS[n.type as PipelineNodeType];
      return !ports || ports.inputs.length === 0 || incoming.has(n.id);
    });

  const checks: CheckResult[] = [
    { label: "parses as a v3 pipeline", passed: true },
    { label: "exactly one viewport node", passed: viewportCount === 1 },
    { label: "all node ids unique", passed: new Set(ids).size === ids.length },
    { label: "all node types are known", passed: knownTypes },
    { label: "edges reference existing nodes", passed: edgesReferenceExisting },
    { label: "edges connect type-compatible ports", passed: edgesTypeValid },
    { label: "nodes with inputs are connected", passed: requiredInputsConnected },
    { label: "graph is acyclic", passed: isAcyclic(pipeline) },
    { label: "all nodes reach a viewport", passed: allReachToViewport(pipeline) },
  ];

  return { score: fraction(checks), checks };
}

// ─── Dimension 2: task coverage ───────────────────────────────────────

export function scoreTask(pipeline: SerializedPipeline | null, rubric: Rubric): DimensionResult {
  const checks: CheckResult[] = [];
  const present = new Set((pipeline?.nodes ?? []).map((n) => n.type));
  const types = pipeline ? typeById(pipeline) : new Map<string, PipelineNodeType>();

  for (const t of rubric.requiredNodeTypes ?? []) {
    checks.push({ label: `includes a ${t} node`, passed: present.has(t) });
  }
  for (const t of rubric.forbiddenNodeTypes ?? []) {
    checks.push({ label: `omits ${t} node`, passed: !present.has(t) });
  }
  for (const c of rubric.requiredConnections ?? []) {
    const label =
      c.label ??
      `connects ${c.sourceType}${c.sourceHandle ? `(${c.sourceHandle})` : ""} -> ` +
        `${c.targetType}${c.targetHandle ? `(${c.targetHandle})` : ""}`;
    const passed = (pipeline?.edges ?? []).some(
      (e) =>
        types.get(e.source) === c.sourceType &&
        types.get(e.target) === c.targetType &&
        (c.sourceHandle === undefined || e.sourceHandle === c.sourceHandle) &&
        (c.targetHandle === undefined || e.targetHandle === c.targetHandle),
    );
    checks.push({ label, passed });
  }
  if (rubric.minNodes !== undefined) {
    checks.push({
      label: `>= ${rubric.minNodes} nodes`,
      passed: (pipeline?.nodes.length ?? 0) >= rubric.minNodes,
    });
  }
  if (rubric.maxNodes !== undefined) {
    checks.push({
      label: `<= ${rubric.maxNodes} nodes`,
      passed: (pipeline?.nodes.length ?? 0) <= rubric.maxNodes,
    });
  }

  if (checks.length === 0) return { score: null, checks };
  return { score: fraction(checks), checks };
}

// ─── Dimension 3: parameter accuracy ──────────────────────────────────

export function scoreParams(pipeline: SerializedPipeline | null, rubric: Rubric): DimensionResult {
  const paramChecks = rubric.paramChecks ?? [];
  if (paramChecks.length === 0) return { score: null, checks: [] };

  const checks: CheckResult[] = paramChecks.map((pc) => {
    const matches = (pipeline?.nodes ?? []).filter((n) => n.type === pc.nodeType);
    const node = matches[pc.index ?? 0];
    let passed = false;
    if (node) {
      try {
        passed = pc.test(node);
      } catch {
        passed = false;
      }
    }
    return { label: pc.label, passed };
  });

  return { score: fraction(checks), checks };
}

// ─── Dimension 4: format / robustness ─────────────────────────────────

export function scoreFormat(response: string, extraction: ExtractionResult): DimensionResult {
  // No recoverable pipeline at all → the response failed its core contract;
  // partial credit for incidental formatting would be misleading.
  if (!extraction.pipeline) {
    return {
      score: 0,
      checks: [{ label: "emits a valid pipeline in a fenced block", passed: false }],
    };
  }

  const explanation = extractTrailingExplanation(response);
  const looksLikeOneSentence =
    explanation.length > 0 &&
    explanation.length <= 240 &&
    !/\n\s*[-*]\s/.test(explanation) && // no bullet list
    (explanation.match(/[.!?。!?]/g) ?? []).length <= 2;

  const checks: CheckResult[] = [
    { label: "pipeline recovered from a fenced block", passed: extraction.source === "fenced" },
    { label: "no unclosed code fence", passed: !extraction.hasUnclosedFence },
    { label: "at most two fenced blocks", passed: extraction.fenceCount <= 2 },
    { label: "has a trailing explanation", passed: explanation.length > 0 },
    { label: "explanation is a short single sentence", passed: looksLikeOneSentence },
  ];

  return { score: fraction(checks), checks };
}

// ─── Aggregate ────────────────────────────────────────────────────────

/** Score one model response against a rubric. */
export function scoreResponse(response: string, rubric: Rubric): CaseScore {
  const extraction = extractPipeline(response);
  const pipeline = extraction.pipeline;

  const schema = scoreSchema(pipeline);
  const task = scoreTask(pipeline, rubric);
  const params = scoreParams(pipeline, rubric);
  const format = scoreFormat(response, extraction);

  const dims: Array<[DimensionName, DimensionResult]> = [
    ["schema", schema],
    ["task", task],
    ["params", params],
    ["format", format],
  ];

  let weighted = 0;
  let weightSum = 0;
  for (const [name, dim] of dims) {
    if (dim.score === null) continue;
    const w = DIMENSION_WEIGHTS[name];
    weighted += w * dim.score;
    weightSum += w;
  }
  const total = weightSum > 0 ? weighted / weightSum : 0;

  return { schema, task, params, format, total, pipeline, extraction };
}
