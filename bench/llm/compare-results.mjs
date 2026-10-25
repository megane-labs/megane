#!/usr/bin/env node
/**
 * Compare two benchmark JSON reports — the pipeline benchmark's
 * (`bench/llm/report.ts`) or the Builder Flow benchmark's
 * (`bench/flow/report.ts`), which share a shape — and render a Markdown
 * summary of the score differences, for posting as a PR comment.
 *
 * Usage:
 *   node compare-results.mjs <before.json|-> <after.json> [out.md]
 *
 * `-` (or a before file that does not exist) renders the after report alone:
 * the base branch of the PR that adds a benchmark has nothing to compare.
 *
 * Plain Node (no TS runner) so it can run in CI without a build step.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** The pipeline benchmark's dimensions, for reports that predate `byDimension` keys being read. */
const DEFAULT_DIMENSIONS = ["schema", "task", "params", "format"];

/** The dimensions a report scores, in its own order. */
function dimensionsOf(report) {
  const keys = Object.keys(report.aggregate?.byDimension ?? {});
  return keys.length > 0 ? keys : DEFAULT_DIMENSIONS;
}

/** The comment's heading for the benchmark that wrote `report`. */
function titleOf(report) {
  return report.meta?.bench === "flow" ? "## LLM Flow-eval (Megane Builder)" : "## LLM prompt-eval";
}

/** A case is flagged as a regression when its total drops by more than this. */
const REGRESSION_THRESHOLD = 0.05;

function pct(x) {
  return x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`;
}

/** Signed percentage-point delta, or "—" when either side is missing. */
function delta(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) {
    return "—";
  }
  const d = Math.round((after - before) * 100);
  if (d === 0) return "±0";
  return d > 0 ? `+${d}` : `${d}`;
}

function loadReport(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function buildComparisonMarkdown(before, after) {
  if (!before) return buildSingleMarkdown(after);
  const DIMENSIONS = dimensionsOf(after);
  const lines = [];
  lines.push(`${titleOf(after)}: before vs after`);
  lines.push("");
  lines.push(
    `- **before**: ${before.meta.provider} / ${before.meta.model} (${before.meta.timestamp})`,
  );
  lines.push(`- **after**: ${after.meta.provider} / ${after.meta.model} (${after.meta.timestamp})`);
  lines.push("");
  lines.push("### Aggregate");
  lines.push("");
  lines.push("| metric | before | after | Δ |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| mean total | ${pct(before.aggregate.meanTotal)} | ${pct(after.aggregate.meanTotal)} | ` +
      `${delta(before.aggregate.meanTotal, after.aggregate.meanTotal)} |`,
  );
  lines.push(
    `| pass rate (>= ${pct(after.aggregate.passThreshold)}) | ${pct(before.aggregate.passRate)} | ` +
      `${pct(after.aggregate.passRate)} | ${delta(before.aggregate.passRate, after.aggregate.passRate)} |`,
  );
  if (after.aggregate.buildRate !== undefined) {
    lines.push(
      `| flows that build | ${pct(before.aggregate.buildRate)} | ${pct(after.aggregate.buildRate)} | ` +
        `${delta(before.aggregate.buildRate, after.aggregate.buildRate)} |`,
    );
  }
  for (const dim of DIMENSIONS) {
    lines.push(
      `| ${dim} | ${pct(before.aggregate.byDimension[dim])} | ${pct(after.aggregate.byDimension[dim])} | ` +
        `${delta(before.aggregate.byDimension[dim], after.aggregate.byDimension[dim])} |`,
    );
  }
  lines.push("");

  lines.push("### Per case");
  lines.push("");
  // "repairs" is how many self-check repair rounds the *after* run spent on
  // this case; it is what tells a real regression apart from an unlucky first
  // sample, since only repaired cases can be blamed on the loop.
  lines.push("| case | before | after | Δ | repairs (after) |");
  lines.push("|---|---|---|---|---|");
  const beforeById = new Map(before.cases.map((c) => [c.id, c]));
  const regressions = [];
  for (const afterCase of after.cases) {
    const beforeCase = beforeById.get(afterCase.id);
    const b = beforeCase ? beforeCase.total : null;
    const a = afterCase.total;
    const repairs = afterCase.repairRounds ?? "—";
    lines.push(`| ${afterCase.id} | ${pct(b)} | ${pct(a)} | ${delta(b, a)} | ${repairs} |`);
    if (b !== null && b - a >= REGRESSION_THRESHOLD) {
      regressions.push(afterCase);
    }
  }
  lines.push("");

  if (regressions.length > 0) {
    lines.push(`### Regressions (score dropped by >= ${Math.round(REGRESSION_THRESHOLD * 100)}pp)`);
    lines.push("");
    for (const r of regressions) {
      lines.push(
        `- **${r.id}**: ${r.failedChecks.length ? r.failedChecks.join("; ") : "(no failed checks recorded)"}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * The after report alone, for a benchmark the base branch does not have yet:
 * the aggregate, then each case with what it failed.
 */
export function buildSingleMarkdown(after) {
  const lines = [];
  lines.push(`${titleOf(after)}: ${after.meta.provider} / ${after.meta.model}`);
  lines.push("");
  lines.push(`_The base branch has no results to compare with (${after.meta.timestamp})._`);
  lines.push("");
  lines.push("| metric | score |");
  lines.push("|---|---|");
  lines.push(`| mean total | ${pct(after.aggregate.meanTotal)} |`);
  lines.push(
    `| pass rate (>= ${pct(after.aggregate.passThreshold)}) | ${pct(after.aggregate.passRate)} |`,
  );
  if (after.aggregate.buildRate !== undefined) {
    lines.push(`| flows that build | ${pct(after.aggregate.buildRate)} |`);
  }
  for (const dim of dimensionsOf(after)) {
    lines.push(`| ${dim} | ${pct(after.aggregate.byDimension[dim])} |`);
  }
  lines.push("");
  lines.push("| case | total | repairs | failed checks |");
  lines.push("|---|---|---|---|");
  for (const c of after.cases) {
    const failed = c.error ? `error: ${c.error}` : c.failedChecks.join("; ") || "—";
    lines.push(`| ${c.id} | ${pct(c.total)} | ${c.repairRounds ?? "—"} | ${failed} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const [beforePath, afterPath, outPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("Usage: compare-results.mjs <before.json|-> <after.json> [out.md]");
    process.exit(1);
  }

  const before = beforePath === "-" || !existsSync(beforePath) ? null : loadReport(beforePath);
  const after = loadReport(afterPath);
  const md = buildComparisonMarkdown(before, after);

  if (outPath) {
    writeFileSync(outPath, md);
  } else {
    process.stdout.write(md);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
