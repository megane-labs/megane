/**
 * Render harness for the LLM benchmark.
 *
 * `scorer.ts` grades the shape of a generated pipeline. This module grades the
 * *picture* it produces: it loads a candidate `SerializedPipeline` into a
 * booted webapp exactly the way the chat pane does, screenshots the viewer, and
 * compares the result against a committed reference image.
 *
 * The pixel comparison itself is delegated to the E2E suite's
 * `compareToBaseline`, but the images themselves live beside the prompts in
 * `bench/llm/golden/<case id>/expected.png` rather than under the E2E baseline
 * root — ground truth for a prompt belongs with that prompt, so a case can be
 * added, re-captured or experimented on without touching the E2E suite.
 */

import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Page, Frame } from "playwright/test";
import type { SerializedPipeline } from "@/pipeline/types";
import {
  captureViewerRegion,
  compareToBaseline,
  getReadyState,
  waitForReady,
  stabilizeUi,
} from "../../tests/e2e/lib/setup";

export const RENDER_MAX_DIFF_PERCENT = 0.005;

export interface RenderScore {
  /** Percentage of pixels differing from the reference image. */
  diffPercent: number;
  /** 1 when the render matches the reference, 0 when it does not. */
  score: number;
  /** True when no reference existed and this run recorded one. */
  isNew: boolean;
  /** True when the capture and the reference differ in size. */
  sizeMismatch: boolean;
}

/**
 * Load `pipeline` into an already-booted viewer that has a structure open.
 *
 * This mirrors `applyPipeline` in `src/components/PipelineChatBox.tsx` step for
 * step, and for the same reason: a generated pipeline's `load_structure` node
 * carries `fileName: null` and `deserialize()` clears `nodeSnapshots`, so the
 * loaded structure has to be captured beforehand and re-attached to the new
 * loader afterwards. Skipping that renders an empty viewport, which would make
 * every candidate look equally (and wrongly) broken.
 */
export async function applyPipeline(
  scope: Page | Frame,
  pipeline: SerializedPipeline,
): Promise<void> {
  const before = await getReadyState(scope);

  await scope.evaluate(
    (json) => {
      interface Snapshotish {
        snapshot: unknown;
      }
      interface StoreState {
        nodes: Array<{ id: string; type?: string; data: { params: Record<string, unknown> } }>;
        nodeSnapshots: Record<string, Snapshotish>;
        deserialize: (p: unknown) => void;
        setNodeSnapshot: (id: string, data: Snapshotish) => void;
        updateNodeParams: (id: string, patch: Record<string, unknown>) => void;
      }
      const store = (
        window as Window & {
          __megane_test_pipeline_store?: { getState: () => StoreState };
        }
      ).__megane_test_pipeline_store;
      if (!store) throw new Error("__megane_test_pipeline_store not exposed; testMode off?");

      const pre = store.getState();
      const oldLoader = pre.nodes.find((n) => n.type === "load_structure");
      const preserved = oldLoader
        ? {
            snapshot: pre.nodeSnapshots[oldLoader.id],
            fileName: oldLoader.data.params.fileName ?? null,
            hasTrajectory: oldLoader.data.params.hasTrajectory ?? false,
            hasCell: oldLoader.data.params.hasCell ?? false,
          }
        : null;

      pre.deserialize(json);

      if (preserved?.snapshot) {
        const post = store.getState();
        const newLoader = post.nodes.find((n) => n.type === "load_structure");
        if (newLoader) {
          post.setNodeSnapshot(newLoader.id, preserved.snapshot);
          post.updateNodeParams(newLoader.id, {
            fileName: preserved.fileName,
            hasTrajectory: preserved.hasTrajectory,
            hasCell: preserved.hasCell,
          });
        }
      }
    },
    pipeline as unknown as Record<string, unknown>,
  );

  await waitForReady(scope, { untilEpoch: before.renderEpoch + 1, timeout: 15_000 });
  await stabilizeUi(scope);
}

/**
 * Put the viewer in the one state every render can be compared in: editor pane
 * collapsed, camera re-fit to whatever is drawn.
 *
 * The camera fit is load-bearing and was established by measurement.
 * `deserialize` does not re-frame the scene, and the Viewport keeps the current
 * zoom whenever a new snapshot has the same topology as the last, so the framing
 * a render inherits depends on which pipelines ran before it in the same page.
 * `molecule-basic` and `color-by-element` describe the same scene (byElement is
 * the default palette) and render byte-identical pixels, yet two reference
 * images captured in different batches differed by 10.9% of pixels, purely in
 * framing.
 *
 * Collapsing the pane removes the editor from the screenshot, which is what
 * makes the "two pipelines laid out differently must score the same" claim below
 * true, and takes the camera's frustum inset (`setViewInsets(0, pipelineWidth +
 * 12)`) out of the picture with it.
 *
 * Neither is enough to make every case reproducible, and the reason is not in
 * this file. Six cases still render one of exactly two pictures depending on the
 * session. Across four independent boots of those pipelines the store's viewport
 * state is bit-identical (same atom count, same position checksums, same bond
 * count, same mesh vertex and coordinate checksums), `getCameraState()` returns
 * the same position, target and zoom to the last float, and
 * `getVisibleSubsystems()` agrees — and the images still differ by 2.5-13% of
 * pixels. Whatever flips is below the scene: coincident geometry rasterised in a
 * different order. `meta.json` records that per case as `imageStability`, and
 * the runner declines to assert those images rather than widening the pixel
 * budget until they pass.
 */
async function normalizeViewer(scope: Page | Frame): Promise<void> {
  const collapse = scope.locator(
    '[data-testid="panel-pipeline-toggle"][aria-label="Collapse panel"]',
  );
  if (await collapse.count()) await collapse.first().click();
  const reset = scope.locator('[data-testid="reset-view-btn"]');
  await reset.waitFor({ state: "visible", timeout: 15_000 });
  await reset.click();
}

/**
 * Apply `pipeline`, re-frame the scene, and screenshot the viewer region.
 *
 * The *viewer* region rather than the full page on purpose: two pipelines that
 * draw the same molecule but lay their nodes out differently must score the
 * same, and the editor pane would make them differ.
 */
export async function renderPipeline(
  scope: Page | Frame,
  pipeline: SerializedPipeline,
  outPath?: string,
): Promise<Buffer> {
  await applyPipeline(scope, pipeline);
  await normalizeViewer(scope);
  const target = outPath ?? join(mkdtempSync(join(tmpdir(), "megane-bench-render-")), "render.png");
  return await captureViewerRegion(scope, target);
}

/**
 * Compare a capture against a case's reference image
 * (`bench/llm/golden/<case id>/expected.png`; delete it and re-run to record).
 *
 * `score` is intentionally binary. A pipeline either draws the requested
 * picture or it does not; a partial credit curve over pixel counts would reward
 * "wrong, but only in a small corner of the screen", which is not a thing users
 * care about.
 */
export async function scoreRender(capture: Buffer, expectedImage: string): Promise<RenderScore> {
  const result = await compareToBaseline(expectedImage, capture, {
    maxDiffPercent: RENDER_MAX_DIFF_PERCENT,
  });
  return {
    diffPercent: result.diffPercent,
    score: result.ok ? 1 : 0,
    isNew: result.isNew,
    sizeMismatch: result.sizeMismatch ?? false,
  };
}
