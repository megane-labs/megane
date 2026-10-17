/**
 * Render modal E2E (M4).
 *
 * Opens the RenderModal from the pipeline editor's Render button and
 * exercises the Snapshot tab. Animation export (GIF/MP4) requires ffmpeg
 * locally; the GIF/MP4 cases are gated on MEGANE_E2E_FFMPEG=1 so the
 * default suite stays portable.
 */

import { test, expect } from "playwright/test";
import { defaultViewerContract, assertDomContract, waitForReady } from "./lib/setup";
import { expectGifFile, useSmallGifExport } from "./lib/render-modal";
import { findNodeIdByType, removeNode } from "./lib/pipeline";

const PLATFORM = "render-modal";

test.describe("render-modal: webapp", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
  });

  test("opens with snapshot mode by default", async ({ page }) => {
    await assertDomContract(page, [
      ...defaultViewerContract({ context: "webapp" }),
      { testid: "pipeline-editor-render", visible: true, enabled: true },
    ]);

    await page.locator('[data-testid="pipeline-editor-render"]').click();
    const modal = page.locator('[data-testid="render-modal"]');
    await expect(modal).toBeVisible();

    // The default trajectory has > 1 frame, so the modal mode should be
    // "with-animation" (Snapshot tab + Animation tab visible).
    const mode = await modal.getAttribute("data-mode");
    expect(mode).toBe("with-animation");

    // Close via the backdrop.
    await page.locator('[data-testid="render-modal-backdrop"]').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('[data-testid="render-modal"]')).toBeHidden();

    void PLATFORM;
  });

  test("disables the Animation tab and explains why without a trajectory", async ({ page }) => {
    // Dropping the demo's load_trajectory node leaves a single-frame structure.
    await removeNode(page, await findNodeIdByType(page, "load_trajectory"));

    await page.locator('[data-testid="pipeline-editor-render"]').click();
    const modal = page.locator('[data-testid="render-modal"]');
    await expect(modal).toHaveAttribute("data-mode", "snapshot-only");

    const animationTab = page.locator('[data-testid="render-modal-tab-animation"]');
    await expect(animationTab).toBeDisabled();
    await expect(animationTab).toHaveAttribute("title", /only 1 frame/);
    await expect(page.locator('[data-testid="render-modal-animation-hint"]')).toBeVisible();
  });

  // Regression coverage for issues #497 / #599: gif.js loads its encoder as a
  // Web Worker, and when that worker script cannot be loaded it hangs at 80%
  // instead of erroring — no Blob, no download, no save dialog. Only a real
  // browser exercising the built bundle can catch it, so assert an actual GIF
  // lands on disk rather than mocking the encoder.
  test("exports a GIF (gif.js worker must load)", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-render"]').click();
    await expect(page.locator('[data-testid="render-modal"]')).toBeVisible();

    // Export failures surface as an alert(); fail with its text instead of
    // waiting out the download timeout.
    let exportError: string | null = null;
    page.on("dialog", (dialog) => {
      exportError = dialog.message();
      void dialog.dismiss();
    });

    await useSmallGifExport(page);

    const download = page.waitForEvent("download", { timeout: 120_000 });
    await page.locator('[data-testid="render-modal-export"]').click();

    const file = await download;
    expect(exportError, `export alert: ${exportError}`).toBeNull();
    expect(file.suggestedFilename()).toBe("megane-render.gif");

    expectGifFile(await file.path());
  });

  test("animation export gated on MEGANE_E2E_FFMPEG", async () => {
    test.skip(
      process.env.MEGANE_E2E_FFMPEG !== "1",
      "MP4 export requires MEGANE_E2E_FFMPEG=1 + ffmpeg on PATH",
    );
    // Implementation lands when ffmpeg is gated in.
  });
});
