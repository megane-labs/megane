/**
 * Scorer for the Flow benchmark: grades one reply of the Builder's Flow
 * assistant on five dimensions, each in [0,1], and a weighted total.
 *
 *   1. schema — the reply holds a flow the Builder can hold, the production
 *               self-check (`collectFlowErrors`) finds nothing in it, and it
 *               ends in one output block every block feeds.
 *   2. task   — the blocks, tools and wires the request implies are there;
 *               for an edit, the blocks it did not ask to touch are kept.
 *   3. params — block settings the request pins (Miller indices, counts, a
 *               repeat unit, a lattice constant), and unchanged blocks left
 *               as they were.
 *   4. result — the flow is run with the production engine (`execute.ts`)
 *               and what its output block builds is checked: atoms of which
 *               elements, a unit cell, the arguments of the tool calls. The
 *               ground truth the other dimensions cannot see.
 *   5. format — fenced JSON first, then one short sentence.
 *
 * Everything is graded on the flow as the Builder would apply it: settings
 * the model left out take the blocks' defaults (`prepareGeneratedFlow`),
 * exactly as `FlowChatBox` installs it. A case whose right answer is prose
 * (a request that needs a tool server when none is connected) is graded on
 * that instead. A dimension with no checks is n/a (null) and left out of the
 * total, which is renormalised over the rest.
 */

import { hasClosedFence } from "@/ai/generation";
import { stableStringify } from "@/builder/flow/engine";
import {
  collectFlowErrors,
  prepareGeneratedFlow,
  tryExtractFlow,
  type RawFlow,
} from "@/builder/flow/ai/check";
import type { SerializedFlow } from "@/builder/flow/store";
import type { FlowNodeType, FlowParams } from "@/builder/flow/types";
import { extractTrailingExplanation } from "../llm/extract";
import type { FlowEnvironment } from "./environment";
import type { ExecutionResult } from "./execute";
import type { FlowBenchCase } from "./types";

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

/** A wire the answer must have, by the types of the blocks it joins. */
export interface WireReq {
  from: FlowNodeType;
  to: FlowNodeType;
  /** The input it goes into on `to`; any input when omitted. */
  input?: string;
  label?: string;
}

/** A setting check: passes when ANY block of `block`'s type satisfies `test`. */
export interface BlockCheck {
  label: string;
  block: FlowNodeType;
  test: (params: FlowParams) => boolean;
}

/** A check on what running the flow did. */
export interface ResultCheck {
  label: string;
  test: (run: ExecutionResult) => boolean;
}

/** A check on a reply in prose. */
export interface ProseCheck {
  label: string;
  test: (text: string) => boolean;
}

/** Per-case grading rubric. Every field may be omitted. */
export interface FlowRubric {
  /**
   * The right answer is prose, not a flow (e.g. a packed box asked for with
   * no tool server connected); these check what it says.
   */
  prose?: ProseCheck[];
  requiredBlocks?: FlowNodeType[];
  /** Tool blocks the answer needs, by tool name. */
  requiredTools?: string[];
  forbiddenBlocks?: FlowNodeType[];
  requiredWires?: WireReq[];
  minBlocks?: number;
  maxBlocks?: number;
  /** Blocks of the edited flow the answer keeps (same id, same type). */
  keeps?: string[];
  /** Blocks of the edited flow whose settings must not change. */
  unchanged?: string[];
  params?: BlockCheck[];
  /** Checks on the run, after "the output block builds a structure". */
  result?: ResultCheck[];
}

/** Relative weights of the total (renormalised over the dimensions that apply). */
export const FLOW_DIMENSION_WEIGHTS = {
  schema: 0.2,
  task: 0.25,
  params: 0.15,
  result: 0.3,
  format: 0.1,
} as const;

export type FlowDimension = keyof typeof FLOW_DIMENSION_WEIGHTS;

export const FLOW_DIMENSIONS = Object.keys(FLOW_DIMENSION_WEIGHTS) as FlowDimension[];

