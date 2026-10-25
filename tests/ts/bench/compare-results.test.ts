/**
 * The before/after PR comment `bench/llm/compare-results.mjs` renders, for
 * both benchmarks' reports: the pipeline benchmark's four dimensions, the
 * Flow benchmark's five plus its build rate, and the after report alone when
 * the base branch has no results (the PR that adds a benchmark).
 */

import { describe, it, expect } from "vitest";
import {
  buildComparisonMarkdown,
  buildSingleMarkdown,
} from "../../../bench/llm/compare-results.mjs";

type Case = {
  id: string;
  total: number;
  failedChecks: string[];
  repairRounds?: number;
  error?: string;
};

function report(
  bench: string | undefined,
  dims: string[],
  total: number,
  cases: Case[],
  extra = {},
) {
  return {
    meta: { bench, provider: "openrouter", model: "m", timestamp: "2026-10-25T00:00:00Z" },
    aggregate: {
      meanTotal: total,
      passRate: total,
      passThreshold: 0.8,
      byDimension: Object.fromEntries(dims.map((d) => [d, total])),
      ...extra,
    },
    cases,
  };
}

const PIPELINE = ["schema", "task", "params", "format"];
const FLOW = ["schema", "task", "params", "result", "format"];

describe("compare-results", () => {
  it("keeps the pipeline benchmark's comment as it was", () => {
    const md = buildComparisonMarkdown(
      report(undefined, PIPELINE, 0.9, [{ id: "a", total: 0.9, failedChecks: [] }]),
      report(undefined, PIPELINE, 0.8, [
        { id: "a", total: 0.8, failedChecks: ["task: x"], repairRounds: 1 },
      ]),
    );
    expect(md.startsWith("## LLM prompt-eval: before vs after")).toBe(true);
    expect(md).toContain("| format | 90% | 80% | -10 |");
    expect(md).not.toContain("| result |");
    expect(md).toContain("| a | 90% | 80% | -10 | 1 |");
    expect(md).toContain("- **a**: task: x");
  });

  it("titles a Flow report and diffs its result dimension and build rate", () => {
    const md = buildComparisonMarkdown(
      report("flow", FLOW, 0.5, [{ id: "b", total: 0.5, failedChecks: [] }], { buildRate: 0.5 }),
      report("flow", FLOW, 0.75, [{ id: "b", total: 0.75, failedChecks: [] }], { buildRate: 1 }),
    );
    expect(md.startsWith("## LLM Flow-eval (Megane Builder): before vs after")).toBe(true);
    expect(md).toContain("| result | 50% | 75% | +25 |");
    expect(md).toContain("| flows that build | 50% | 100% | +50 |");
    expect(md).not.toContain("### Regressions");
  });

  it("renders the after report alone when there is nothing before", () => {
    const after = report(
      "flow",
      FLOW,
      0.7,
      [
        { id: "ok", total: 1, failedChecks: [], repairRounds: 0 },
        { id: "bad", total: 0.4, failedChecks: ["result: built 4 C"] },
        { id: "err", total: 0, failedChecks: [], error: "429" },
      ],
      { buildRate: 0.5 },
    );
    const md = buildComparisonMarkdown(null, after);
    expect(md).toBe(buildSingleMarkdown(after));
    expect(md.startsWith("## LLM Flow-eval (Megane Builder): openrouter / m")).toBe(true);
    expect(md).toContain("| flows that build | 50% |");
    expect(md).toContain("| result | 70% |");
    expect(md).toContain("| ok | 100% | 0 | — |");
    expect(md).toContain("| bad | 40% | — | result: built 4 C |");
    expect(md).toContain("| err | 0% | — | error: 429 |");
    const plain = buildSingleMarkdown(report(undefined, [], 1, []));
    expect(plain).toContain("| format | — |");
    expect(plain).not.toContain("flows that build");
  });
});
