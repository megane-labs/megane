/**
 * Flow benchmark orchestration: generate a reply for every case, run its
 * flow, and score it. Generation and execution are injected, so this module
 * is testable without the network or RDKit — the live runner passes
 * `generateFlowLive` and `executeFlow`, tests pass stubs.
 */

import { environmentFor, type FlowEnvironment } from "./environment";
import type { FlowCaseRecord } from "./report";
import { scoreFlowResponse, type ExecuteFn } from "./scorer";
import type { FlowBenchCase } from "./types";

/**
 * The cases a run covers: those named in `ids` (comma-separated, as
 * `MEGANE_LLM_BENCH_CASES` gives them), or every case when it names none —
 * an unset variable and the empty string CI passes for "all" alike. Throws on
 * an id the dataset does not have, so a typo cannot pass as an empty run.
 */
export function selectCases(cases: FlowBenchCase[], ids: string | undefined): FlowBenchCase[] {
  const wanted = (ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return cases;
  const unknown = wanted.filter((id) => !cases.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case id(s): ${unknown.join(", ")}`);
  return cases.filter((c) => wanted.includes(c.id));
}

/** Produce the assistant's reply to one case in its environment. */
export type FlowGenerateFn = (c: FlowBenchCase, env: FlowEnvironment) => Promise<string>;

export interface FlowRunOptions {
  /** Called after each case completes (for progress logging). */
  onResult?: (record: FlowCaseRecord, index: number, total: number) => void;
  /** Builds a case's environment; `environmentFor` by default. */
  environment?: (c: FlowBenchCase) => FlowEnvironment;
}

/**
 * Run every case: each gets a fresh environment, so tool calls are
 * attributed to the case that made them. A generation error is recorded on
 * the case (scored as an empty reply) so one failure never aborts the run.
 */
export async function runFlowDataset(
  cases: FlowBenchCase[],
  generate: FlowGenerateFn,
  execute: ExecuteFn,
  options: FlowRunOptions = {},
): Promise<FlowCaseRecord[]> {
  const records: FlowCaseRecord[] = [];
  const envFor = options.environment ?? ((c: FlowBenchCase) => environmentFor(c.setup));
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const env = envFor(c);
    const start = Date.now();
    let response = "";
    let error: string | undefined;
    try {
      response = await generate(c, env);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const latencyMs = Date.now() - start;
    const record: FlowCaseRecord = {
      case: c,
      response,
      score: await scoreFlowResponse(response, c, env, execute),
      latencyMs,
      error,
    };
    records.push(record);
    options.onResult?.(record, i, cases.length);
  }
  return records;
}
