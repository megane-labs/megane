/**
 * Two `<MeganeViewer>`s on one page must render different structures.
 *
 * This is the regression test for issue #672. `MeganeViewer` read
 * module-global zustand stores, so the second viewer's `openFile()` replaced
 * the graph the first was rendering and both panels ended up showing the same
 * structure. `<MeganeProvider>` gives each viewer its own store bundle.
 *
 * The harness is `multi-instance.html` / `src/multiInstance.tsx`: two panels,
 * each with its own `createMeganeStores()` bundle, each loading through
 * `stores.pipeline.getState().openFile(file)` — the call the issue reports.
 *
 * Deliberately asserts on the DOM (`data-atom-count`) rather than
 * `waitForReady`: `window.__megane_test_ready` is a last-renderer-wins
 * singleton in `MoleculeRenderer`, so it cannot distinguish two viewers.
 */

import { test, expect } from "playwright/test";
import { readFileSync } from "fs";
import { join } from "path";
import { assertDomContract, expectFullPageMatch, stabilizeUi } from "./lib/setup";

const PLATFORM = "multi-instance";
const FIXTURES = join(process.cwd(), "tests/fixtures");

/** Crambin — the 327-atom structure from the issue report. */
const LEFT = { file: "1crn.pdb", atoms: 327 };
/** A 3-atom water, chosen so a leak between the panels is unmistakable. */
const RIGHT = { file: "water_wrapped.pdb", atoms: 3 };

async function loadInto(
  page: import("@playwright/test").Page,
  panel: "left" | "right",
  fixture: { file: string; atoms: number },
): Promise<void> {
  await page.locator(`[data-testid="load-${panel}"]`).setInputFiles({
    name: fixture.file,
    mimeType: "chemical/x-pdb",
    buffer: readFileSync(join(FIXTURES, fixture.file)),
  });
}

function viewer(page: import("@playwright/test").Page, panel: "left" | "right") {
  return page.locator(`[data-testid="panel-${panel}"] [data-testid="megane-viewer"]`);
}

test.describe("multiple MeganeViewer instances on one page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/multi-instance.html?test=1", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="megane-viewer"]')).toHaveCount(2);
  });

  test("both viewers mount independently", async ({ page }) => {
    await assertDomContract(page, [
      { testid: "megane-viewer", visible: true, count: 2 },
      { testid: "viewer-root", visible: true, count: 2 },
    ]);

    // Each viewer reports the id of the store bundle it renders, so a leak
    // shows up as two panels claiming the same bundle.
    await expect(viewer(page, "left")).toHaveAttribute("data-megane-instance", "left");
    await expect(viewer(page, "right")).toHaveAttribute("data-megane-instance", "right");
  });

  test("each viewer shows its own structure", async ({ page }) => {
    await loadInto(page, "left", LEFT);
    await expect(viewer(page, "left")).toHaveAttribute(
      "data-atom-count",
      String(LEFT.atoms),
      { timeout: 30_000 },
    );

    await loadInto(page, "right", RIGHT);
    await expect(viewer(page, "right")).toHaveAttribute(
      "data-atom-count",
      String(RIGHT.atoms),
      { timeout: 30_000 },
    );

    // The assertion that failed before the fix: loading the right panel used
    // to replace the left panel's graph, leaving both on the same structure.
    await expect(viewer(page, "left")).toHaveAttribute("data-atom-count", String(LEFT.atoms));
  });

  test("loading in reverse order is equally independent", async ({ page }) => {
    await loadInto(page, "right", RIGHT);
    await expect(viewer(page, "right")).toHaveAttribute(
      "data-atom-count",
      String(RIGHT.atoms),
      { timeout: 30_000 },
    );

    await loadInto(page, "left", LEFT);
    await expect(viewer(page, "left")).toHaveAttribute(
      "data-atom-count",
      String(LEFT.atoms),
      { timeout: 30_000 },
    );

    await expect(viewer(page, "right")).toHaveAttribute("data-atom-count", String(RIGHT.atoms));
  });

  test("reloading one viewer leaves the other alone", async ({ page }) => {
    await loadInto(page, "left", LEFT);
    await loadInto(page, "right", RIGHT);
    await expect(viewer(page, "left")).toHaveAttribute(
      "data-atom-count",
      String(LEFT.atoms),
      { timeout: 30_000 },
    );
    await expect(viewer(page, "right")).toHaveAttribute(
      "data-atom-count",
      String(RIGHT.atoms),
      { timeout: 30_000 },
    );

    // Re-drop the small structure into the right panel; the left must not move.
    await loadInto(page, "right", RIGHT);
    await expect(viewer(page, "right")).toHaveAttribute(
      "data-atom-count",
      String(RIGHT.atoms),
      { timeout: 30_000 },
    );
    await expect(viewer(page, "left")).toHaveAttribute("data-atom-count", String(LEFT.atoms));
  });

  test("renders both structures", async ({ page }) => {
    await loadInto(page, "left", LEFT);
    await loadInto(page, "right", RIGHT);
    await expect(viewer(page, "left")).toHaveAttribute(
      "data-atom-count",
      String(LEFT.atoms),
      { timeout: 30_000 },
    );
    await expect(viewer(page, "right")).toHaveAttribute(
      "data-atom-count",
      String(RIGHT.atoms),
      { timeout: 30_000 },
    );

    await stabilizeUi(page);
    await expectFullPageMatch(page, PLATFORM, "two-viewers");
  });
});
