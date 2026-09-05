/**
 * Render verification for the LLM benchmark (`bench/llm/`).
 *
 * The benchmark's static scorer grades the shape of a generated pipeline and is
 * blind to what that pipeline draws — the "hide the water draws it twice" bug
 * scores a perfect 100% while leaving the water fully visible. This spec pins
 * the picture instead: every entry in `GOLDEN_RENDERS` is rendered against a
 * committed reference image.
 *
 * Three assertions per golden, and the last two are what make the first one
 * worth anything:
 *
 *   1. the reference pipeline matches its baseline (the check runs at all);
 *   2. structurally different but equivalent pipelines match the *same*
 *      baseline (it grades the outcome, not the graph shape);
 *   3. wrong pipelines — each of which passes the static rubric — do NOT match
 *      (it can actually fail).
 *
 * Without (3) a green run would prove nothing: a comparison that accepts
 * everything is indistinguishable from one that works.
 *
 * Webapp host only. The reference images are properties of the renderer, not of
 * any host's window chrome, and `captureViewerRegion` already crops the host UI
 * away — running the same goldens on five hosts would multiply baselines
 * without testing anything new.
 */

import { readFileSync } from "node:fs";
import { test, expect } from "playwright/test";
import type { SerializedPipeline } from "@/pipeline/types";
import { GOLDEN_RENDERS, goldenFor } from "../../bench/llm/golden";
import { RENDER_MAX_DIFF_PERCENT, renderPipeline, scoreRender } from "../../bench/llm/render";
import { assertDomContract, defaultViewerContract } from "./lib/setup";
import { bootHost, type HostBoot } from "./lib/host-fixture";

const FIXTURE_ATOMS = 3024;

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;

test.beforeAll(async ({ browser }, info) => {
  const fixtures = new Set(GOLDEN_RENDERS.map((g) => g.fixture));
  if (fixtures.size !== 1) {
    throw new Error(
      `bench-render boots one viewer for the whole file; GOLDEN_RENDERS must share one ` +
        `fixture but names ${[...fixtures].join(", ")}`,
    );
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  boot = await bootHost(page, { fixture: [...fixtures][0], portSeed: info.workerIndex + 29 });
  await assertDomContract(boot.scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot.context }),
  ]);
});

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

for (const golden of GOLDEN_RENDERS) {
  test(`bench-render: ${golden.caseId} reference renders — ${golden.expectation}`, async () => {
    if (!boot) test.skip(true, "boot not initialised");
    const capture = await renderPipeline(boot!.scope, golden.pipeline);
    const result = await scoreRender(capture, golden.caseId);

    if (result.isNew) {
      // First run for this case recorded the baseline. Say so loudly: the
      // counterexample assertions below are meaningless against a reference
      // that was just written from an unreviewed render.
      // eslint-disable-next-line no-console
      console.log(`[bench-render] recorded new baseline for ${golden.caseId} — review the PNG`);
      return;
    }
    expect(
      result.diffPercent,
      `${golden.caseId}: reference pipeline no longer draws its baseline`,
    ).toBeLessThanOrEqual(RENDER_MAX_DIFF_PERCENT);
  });

  for (const equivalent of golden.equivalents) {
    test(`bench-render: ${golden.caseId} equivalent (${equivalent.label}) draws the same picture`, async () => {
      if (!boot) test.skip(true, "boot not initialised");
      const capture = await renderPipeline(boot!.scope, equivalent.pipeline);
      const result = await scoreRender(capture, golden.caseId);
      expect(
        result.diffPercent,
        `${golden.caseId}: "${equivalent.label}" should be graded correct — ` +
          `the render check must score the outcome, not the graph shape`,
      ).toBeLessThanOrEqual(RENDER_MAX_DIFF_PERCENT);
    });
  }

  for (const wrong of golden.counterexamples) {
    test(`bench-render: ${golden.caseId} counterexample (${wrong.label}) is rejected`, async () => {
      if (!boot) test.skip(true, "boot not initialised");
      const capture = await renderPipeline(boot!.scope, wrong.pipeline);
      const result = await scoreRender(capture, golden.caseId);
      expect(
        result.diffPercent,
        `${golden.caseId}: "${wrong.label}" rendered the reference picture. ` +
          `This pipeline is wrong and the static rubric already accepts it, so the ` +
          `render check is not adding any signal.`,
      ).toBeGreaterThan(RENDER_MAX_DIFF_PERCENT);
    });
  }
}

/**
 * Score a real benchmark run's output.
 *
 * `MEGANE_BENCH_RENDER_RESULTS=<bench/llm/results/*.json>` switches this file
 * from checking the goldens to rendering the pipelines a model actually
 * produced and comparing each against its reference image. That is the pass the
 * static dimensions cannot make: it reports, per case, whether the generated
 * pipeline draws what was asked for.
 *
 * Split from the golden tests rather than folded into them because the goldens
 * must keep running (and keep the baselines honest) on every ordinary E2E
 * sweep, with no results file and no API spend.
 */
const RESULTS = process.env.MEGANE_BENCH_RENDER_RESULTS;

test.describe(
  RESULTS
    ? "bench-render: generated pipelines"
    : "bench-render: generated pipelines (no results file)",
  () => {
    test.skip(
      !RESULTS,
      "set MEGANE_BENCH_RENDER_RESULTS to a bench/llm/results/*.json to score a run",
    );

    test("renders each generated pipeline and reports which drew the reference picture", async () => {
      if (!boot) test.skip(true, "boot not initialised");
      const report = JSON.parse(readFileSync(RESULTS!, "utf8")) as {
        cases: Array<{ id: string; pipeline: SerializedPipeline | null }>;
      };

      const rows: string[] = [];
      let scored = 0;
      let correct = 0;

      for (const entry of report.cases) {
        const golden = goldenFor(entry.id);
        if (!golden) continue; // no reference image for this case
        scored++;
        if (!entry.pipeline) {
          rows.push(`${entry.id}: no pipeline in the response — render 0`);
          continue;
        }
        const capture = await renderPipeline(boot!.scope, entry.pipeline);
        const result = await scoreRender(capture, entry.id);
        if (result.score === 1) correct++;
        rows.push(
          `${entry.id}: render ${result.score} (${result.diffPercent.toFixed(2)}% off) — ${golden.expectation}`,
        );
      }

      // eslint-disable-next-line no-console
      console.log(
        `\n[bench-render] ${correct}/${scored} generated pipelines drew the reference picture\n` +
          rows.map((r) => `  ${r}`).join("\n"),
      );

      // Reporting, not gating: a model scoring badly is the benchmark's result,
      // not a broken test. The assertion only catches a results file that matched
      // no golden at all, which means the run and the references have drifted
      // apart and the numbers above describe nothing.
      expect(scored, `no case in ${RESULTS} has a reference image`).toBeGreaterThan(0);
    });
  },
);
