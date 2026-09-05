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

import { test, expect, type BrowserContext, type Frame, type Page } from "playwright/test";
import { GOLDEN_CASES } from "../../bench/llm/golden";
import { RENDER_MAX_DIFF_PERCENT, renderPipeline, scoreRender } from "../../bench/llm/render";
import { assertDomContract, compareToBaseline, defaultViewerContract } from "./lib/setup";
import { bootHost, type HostBoot } from "./lib/host-fixture";

const FIXTURE_ATOMS: Record<string, number> = { "caffeine_water.pdb": 3024 };

test.describe.configure({ mode: "serial" });

/** Per-node execution errors the editor would surface on the graph. */
async function nodeErrors(scope: Page | Frame): Promise<Record<string, string>> {
  return scope.evaluate(() => {
    const store = (
      window as Window & {
        __megane_test_pipeline_store?: {
          getState: () => { nodeErrors: Record<string, string> };
        };
      }
    ).__megane_test_pipeline_store;
    if (!store) throw new Error("__megane_test_pipeline_store not exposed; testMode off?");
    return store.getState().nodeErrors ?? {};
  });
}

// One boot per fixture, shared by the cases that use it.
const byFixture = new Map<string, typeof GOLDEN_CASES>();
for (const c of GOLDEN_CASES) {
  byFixture.set(c.fixture, [...(byFixture.get(c.fixture) ?? []), c]);
}

for (const [fixture, cases] of byFixture) {
  test.describe(`bench-golden: ${fixture}`, () => {
    let boot: HostBoot | null = null;
    // Held so `afterAll` can close it. The webapp host's own teardown is a
    // no-op (the static server is shared), so without this every fixture's
    // page — and its WebGL context — stays alive for the whole file; the
    // fifth boot then intermittently fails to load its fixture at all.
    let ctx: BrowserContext | null = null;

    test.beforeAll(async ({ browser }, info) => {
      ctx = await browser.newContext();
      const page = await ctx.newPage();
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
      if (ctx) {
        await ctx.close();
        ctx = null;
      }
    });

    for (const c of cases) {
      test(`${c.caseId} draws its expected image — ${c.expectation}`, async () => {
        if (!boot) test.skip(true, "boot not initialised");
        const capture = await renderPipeline(boot!.scope, c.pipeline);
        // A reference must execute cleanly. `filter-residue` shipped a
        // `bond_query` the DSL rejects — `both` takes a field, not a
        // parenthesised expression — and the picture still looked plausible,
        // because a node that throws contributes nothing rather than failing
        // the render. Reading the errors is what makes that visible.
        expect(await nodeErrors(boot!.scope), `${c.caseId}: the reference errors`).toEqual({});
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
        test(`${c.caseId} counterexamples draw a different picture`, async () => {
          if (!boot) test.skip(true, "boot not initialised");
          // The reference render from *this* page is the comparison target, not
          // the committed PNG: the renderer is exactly repeatable within a page
          // even for the cases whose image is not stable across boots, so this
          // isolates the pipeline difference from the rasterisation.
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
    }
  });
}
