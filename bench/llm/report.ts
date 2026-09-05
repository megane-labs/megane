/**
 * Aggregation and report rendering for the LLM benchmark.
 *
 * Produces both a machine-readable JSON record and a human-readable Markdown
 * summary (overall scores, per-dimension means, per-tag breakdown, and a
 * per-case table) so runs can be diffed across models over time.
 */

import type { BenchCase } from "./types";
import type { CaseScore, DimensionName } from "./scorer";

const DIMENSIONS: DimensionName[] = ["schema", "task", "params", "format"];

/** One case's full outcome. */
export interface CaseRecord {
  case: BenchCase;
  /** Raw model response (may be omitted from compact reports). */
  response: string;
  score: CaseScore;
  /** Wall-clock latency of the generation call in ms. */
  latencyMs?: number;
  /** Set when the generation call threw instead of returning text. */
  error?: string;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Mean over the records where a dimension applied (score !== null). */
function meanDimension(records: CaseRecord[], dim: DimensionName): number {
  const vals = records.map((r) => r.score[dim].score).filter((s): s is number => s !== null);
  return mean(vals);
}

export interface Aggregate {
  count: number;
  meanTotal: number;
  /** Fraction of cases scoring >= `passThreshold`. */
  passRate: number;
  passThreshold: number;
  byDimension: Record<DimensionName, number>;
  byTag: Record<string, { count: number; meanTotal: number }>;
}

export function aggregate(records: CaseRecord[], passThreshold = 0.8): Aggregate {
  const byTag: Record<string, { count: number; meanTotal: number }> = {};
  const tagTotals: Record<string, number[]> = {};
  for (const r of records) {
    for (const tag of r.case.tags) {
      (tagTotals[tag] ??= []).push(r.score.total);
    }
  }
  for (const [tag, totals] of Object.entries(tagTotals)) {
    byTag[tag] = { count: totals.length, meanTotal: mean(totals) };
  }

  const byDimension = Object.fromEntries(
    DIMENSIONS.map((d) => [d, meanDimension(records, d)]),
  ) as Record<DimensionName, number>;

  return {
    count: records.length,
    meanTotal: mean(records.map((r) => r.score.total)),
    passRate: records.length
      ? records.filter((r) => r.score.total >= passThreshold).length / records.length
      : 0,
    passThreshold,
    byDimension,
    byTag,
  };
}

export interface ReportMeta {
  provider: string;
  model: string;
  timestamp: string;
}

/** Full JSON report payload. */
export function toJSON(meta: ReportMeta, records: CaseRecord[], agg: Aggregate) {
  return {
    meta,
    aggregate: agg,
    cases: records.map((r) => ({
      id: r.case.id,
      tags: r.case.tags,
      prompt: r.case.prompt,
      total: r.score.total,
      dimensions: {
        schema: r.score.schema.score,
        task: r.score.task.score,
        params: r.score.params.score,
        format: r.score.format.score,
      },
      failedChecks: DIMENSIONS.flatMap((d) =>
        r.score[d].checks.filter((c) => !c.passed).map((c) => `${d}: ${c.label}`),
      ),
      latencyMs: r.latencyMs,
      error: r.error,
    })),
  };
}

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

/** Render a Markdown summary. */
export function toMarkdown(meta: ReportMeta, records: CaseRecord[], agg: Aggregate): string {
  const lines: string[] = [];
  lines.push(`# megane LLM benchmark`);
  lines.push("");
  lines.push(`- **provider**: ${meta.provider}`);
  lines.push(`- **model**: ${meta.model}`);
  lines.push(`- **timestamp**: ${meta.timestamp}`);
  lines.push(`- **cases**: ${agg.count}`);
  lines.push(`- **mean total**: ${pct(agg.meanTotal)}`);
  lines.push(`- **pass rate (>= ${pct(agg.passThreshold)})**: ${pct(agg.passRate)}`);
  lines.push("");
  lines.push(`## By dimension`);
  lines.push("");
  lines.push(`| schema | task | params | format |`);
  lines.push(`|---|---|---|---|`);
  lines.push(
    `| ${pct(agg.byDimension.schema)} | ${pct(agg.byDimension.task)} | ` +
      `${pct(agg.byDimension.params)} | ${pct(agg.byDimension.format)} |`,
  );
  lines.push("");
  lines.push(`## By tag`);
  lines.push("");
  lines.push(`| tag | cases | mean |`);
  lines.push(`|---|---|---|`);
  for (const [tag, { count, meanTotal }] of Object.entries(agg.byTag).sort()) {
    lines.push(`| ${tag} | ${count} | ${pct(meanTotal)} |`);
  }
  lines.push("");
  lines.push(`## Per case`);
  lines.push("");
  lines.push(`| case | total | schema | task | params | format | failures |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of records) {
    const s = r.score;
    const failures = r.error
      ? `error: ${r.error}`
      : DIMENSIONS.flatMap((d) =>
          s[d].checks.filter((c) => !c.passed).map((c) => `${d}/${c.label}`),
        ).join("; ") || "—";
    lines.push(
      `| ${r.case.id} | ${pct(s.total)} | ${pct(s.schema.score)} | ${pct(s.task.score)} | ` +
        `${pct(s.params.score)} | ${pct(s.format.score)} | ${failures} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
