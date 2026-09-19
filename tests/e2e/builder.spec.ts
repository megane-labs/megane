/**
 * megane Builder E2E (webapp host, `/builder.html`).
 *
 * The Builder is the standalone structure editor: no pipeline, the view
 * always shows the document (source + edits) and every click is an edit.
 * Covers starting from an empty cell, placing atoms with real clicks, the
 * tools driven through the installed handlers, undo / redo, opening a file,
 * and saving. Asserts DOM and store state rather than pixels.
 */

import { test, expect, type Page } from "playwright/test";
import { waitForReady } from "./lib/setup";

interface BuilderState {
  fileName: string | null;
  edits: { op: string }[];
  nAtoms: number | null;
  nBonds: number | null;
  edge: number | null;
}

async function builderState(page: Page): Promise<BuilderState> {
  return await page.evaluate(() => {
    const store = (
      window as unknown as {
        __megane_test_builder_store?: {
          getState: () => {
            fileName: string | null;
            edits: { op: string }[];
            result: {
              snapshot: { nAtoms: number; nBonds: number; box: Float32Array | null };
            } | null;
          };
        };
      }
    ).__megane_test_builder_store;
    if (!store) throw new Error("__megane_test_builder_store not exposed; testMode off?");
    const s = store.getState();
    return {
      fileName: s.fileName,
      edits: s.edits,
      nAtoms: s.result?.snapshot.nAtoms ?? null,
      nBonds: s.result?.snapshot.nBonds ?? null,
      edge: s.result?.snapshot.box ? s.result.snapshot.box[0] : null,
    };
  });
}

/**
 * Drive the Builder's own pick handler, exactly what the Viewport calls on a
 * click. Going through the store keeps the spec independent of where a given
 * atom lands on screen; the first atom of each scene is placed with a real
 * click below.
 */
async function pickAtom(page: Page, atomIndex: number | null) {
  await page.evaluate((idx) => {
    const store = (
      window as unknown as {
        __megane_test_builder_store?: {
          getState: () => { handlers: { pick: (i: unknown) => void } | null };
        };
      }
    ).__megane_test_builder_store;
    const handlers = store?.getState().handlers;
    if (!handlers) throw new Error("Builder handlers not installed");
    handlers.pick({ atomIndex: idx, world: idx === null ? [2, 2, 2] : null, shiftKey: false });
  }, atomIndex);
}

test.describe("builder: webapp", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/builder.html?test=1", { waitUntil: "domcontentloaded" });
    // The renderer reports its first frame only once a structure is loaded,
    // so an empty Builder is "ready" when its shell is on screen.
    await expect(page.locator('[data-testid="megane-builder"]')).toBeVisible();
  });

  test("starts empty, and an empty cell takes the first atom from a real click", async ({
    page,
  }) => {
    const root = page.locator('[data-testid="megane-builder"]');
    await expect(root).toHaveAttribute("data-atom-count", "0");
    await expect(page.locator('[data-testid="builder-welcome"]')).toBeVisible();
    await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText("No structure");

    await page.locator('[data-testid="builder-welcome-new"]').click();
    await expect(page.locator('[data-testid="builder-welcome"]')).toHaveCount(0);
    await waitForReady(page);
    expect(await builderState(page)).toMatchObject({ fileName: "untitled", nAtoms: 0, edge: 10 });
    await expect(page.locator('[data-testid="builder-op-count"]')).toHaveText("0 edits");

    // A real click on empty space: the camera framed the cell, so the pivot
    // sits at its centre and the atom lands inside the box.
    await page.locator('[data-testid="builder-tool-add"]').click();
    const viewport = page.locator('[data-testid="viewer-root"]');
    const box = (await viewport.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect(root).toHaveAttribute("data-atom-count", "1");
    const first = (await builderState(page)).edits[0] as {
      op: string;
      position: [number, number, number];
    };
    expect(first.op).toBe("add_atom");
    for (const c of first.position) {
      expect(c).toBeGreaterThan(-1);
      expect(c).toBeLessThan(11);
    }

    // A second atom attached to the first is bonded; the bond is drawn.
    await pickAtom(page, 0);
    await expect(root).toHaveAttribute("data-atom-count", "2");
    await expect(root).toHaveAttribute("data-bond-count", "1");
    await expect(page.locator('[data-testid="builder-status-atoms"]')).toHaveText(
      "2 atoms · 1 bonds",
    );

    // Undo / redo from the top bar.
    await page.locator('[data-testid="builder-topbar-undo"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "1");
    await page.locator('[data-testid="builder-topbar-redo"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "2");
    await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText(
      /untitled · 2 edits/,
    );
  });

  test("opens a file, edits it with every tool, and saves the result", async ({ page }) => {
    const root = page.locator('[data-testid="megane-builder"]');
    await page.setInputFiles('[data-testid="builder-open-input"]', "tests/fixtures/caffeine.sdf");
    await waitForReady(page);
    await expect(root).toHaveAttribute("data-atom-count", "24");
    await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText("caffeine.sdf");
    const opened = await builderState(page);
    expect(opened.nBonds).toBe(25);

    // Delete, then Element, then Bond.
    await page.locator('[data-testid="builder-tool-delete"]').click();
    await pickAtom(page, 0);
    await expect(root).toHaveAttribute("data-atom-count", "23");
    await page.locator('[data-testid="builder-tool-element"]').click();
    await page.locator('[data-testid="builder-element-N"]').click();
    await pickAtom(page, 0);
    await page.locator('[data-testid="builder-tool-bond"]').click();
    await pickAtom(page, 0);
    await expect(page.locator('[data-testid="builder-tool-hint"]')).toContainText("First atom: #0");
    await pickAtom(page, 5);
    const edited = await builderState(page);
    expect(edited.edits.map((e) => e.op)).toEqual(["delete_atoms", "set_element", "add_bond"]);
    await expect(page.locator('[data-testid="builder-op-list"] li')).toHaveCount(3);

    // Show original previews the file as opened and pauses editing.
    await page.locator('[data-testid="builder-show-original"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "24");
    await expect(page.locator('[data-testid="builder-paused"]')).toBeVisible();
    await page.locator('[data-testid="builder-show-original"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "23");

    // Save bakes the edited structure; the file takes the document's name.
    const download = page.waitForEvent("download");
    await page.locator('[data-testid="builder-save-xyz"]').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("caffeine.xyz");
    const text = await (await file.createReadStream())
      .toArray()
      .then((chunks) => Buffer.concat(chunks as Buffer[]).toString("utf8"));
    expect(text.split("\n")[0].trim()).toBe("23");
  });
});