export interface FlowCaseScore {
  schema: DimensionResult;
  task: DimensionResult;
  params: DimensionResult;
  result: DimensionResult;
  format: DimensionResult;
  /** Weighted total in [0,1] over the dimensions that apply. */
  total: number;
  /** The flow as the Builder would apply it, or null when the reply holds none it can hold. */
  flow: SerializedFlow | null;
  /** What the production self-check found in the reply's flow. */
  findings: string[];
  /** What running the flow did, or null when it was not run. */
  run: ExecutionResult | null;
}

function dimension(checks: CheckResult[]): DimensionResult {
  if (checks.length === 0) return { score: null, checks };
  return { score: checks.filter((c) => c.passed).length / checks.length, checks };
}

/** Blocks that no wire leaves: a well-formed flow has exactly one, its output. */
function sinks(flow: SerializedFlow): string[] {
  const feeds = new Set(flow.edges.map((e) => e.source));
  return flow.nodes.filter((n) => !feeds.has(n.id)).map((n) => n.id);
}

function safe<T>(test: (x: T) => boolean, x: T): boolean {
  try {
    return test(x);
  } catch {
    return false;
  }
}

export function scoreSchema(
  raw: RawFlow | null,
  flow: SerializedFlow | null,
  findings: string[],
): DimensionResult {
  return dimension([
    { label: "the reply holds a flow in a fenced block", passed: raw !== null },
    { label: "every block and wire can be held", passed: flow !== null },
    {
      label: "the self-check finds nothing",
      passed: raw !== null && flow !== null && findings.length === 0,
    },
    {
      label: "one output block, which every block feeds",
      passed: flow !== null && sinks(flow).length === 1,
    },
  ]);
}

export function scoreTask(
  flow: SerializedFlow | null,
  rubric: FlowRubric,
  initial?: SerializedFlow,
): DimensionResult {
  const nodes = flow?.nodes ?? [];
  const types = new Map(nodes.map((n) => [n.id, n.params.type]));
  const checks: CheckResult[] = [];
  // With no flow every check fails, the "has no X" and "at most N" ones included.
  const has = flow !== null;
  for (const t of rubric.requiredBlocks ?? []) {
    checks.push({ label: `includes a ${t} block`, passed: nodes.some((n) => n.params.type === t) });
  }
  for (const name of rubric.requiredTools ?? []) {
    checks.push({
      label: `calls the ${name} tool`,
      passed: nodes.some((n) => n.params.type === "tool" && n.params.tool === name),
    });
  }
  for (const t of rubric.forbiddenBlocks ?? []) {
    checks.push({
      label: `has no ${t} block`,
      passed: has && !nodes.some((n) => n.params.type === t),
    });
  }
  for (const w of rubric.requiredWires ?? []) {
    checks.push({
      label: w.label ?? `wires ${w.from} → ${w.to}${w.input ? ` (${w.input})` : ""}`,
      passed: (flow?.edges ?? []).some(
        (e) =>
          types.get(e.source) === w.from &&
          types.get(e.target) === w.to &&
          (w.input === undefined || e.targetHandle === w.input),
      ),
    });
  }
  if (rubric.minBlocks !== undefined) {
    checks.push({
      label: `>= ${rubric.minBlocks} blocks`,
      passed: nodes.length >= rubric.minBlocks,
    });
  }
  if (rubric.maxBlocks !== undefined) {
    checks.push({
      label: `<= ${rubric.maxBlocks} blocks`,
      passed: has && nodes.length <= rubric.maxBlocks,
    });
  }
  for (const id of rubric.keeps ?? []) {
    const type = initial?.nodes.find((n) => n.id === id)?.params.type;
    checks.push({
      label: `keeps block ${id} (${type})`,
      passed: type !== undefined && types.get(id) === type,
    });
  }
  return dimension(checks);
}

export function scoreParams(
  flow: SerializedFlow | null,
  rubric: FlowRubric,
  initial?: SerializedFlow,
): DimensionResult {
  const nodes = flow?.nodes ?? [];
  const checks: CheckResult[] = (rubric.params ?? []).map((c) => ({
    label: c.label,
    passed: nodes.some((n) => n.params.type === c.block && safe(c.test, n.params)),
  }));
  for (const id of rubric.unchanged ?? []) {
    const before = initial?.nodes.find((n) => n.id === id);
    const after = nodes.find((n) => n.id === id);
    checks.push({
      label: `leaves ${id} (${before?.params.type}) as it was`,
      passed:
        !!before && !!after && stableStringify(before.params) === stableStringify(after.params),
    });
  }
  return dimension(checks);
}

