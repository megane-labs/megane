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
