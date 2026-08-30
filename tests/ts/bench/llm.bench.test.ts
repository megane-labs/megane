/**
 * Live megane LLM benchmark runner.
 *
 * This is a *benchmark*, not a unit test: it makes real, paid LLM API calls,
 * so it is skipped unless `MEGANE_LLM_BENCH=1` is set. It reuses vitest purely
 * as a zero-extra-dependency TypeScript runner (the repo already installs it).
 *
 * Usage:
 *   MEGANE_LLM_BENCH=1 ANTHROPIC_API_KEY=sk-... \
 *     MEGANE_LLM_PROVIDER=anthropic MEGANE_LLM_MODEL=claude-sonnet-4-20250514 \
 *     npx vitest run tests/ts/bench/llm.bench.test.ts
 *
 * Providers: anthropic (ANTHROPIC_API_KEY), openai (OPENAI_API_KEY),
 * plamo (PLAMO_API_KEY), openrouter (OPENROUTER_API_KEY), demo
 * (MEGANE_LLM_PROXY_URL). Results are written to bench/llm/results/.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATASET } from "../../../bench/llm/dataset";
import { runDataset } from "../../../bench/llm/runner";
import { aggregate, toJSON, toMarkdown } from "../../../bench/llm/report";
import { assertConfig, configFromEnv, generatePipelineLive } from "../../../bench/llm/providers";

const ENABLED = process.env.MEGANE_LLM_BENCH === "1";

describe.skipIf(!ENABLED)("megane LLM benchmark (live)", () => {
  it("scores the dataset and writes a report", async () => {
    const config = configFromEnv();
    assertConfig(config);

    // Prompts are unique per case, so they key the per-case repair counts that
    // `runDataset` itself has no slot for.
    const repairsByPrompt = new Map<string, number>();
    const records = await runDataset(
      DATASET,
      async (prompt) => {
        const stats = { repairRounds: 0 };
        const text = await generatePipelineLive(config, prompt, fetch, stats);
        repairsByPrompt.set(prompt, stats.repairRounds);
        return text;
      },
      {
        onResult: (r, i, total) => {
          r.repairRounds = repairsByPrompt.get(r.case.prompt);
          const pct = Math.round(r.score.total * 100);
          // eslint-disable-next-line no-console
          console.log(
            `[${i + 1}/${total}] ${r.case.id}: ${pct}%${r.error ? ` (error: ${r.error})` : ""}`,
          );
        },
      },
    );

    const agg = aggregate(records);
    const meta = {
      provider: config.provider,
      model: config.model,
      timestamp: new Date().toISOString(),
    };

    const dir = join(process.cwd(), "bench", "llm", "results");
    mkdirSync(dir, { recursive: true });
    const stamp = meta.timestamp.replace(/[:.]/g, "-");
    const base = `${config.provider}-${config.model.replace(/[^\w.-]/g, "_")}-${stamp}`;
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(toJSON(meta, records, agg), null, 2));
    const md = toMarkdown(meta, records, agg);
    writeFileSync(join(dir, `${base}.md`), md);

    // eslint-disable-next-line no-console
    console.log("\n" + md);

    expect(records).toHaveLength(DATASET.length);
  }, 600_000);
});
