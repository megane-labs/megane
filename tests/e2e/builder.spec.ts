/**
 * megane Builder E2E (webapp host, `/builder.html`).
 *
 * The Builder is the standalone structure editor: no pipeline, the view
 * always shows the document (source + edits) and every click is an edit.
 * Covers starting from an empty cell, placing atoms with real clicks, the
 * tools driven through the installed handlers, undo / redo, opening a file,
 * saving, and the molecule library (presets, the Place tool, and a sketch
 * drawn in the real Ketcher build). Asserts DOM and store state rather than
 * pixels.
 */

import { test, expect, type Page } from "playwright/test";
import { waitForReady } from "./lib/setup";

interface BuilderState {
  fileName: string | null;
  edits: { op: string }[];
  nAtoms: number | null;
  nBonds: number | null;
  edge: number | null;
  selected: number[];
  tool: string;
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
            selected: number[];
            tool: string;
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
      selected: s.selected,
      tool: s.tool,
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

  test("adds library presets, places one with the Place tool, and keeps a Ketcher sketch", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const root = page.locator('[data-testid="megane-builder"]');
    const library = page.locator('[data-testid="builder-library"]');
    await expect(library).toBeVisible();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("10 molecules");
    const water = page.locator('[data-testid="builder-library-item-preset:water"]');

    // Add is inert without a document; with an empty cell it lands at the centre.
    await water.locator('[data-testid="builder-library-add"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "0");
    await page.locator('[data-testid="builder-welcome-new"]').click();
    await waitForReady(page);
    await water.locator('[data-testid="builder-library-add"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "3");
    await expect(root).toHaveAttribute("data-bond-count", "2");
    let state = await builderState(page);
    expect(state.edits[0]).toMatchObject({ op: "add_fragment", translate: [5, 5, 5] });
    expect(state.selected).toEqual([0, 1, 2]);
    await expect(page.locator('[data-testid="builder-op-list"] li').first()).toHaveText(
      /Add water-\d+ \(3 atoms\)/,
    );

    // A second Add goes beside the first molecule, past its bounding box.
    await page
      .locator(
        '[data-testid="builder-library-item-preset:benzene"] [data-testid="builder-library-add"]',
      )
      .click();
    await expect(root).toHaveAttribute("data-atom-count", "15");
    state = await builderState(page);
    const second = state.edits[1] as { translate: [number, number, number] };
    expect(second.translate[0]).toBeGreaterThan(5 + 0.75 + 2);

    // Place: choose methane, then a real click on empty space stamps it there.
    const methane = page.locator('[data-testid="builder-library-item-preset:methane"]');
    await methane.locator('[data-testid="builder-library-place"]').click();
    await expect(methane).toHaveAttribute("data-placing", "true");
    await expect(page.locator('[data-testid="builder-tool-place"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('[data-testid="builder-tool-hint"]')).toContainText(
      "Placing Methane",
    );
    const viewport = page.locator('[data-testid="viewer-root"]');
    const box = (await viewport.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.8);
    await expect(root).toHaveAttribute("data-atom-count", "20");
    state = await builderState(page);
    expect(state.edits[2]).toMatchObject({ op: "add_fragment" });
    expect(state.selected).toEqual([15, 16, 17, 18, 19]);
    expect(state.tool).toBe("place");
    // The Place tool ignores clicks on atoms.
    await pickAtom(page, 0);
    await expect(root).toHaveAttribute("data-atom-count", "20");

    // Sketch: Ketcher (the real standalone build) loads in the dialog; a
    // molecule set through its API comes back as a flat, Å-scaled library
    // entry with its implicit hydrogens added, and persists across a reload.
    await page.locator('[data-testid="builder-library-sketch"]').click();
    await expect(page.locator('[data-testid="sketch-modal"]')).toBeVisible();
    await page.waitForFunction(
      () => !!(window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher,
      null,
      { timeout: 60_000 },
    );
    await page.evaluate(async () => {
      const k = (
        window as unknown as {
          __megane_test_ketcher: { setMolecule: (s: string) => Promise<void> };
        }
      ).__megane_test_ketcher;
      await k.setMolecule("CCO");
    });
    await page.locator('[data-testid="sketch-name"]').fill("Ethanol sketch");
    await page.locator('[data-testid="sketch-add"]').click();
    await expect(page.locator('[data-testid="sketch-modal"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("11 molecules");
    const sketched = page.locator('[data-testid="builder-library-item-name"]', {
      hasText: "Ethanol sketch",
    });
    await expect(sketched).toHaveCount(1);
    const row = page.locator('[data-testid^="builder-library-item-user:"]');
    // Ethanol drawn as C–C–O comes back as C2H6O: the six implicit hydrogens are added.
    await expect(row).toContainText("C2H6O");
    await expect(row).toContainText("flat");
    await row.locator('[data-testid="builder-library-add"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "29");
    await expect(root).toHaveAttribute("data-bond-count", "26");
    state = await builderState(page);
    const sketchOp = state.edits[3] as {
      elements: number[];
      positions: number[];
      bonds: [number, number][];
    };
    expect(sketchOp.elements).toEqual([6, 6, 8, 1, 1, 1, 1, 1, 1]);
    // Ketcher draws unit bonds; the library rescaled C–C to ~1.5 Å.
    const [a, b] = sketchOp.bonds[0];
    const cc = Math.hypot(
      sketchOp.positions[a * 3] - sketchOp.positions[b * 3],
      sketchOp.positions[a * 3 + 1] - sketchOp.positions[b * 3 + 1],
    );
    expect(cc).toBeGreaterThan(1.3);
    expect(cc).toBeLessThan(1.7);
    // The heavy atoms stay in the drawing plane; the CH2 hydrogens leave it.
    for (let i = 0; i < 3; i++) expect(Math.abs(sketchOp.positions[i * 3 + 2])).toBeLessThan(0.05);
    const zs = sketchOp.positions.filter((_, k) => k % 3 === 2);
    expect(Math.max(...zs.map(Math.abs))).toBeGreaterThan(0.5);

    // The user library survives a reload (localStorage); presets do not duplicate.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("11 molecules");
    await expect(sketched).toHaveCount(1);
    await row.locator('[data-testid="builder-library-remove"]').click();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("10 molecules");
  });
});
