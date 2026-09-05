/**
 * Runner for the LLM benchmark's ground truth (`bench/llm/golden/`).
 *
 * The data lives with the prompts, not here: each case is a folder named after
 * its `bench/llm/dataset.ts` id, holding the pipeline that answers the prompt,
 * the image that pipeline draws, and a `meta.json` naming the fixture. This spec
 * is only the thing that renders them — it discovers whatever `GOLDEN_CASES`
 * finds, so adding ground truth to a case needs no edit here.
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
 * Assertion 2 compares each counterexample against the reference render taken
 * **in the same page**, not against the committed PNG. Within a page the
 * renderer is exactly repeatable (measured: five renders of the same pipeline,
 * byte-identical), so this is the sharper comparison — and it is the only one
 * available for the six cases whose committed image is not assertable across
 * boots (`imageStability.asserted: false`; see `bench/llm/golden.ts` for what
 * was measured and why).
 *
 * Webapp host only; `captureViewerRegion` crops host chrome away, so the
 * references are properties of the renderer rather than of any host's window.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect, type BrowserContext } from "playwright/test";
import { GOLDEN_CASES } from "../../bench/llm/golden";
import { RENDER_MAX_DIFF_PERCENT, renderPipeline, scoreRender } from "../../bench/llm/render";
import { assertDomContract, compareToBaseline, defaultViewerContract } from "./lib/setup";
import { bootHost, type HostBoot } from "./lib/host-fixture";

const FIXTURE_ATOMS: Record<string, number> = { "caffeine_water.pdb": 3024 };

test.describe.configure({ mode: "serial" });
// Each test boots a page, loads a fixture and renders several pipelines through
// the software rasteriser; the crystal cases take well past the 30s default.
test.setTimeout(300_000);

// One fresh boot per case. Sharing a page across cases does not work: the
// Viewport keeps its framing when a new snapshot has the same topology as the
// last, so a reference rendered after another pipeline inherits that pipeline's
// view. `filter-carbon` reproduces byte-for-byte across three independent boots
// and fails against its own image when rendered second in a shared page. The
// references are captured one boot per case, so they are checked that way too.
for (const c of GOLDEN_CASES) {
  test.describe(`bench-golden: ${c.caseId}`, () => {
    let boot: HostBoot | null = null;
    // Held so `afterAll` can close it. The webapp host's own teardown is a
    // no-op (the static server is shared), so without this every case's page —
    // and its WebGL context — stays alive for the whole file, and later boots
    // intermittently fail to load their fixture at all.
    let ctx: BrowserContext | null = null;

    test.beforeAll(async ({ browser }, info) => {
      ctx = await browser.newContext();
      const page = await ctx.newPage();
      boot = await bootHost(page, { fixture: c.fixture, portSeed: info.workerIndex + 91 });
      const expectedAtoms = FIXTURE_ATOMS[c.fixture];
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
      if (ctx) {
        await ctx.close();
        ctx = null;
      }
    });

    test(`draws its expected image — ${c.expectation}`, async () => {
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
      test.skip(
        !c.imageStability.asserted,
        `${c.caseId}: image not assertable — ${c.imageStability.note ?? "see meta.json"} ` +
          `(worst ${c.imageStability.worstDiffPercent}% over ${c.imageStability.boots} boots)`,
      );
      expect(
        result.diffPercent,
        `${c.caseId}: the reference pipeline no longer draws its expected image. ` +
          `Either the renderer changed, or pipeline.megane.json is stale — re-capture ` +
          `it (${c.capturedFrom}) rather than re-recording the PNG.`,
      ).toBeLessThanOrEqual(RENDER_MAX_DIFF_PERCENT);
    });

    if (c.counterexamples.length > 0) {
      test("counterexamples draw a different picture", async () => {
        if (!boot) test.skip(true, "boot not initialised");
        // The reference render from *this* page is the comparison target, not
        // the committed PNG: the renderer is exactly repeatable within a page
        // even for the cases whose image is not stable across boots, so this
        // isolates the pipeline difference from anything session-dependent.
        const scratch = mkdtempSync(join(tmpdir(), "megane-bench-counter-"));
        const reference = join(scratch, "reference.png");
        await renderPipeline(boot!.scope, c.pipeline, reference);
        for (const wrong of c.counterexamples) {
          const capture = await renderPipeline(boot!.scope, wrong.pipeline);
          const result = await compareToBaseline(reference, capture, { maxDiffPercent: 100 });
          expect(
            result.diffPercent,
            `${c.caseId}: "${wrong.label}" drew the same picture as the reference. ` +
              `This pipeline is wrong, so the comparison is not distinguishing anything.`,
          ).toBeGreaterThan(RENDER_MAX_DIFF_PERCENT);
        }
      });
    }
  });
}
