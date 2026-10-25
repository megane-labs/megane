// @vitest-environment node
/**
 * Live Megane Builder Flow benchmark runner.
 *
 * A *benchmark*, not a unit test: it makes real, paid LLM API calls, so it is
 * skipped unless `MEGANE_LLM_BENCH=1` is set — the same switch and provider
 * variables as the pipeline benchmark (`llm.bench.test.ts`). Each reply's flow
 * is then run in Node with the production engine and RDKit (`bench/flow/`).
 *
 * Usage:
 *   MEGANE_LLM_BENCH=1 ANTHROPIC_API_KEY=sk-... \
 *     MEGANE_LLM_PROVIDER=anthropic MEGANE_LLM_MODEL=claude-haiku-4-5 \
 *     npx vitest run tests/ts/bench/flow.bench.test.ts
 *
 * `MEGANE_LLM_BENCH_CASES` (comma-separated ids) runs a subset. Results are
 * written to bench/flow/results/.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FLOW_DATASET } from "../../../bench/flow/dataset";
import { executeFlow } from "../../../bench/flow/execute";
import { generateFlowLive } from "../../../bench/flow/providers";
import { aggregateFlow, flowToJSON, flowToMarkdown } from "../../../bench/flow/report";
import { runFlowDataset } from "../../../bench/flow/runner";
import { assertConfig, configFromEnv } from "../../../bench/llm/providers";

const ENABLED = process.env.MEGANE_LLM_BENCH === "1";

describe.skipIf(!ENABLED)("Megane Builder Flow benchmark (live)", () => {
  it("scores the dataset and writes a report", async () => {
    const config = configFromEnv();
    assertConfig(config);
    const only = process.env.MEGANE_LLM_BENCH_CASES?.split(",").map((s) => s.trim());
    const cases = only ? FLOW_DATASET.filter((c) => only.includes(c.id)) : FLOW_DATASET;

    const repairs = new Map<string, number>();
    const records = await runFlowDataset(
      cases,
      async (c, env) => {
        const stats = { repairRounds: 0 };
        const text = await generateFlowLive(config, c, env, fetch, stats);
        repairs.set(c.id, stats.repairRounds);
        return text;
      },
      executeFlow,
      {
        onResult: (r, i, total) => {
          r.repairRounds = repairs.get(r.case.id);
          // eslint-disable-next-line no-console
          console.log(
            `[${i + 1}/${total}] ${r.case.id}: ${Math.round(r.score.total * 100)}%` +
              (r.error ? ` (error: ${r.error})` : ""),
          );
        },
      },
    );

    const agg = aggregateFlow(records);
    const meta = {
      bench: "flow" as const,
      provider: config.provider,
      model: config.model,
      timestamp: new Date().toISOString(),
    };
    const dir = join(process.cwd(), "bench", "flow", "results");
    mkdirSync(dir, { recursive: true });
    const stamp = meta.timestamp.replace(/[:.]/g, "-");
    const base = `${config.provider}-${config.model.replace(/[^\w.-]/g, "_")}-${stamp}`;
    writeFileSync(
      join(dir, `${base}.json`),
      JSON.stringify(flowToJSON(meta, records, agg), null, 2),
    );
    const md = flowToMarkdown(meta, records, agg);
    writeFileSync(join(dir, `${base}.md`), md);
    // eslint-disable-next-line no-console
    console.log("\n" + md);

    expect(records).toHaveLength(cases.length);
  }, 1_800_000);
});
