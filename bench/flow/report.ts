/**
 * Aggregation and report rendering for the Flow benchmark: a JSON record in
 * the same shape as the pipeline benchmark's (`bench/llm/report.ts`), so
 * `bench/llm/compare-results.mjs` diffs either, plus a Markdown summary.
 */

import { FLOW_DIMENSIONS, type FlowCaseScore, type FlowDimension } from "./scorer";
import type { FlowBenchCase } from "./types";

/** One case's full outcome. */
export interface FlowCaseRecord {
  case: FlowBenchCase;
  /** The assistant's final reply. */
  response: string;
  score: FlowCaseScore;
  /** Wall-clock latency of the generation in ms. */
  latencyMs?: number;
  /** Repair rounds the self-check triggered (0 = the first reply stood). */
  repairRounds?: number;
  /** Set when generation threw instead of returning text. */
  error?: string;
}

export interface FlowAggregate {
  count: number;
  meanTotal: number;
  /** Fraction of cases scoring >= `passThreshold`. */
  passRate: number;
  passThreshold: number;
  byDimension: Record<FlowDimension, number>;
  byTag: Record<string, { count: number; meanTotal: number }>;
  /** Fraction of flow cases whose output block built a structure. */
  buildRate: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function aggregateFlow(records: FlowCaseRecord[], passThreshold = 0.8): FlowAggregate {
  const tagTotals: Record<string, number[]> = {};
  for (const r of records) {
    for (const tag of r.case.tags) (tagTotals[tag] ??= []).push(r.score.total);
  }
  const byTag = Object.fromEntries(
    Object.entries(tagTotals).map(([tag, totals]) => [
      tag,
      { count: totals.length, meanTotal: mean(totals) },
    ]),
  );
  const byDimension = Object.fromEntries(
    FLOW_DIMENSIONS.map((d) => [
      d,
      mean(records.map((r) => r.score[d].score).filter((s): s is number => s !== null)),
    ]),
  ) as Record<FlowDimension, number>;
  const flowCases = records.filter((r) => !r.case.rubric.prose);
  return {
    count: records.length,
    meanTotal: mean(records.map((r) => r.score.total)),
    passRate: records.length
      ? records.filter((r) => r.score.total >= passThreshold).length / records.length
      : 0,
    passThreshold,
    byDimension,
    byTag,
    buildRate: flowCases.length
      ? flowCases.filter((r) => r.score.run?.built).length / flowCases.length
      : 0,
  };
}

export interface FlowReportMeta {
  /** Which benchmark wrote the report (`compare-results.mjs` titles the comment with it). */
  bench: "flow";
  provider: string;
  model: string;
  timestamp: string;
}

/** The checks a record failed, as `dimension: label`. */
function failedChecks(r: FlowCaseRecord): string[] {
  return FLOW_DIMENSIONS.flatMap((d) =>
    r.score[d].checks.filter((c) => !c.passed).map((c) => `${d}: ${c.label}`),
  );
}

/** Full JSON report payload. */
export function flowToJSON(meta: FlowReportMeta, records: FlowCaseRecord[], agg: FlowAggregate) {
  return {
    meta,
    aggregate: agg,
    cases: records.map((r) => ({
      id: r.case.id,
      tags: r.case.tags,
      prompt: r.case.prompt,
      total: r.score.total,
      dimensions: Object.fromEntries(FLOW_DIMENSIONS.map((d) => [d, r.score[d].score])),
      failedChecks: failedChecks(r),
      // What the self-check still found and what the run built or why it
      // failed: the two things a score cannot say on its own.
      findings: r.score.findings,
      built: r.score.run?.output ?? null,
      runError: r.score.run?.error ?? null,
      latencyMs: r.latencyMs,
      repairRounds: r.repairRounds,
      response: r.response,
      error: r.error,
    })),
  };
}

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

/** Render a Markdown summary. */
export function flowToMarkdown(
  meta: FlowReportMeta,
  records: FlowCaseRecord[],
  agg: FlowAggregate,
): string {
  const lines: string[] = [
    "# Megane Builder Flow benchmark",
    "",
    `- **provider**: ${meta.provider}`,
    `- **model**: ${meta.model}`,
    `- **timestamp**: ${meta.timestamp}`,
    `- **cases**: ${agg.count}`,
    `- **mean total**: ${pct(agg.meanTotal)}`,
    `- **pass rate (>= ${pct(agg.passThreshold)})**: ${pct(agg.passRate)}`,
    `- **flows that build**: ${pct(agg.buildRate)}`,
    "",
    "## By dimension",
    "",
    `| ${FLOW_DIMENSIONS.join(" | ")} |`,
    `|${FLOW_DIMENSIONS.map(() => "---").join("|")}|`,
    `| ${FLOW_DIMENSIONS.map((d) => pct(agg.byDimension[d])).join(" | ")} |`,
    "",
    "## By tag",
    "",
    "| tag | cases | mean |",
    "|---|---|---|",
    ...Object.entries(agg.byTag)
      .sort()
      .map(([tag, { count, meanTotal }]) => `| ${tag} | ${count} | ${pct(meanTotal)} |`),
    "",
    "## Per case",
    "",
    `| case | total | ${FLOW_DIMENSIONS.join(" | ")} | built | failures |`,
    `|---|---|${FLOW_DIMENSIONS.map(() => "---").join("|")}|---|---|`,
  ];
  for (const r of records) {
    const s = r.score;
    const out = s.run?.output;
    const built = out
      ? `${out.atoms} atoms (${Object.entries(out.elements)
          .map(([e, n]) => `${e}${n}`)
          .join(" ")})`
      : s.run
        ? `failed: ${s.run.error}`
        : "—";
    const failures = r.error ? `error: ${r.error}` : failedChecks(r).join("; ") || "—";
    lines.push(
      `| ${r.case.id} | ${pct(s.total)} | ${FLOW_DIMENSIONS.map((d) => pct(s[d].score)).join(" | ")} | ${built} | ${failures} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
