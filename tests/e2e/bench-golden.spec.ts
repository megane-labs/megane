/**
 * Runner for the LLM benchmark's ground truth (`bench/llm/golden/`).
 *
 * The data lives with the prompts, not here: each case is a folder named after
 * its `bench/llm/dataset.ts` id, holding the pipeline that answers the prompt,
 * the image that pipeline must draw, and a `meta.json` naming the fixture. This
 * spec is only the thing that renders them — it discovers whatever
 * `GOLDEN_CASES` finds, so adding ground truth to a case needs no edit here.
 *
 * Two assertions per case, and the second is what makes the first worth
 * anything:
 *
 *   1. the reference pipeline, round-tripped through `deserialize`, draws its
 *      expected image. That round trip is the point: it is what lets the bench
 *      grade generated JSON — the same form a model emits — against a reviewed
 *      picture;
 *   2. wrong pipelines derived from it do NOT. Without this a green run would
 *      prove nothing, since a comparison that accepts everything looks
 *      identical to one that works.
 *
 * Webapp host only; `captureViewerRegion` crops host chrome away, so the
 * references are properties of the renderer rather than of any host's window.
 */

import { test, expect } from "playwright/test";
import { GOLDEN_CASES } from "../../bench/llm/golden";
import { RENDER_MAX_DIFF_PERCENT, renderPipeline, scoreRender } from "../../bench/llm/render";
import { assertDomContract, defaultViewerContract } from "./lib/setup";
import { bootHost, type HostBoot } from "./lib/host-fixture";

const FIXTURE_ATOMS: Record<string, number> = { "caffeine_water.pdb": 3024 };

test.describe.configure({ mode: "serial" });

// One boot per fixture, shared by the cases that use it.
const byFixture = new Map<string, typeof GOLDEN_CASES>();
for (const c of GOLDEN_CASES) {
  byFixture.set(c.fixture, [...(byFixture.get(c.fixture) ?? []), c]);
}

for (const [fixture, cases] of byFixture) {
  test.describe(`bench-golden: ${fixture}`, () => {
    let boot: HostBoot | null = null;

    test.beforeAll(async ({ browser }, info) => {
      const page = await (await browser.newContext()).newPage();
      boot = await bootHost(page, { fixture, portSeed: info.workerIndex + 91 });
      const expectedAtoms = FIXTURE_ATOMS[fixture];
      if (expectedAtoms !== undefined) {
        await assertDomContract(boot.scope, [
          ...defaultViewerContract({ expectedAtoms, context: boot.context }),
        ]);
      }
    });

    test.afterAll(async () => {
      if (boot) {
        await boot.teardown();
        boot = null;
      }
    });

    for (const c of cases) {
      test(`${c.caseId} draws its expected image — ${c.expectation}`, async () => {
        if (!boot) test.skip(true, "boot not initialised");
        const capture = await renderPipeline(boot!.scope, c.pipeline);
        const result = await scoreRender(capture, c.expectedImage);
        if (result.isNew) {
          // Nothing to compare against yet; this run wrote the reference. Say so
          // loudly — the counterexamples below mean nothing against an image
          // recorded from an unreviewed render.
          // eslint-disable-next-line no-console
          console.log(`[bench-golden] recorded ${c.caseId}/expected.png — review it`);
          return;
        }
        expect(
          result.diffPercent,
          `${c.caseId}: the reference pipeline no longer draws its expected image. ` +
            `Either the renderer changed, or pipeline.megane.json is stale — re-capture ` +
            `it (${c.capturedFrom}) rather than re-recording the PNG.`,
        ).toBeLessThanOrEqual(RENDER_MAX_DIFF_PERCENT);
      });

      for (const wrong of c.counterexamples) {
        test(`${c.caseId} counterexample (${wrong.label}) is rejected`, async () => {
          if (!boot) test.skip(true, "boot not initialised");
          const capture = await renderPipeline(boot!.scope, wrong.pipeline);
          const result = await scoreRender(capture, c.expectedImage);
          expect(
            result.diffPercent,
            `${c.caseId}: "${wrong.label}" drew the expected image. This pipeline is ` +
              `wrong, so the comparison is not distinguishing anything.`,
          ).toBeGreaterThan(RENDER_MAX_DIFF_PERCENT);
        });
      }
    }
  });
}
