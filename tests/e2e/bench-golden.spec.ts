/**
 * Ground-truth verification for the LLM benchmark (`bench/llm/`).
 *
 * The benchmark's scorer grades the shape of a generated pipeline and never
 * draws anything. This spec supplies the missing half: every reference pipeline
 * under `bench/llm/golden/` is loaded as a *serialized* graph — the same form a
 * model emits — and compared against `water-line.spec.ts`'s committed baselines.
 *
 * Two assertions per view, and the second is what makes the first worth
 * anything:
 *
 *   1. the reference pipeline, round-tripped through `deserialize`, draws the
 *      picture the editor produced. This is the equivalence that lets the bench
 *      grade generated JSON against a human-reviewed image at all;
 *   2. wrong pipelines derived from it do NOT. Without this a green run would
 *      prove nothing — a comparison that accepts everything looks identical to
 *      one that works.
 *
 * Baselines live under `tests/e2e/baselines/bench-golden/` and must be looked at
 * before they are committed — a reference recorded from an unreviewed render is
 * exactly the failure mode this suite exists to catch.
 *
 * Webapp host only. The references are properties of the renderer, and
 * `captureViewerRegion` already crops host chrome away.
 */

import { test, expect } from "playwright/test";
import { GOLDEN_VIEWS } from "../../bench/llm/golden";
import { RENDER_MAX_DIFF_PERCENT, renderPipeline, scoreRender } from "../../bench/llm/render";
import { assertDomContract, defaultViewerContract } from "./lib/setup";
import { bootHost, type HostBoot } from "./lib/host-fixture";

const FIXTURE = "caffeine_water.pdb";
const FIXTURE_ATOMS = 3024;

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;

test.beforeAll(async ({ browser }, info) => {
  const page = await (await browser.newContext()).newPage();
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: info.workerIndex + 91 });
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

for (const view of GOLDEN_VIEWS) {
  test(`bench-golden: ${view.id} round-trips to its baseline — ${view.expectation}`, async () => {
    if (!boot) test.skip(true, "boot not initialised");
    const capture = await renderPipeline(boot!.scope, view.pipeline);
    const result = await scoreRender(capture, view.baseline);
    if (result.isNew) {
      // First run for this view recorded the baseline. Say so loudly: the
      // counterexample assertions below mean nothing against a reference that
      // was just written from an unreviewed render.
      // eslint-disable-next-line no-console
      console.log(`[bench-golden] recorded new baseline for ${view.baseline} — review the PNG`);
      return;
    }
    expect(
      result.diffPercent,
      `${view.id}: the reference pipeline no longer draws water-line's baseline. ` +
        `Either the renderer changed, or golden/${view.id}.megane.json is stale — ` +
        `re-capture it from the spec rather than re-recording the PNG.`,
    ).toBeLessThanOrEqual(RENDER_MAX_DIFF_PERCENT);
  });

  for (const wrong of view.counterexamples) {
    test(`bench-golden: ${view.id} counterexample (${wrong.label}) is rejected`, async () => {
      if (!boot) test.skip(true, "boot not initialised");
      const capture = await renderPipeline(boot!.scope, wrong.pipeline);
      const result = await scoreRender(capture, view.baseline);
      expect(
        result.diffPercent,
        `${view.id}: "${wrong.label}" drew the reference picture. This pipeline is ` +
          `wrong, so the comparison is not distinguishing anything.`,
      ).toBeGreaterThan(RENDER_MAX_DIFF_PERCENT);
    });
  }
}