export function scoreResult(run: ExecutionResult | null, rubric: FlowRubric): DimensionResult {
  return dimension([
    { label: "the output block builds a structure", passed: run?.built ?? false },
    ...(rubric.result ?? []).map((c) => ({
      label: c.label,
      passed: run !== null && safe(c.test, run),
    })),
  ]);
}

/** Fence accounting of a reply. */
function fences(response: string): { count: number; unclosed: boolean } {
  const markers = (response.match(/```/g) ?? []).length;
  return { count: Math.floor(markers / 2), unclosed: markers % 2 !== 0 };
}

export function scoreFormat(response: string, raw: RawFlow | null): DimensionResult {
  if (!raw) {
    return dimension([{ label: "the reply holds a flow in a fenced block", passed: false }]);
  }
  const { count, unclosed } = fences(response);
  const explanation = extractTrailingExplanation(response);
  const oneSentence =
    explanation.length > 0 &&
    explanation.length <= 240 &&
    !/\n\s*[-*]\s/.test(explanation) &&
    (explanation.match(/[.!?。！？]/g) ?? []).length <= 2;
  return dimension([
    { label: "the reply holds a flow in a fenced block", passed: true },
    { label: "no unclosed code fence", passed: !unclosed },
    { label: "at most two fenced blocks", passed: count <= 2 },
    { label: "has a trailing explanation", passed: explanation.length > 0 },
    { label: "explanation is a short single sentence", passed: oneSentence },
  ]);
}

/** Longest a reply in prose may be and still count as the one or two sentences asked for. */
const MAX_PROSE_LENGTH = 600;

function scoreProse(response: string, rubric: FlowRubric): Pick<FlowCaseScore, "task" | "format"> {
  const text = response.trim();
  return {
    task: dimension(
      (rubric.prose ?? []).map((c) => ({ label: c.label, passed: safe(c.test, text) })),
    ),
    format: dimension([
      {
        label: "answers in prose, with no flow",
        passed: text.length > 0 && !tryExtractFlow(text) && !hasClosedFence(text),
      },
      {
        label: `is at most ${MAX_PROSE_LENGTH} characters`,
        passed: text.length <= MAX_PROSE_LENGTH,
      },
    ]),
  };
}

function total(dims: Record<FlowDimension, DimensionResult>): number {
  let weighted = 0;
  let weights = 0;
  for (const name of FLOW_DIMENSIONS) {
    const score = dims[name].score;
    if (score === null) continue;
    weighted += FLOW_DIMENSION_WEIGHTS[name] * score;
    weights += FLOW_DIMENSION_WEIGHTS[name];
  }
  return weights > 0 ? weighted / weights : 0;
}

const NONE: DimensionResult = { score: null, checks: [] };

/** Runs a prepared flow; `executeFlow` live, a stub in tests. */
export type ExecuteFn = (flow: SerializedFlow, env: FlowEnvironment) => Promise<ExecutionResult>;

/** Score one reply to `c`, running its flow in `env` with `execute`. */
export async function scoreFlowResponse(
  response: string,
  c: FlowBenchCase,
  env: FlowEnvironment,
  execute: ExecuteFn,
): Promise<FlowCaseScore> {
  if (c.rubric.prose) {
    const { task, format } = scoreProse(response, c.rubric);
    const dims = { schema: NONE, task, params: NONE, result: NONE, format };
    return { ...dims, total: total(dims), flow: null, findings: [], run: null };
  }
  const raw = tryExtractFlow(response);
  const flow = raw ? prepareGeneratedFlow(raw, env.prompt) : null;
  const findings = raw && flow ? collectFlowErrors(raw, env.prompt) : [];
  const run = flow ? await execute(flow, env) : null;
  const dims = {
    schema: scoreSchema(raw, flow, findings),
    task: scoreTask(flow, c.rubric, c.setup.flow),
    params: scoreParams(flow, c.rubric, c.setup.flow),
    result: scoreResult(run, c.rubric),
    format: scoreFormat(response, raw),
  };
  return { ...dims, total: total(dims), flow, findings, run };
}
