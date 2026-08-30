#!/usr/bin/env node
/**
 * Compare two `bench/llm` JSON reports (the `toJSON()` shape from
 * `bench/llm/report.ts`) and render a Markdown summary of the score
 * differences, for posting as a PR comment.
 *
 * Usage:
 *   node compare-results.mjs <before.json> <after.json> [out.md]
 *
 * Plain Node (no TS runner) so it can run in CI without a build step.
 */

import { readFileSync, writeFileSync } from "node:fs";

const DIMENSIONS = ["schema", "task", "params", "format"];

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
  const lines = [];
  lines.push("## LLM prompt-eval: before vs after");
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

function main() {
  const [beforePath, afterPath, outPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("Usage: compare-results.mjs <before.json> <after.json> [out.md]");
    process.exit(1);
  }

  const before = loadReport(beforePath);
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
