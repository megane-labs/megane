/**
 * megane Builder E2E (webapp host, `/builder.html`).
 *
 * The Builder is the standalone structure editor: no pipeline, the view
 * always shows the document (source + edits) and every click is an edit.
 * Covers starting from an empty cell, placing atoms with real clicks, the
 * tools driven through the installed handlers, undo / redo, opening a file,
 * saving, and the molecule library (presets, the Place tool, and a sketch
 * drawn in the real Ketcher build and embedded in 3D by the real RDKit WASM
 * build). Asserts DOM and store state rather than pixels.
 */

import { test, expect, type Page } from "playwright/test";
import { PNG } from "pngjs";
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

/** Start an empty cell through the New structure dialog. */
async function newEmptyCell(page: Page) {
  await page.locator('[data-testid="builder-welcome-new"]').click();
  await page.locator('[data-testid="builder-new-cell"]').click();
}

/** Pick a format from the File menu's Save entries. */
async function saveAs(page: Page, format: string) {
  await page.locator('[data-testid="builder-file"]').click();
  await page.locator(`[data-testid="builder-save-${format}"]`).click();
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

    await newEmptyCell(page);
    await expect(page.locator('[data-testid="builder-welcome"]')).toHaveCount(0);
    await waitForReady(page);
    expect(await builderState(page)).toMatchObject({ fileName: "untitled", nAtoms: 0, edge: 10 });
    // No edits yet: the info line shows just the name.
    await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText("untitled");

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

  test("Place starts a document with nothing open; the periodic table and the theme", async ({
    page,
  }) => {
    const root = page.locator('[data-testid="megane-builder"]');
    const viewport = page.locator('[data-testid="viewer-root"]');

    // Dark theme from the rail's theme button (Light → Dark → Auto, as in
    // the viewer): the 3D view's background follows.
    const corner = async () => {
      const png = PNG.sync.read(await viewport.screenshot());
      const i = (png.width * 4 + 4) * 4;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const theme = page.locator('[data-testid="builder-theme"]');
    expect(await corner()).toEqual([255, 255, 255]);
    await theme.click();
    await expect(theme).toHaveAttribute("aria-label", /current: Light$/);
    await theme.click();
    await expect(theme).toHaveAttribute("aria-label", /current: Dark$/);
    await expect.poll(corner).toEqual([0x0f, 0x17, 0x2a]);
    await theme.click();
    await expect(theme).toHaveAttribute("aria-label", /current: Auto$/);
    await expect.poll(corner).toEqual([255, 255, 255]);

    // Nothing open: the Place tool still shows the gallery.
    await page.locator('[data-testid="builder-tool-place"]').click();
    await expect(page.locator('[data-testid="builder-library"]')).toBeVisible();
    await expect(page.locator('[data-testid="builder-welcome"]')).toHaveCount(0);
    await page
      .locator('[data-testid="builder-library-item-preset:water"]')
      .locator('[data-testid="builder-library-place"]')
      .click();
    // A real click on the empty view places it and starts an untitled document.
    const box = (await viewport.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await waitForReady(page);
    await expect(root).toHaveAttribute("data-atom-count", "3");
    expect(await builderState(page)).toMatchObject({ fileName: "untitled", edge: null });

    // The periodic table sets any element for Add atom.
    await page.locator('[data-testid="builder-tool-add"]').click();
    await page.locator('[data-testid="builder-element-table"]').click();
    await page.locator('[data-testid="builder-periodic-Pt"]').click();
    await expect(page.locator('[data-testid="builder-periodic-table"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="builder-element-symbol"]')).toHaveText("Pt");
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
    // Caffeine carries explicit hydrogens, so the C=O oxygen turned N gains
    // the H its valence leaves room for, in the same step.
    await expect(root).toHaveAttribute("data-atom-count", "24");
    await page.locator('[data-testid="builder-tool-bond"]').click();
    await pickAtom(page, 0);
    await expect(page.locator('[data-testid="builder-tool-hint"]')).toContainText("First atom: #0");
    await pickAtom(page, 5);
    const edited = await builderState(page);
    expect(edited.edits.map((e) => e.op)).toEqual([
      "delete_atoms",
      "set_element",
      "add_atom",
      "add_bond",
    ]);
    // The history lists Undo steps: Element and the hydrogen it added are one.
    await expect(page.locator('[data-testid="builder-op-list"] li')).toHaveCount(3);

    // Show original previews the file as opened and pauses editing.
    await page.locator('[data-testid="builder-show-original"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "24");
    await expect(page.locator('[data-testid="builder-paused"]')).toBeVisible();
    await page.locator('[data-testid="builder-show-original"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "24");

    // Save bakes the edited structure; the file takes the document's name.
    const download = page.waitForEvent("download");
    await saveAs(page, "xyz");
    const file = await download;
    expect(file.suggestedFilename()).toBe("caffeine.xyz");
    const text = await (await file.createReadStream())
      .toArray()
      .then((chunks) => Buffer.concat(chunks as Buffer[]).toString("utf8"));
    expect(text.split("\n")[0].trim()).toBe("24");
  });

  test("right-click menu, a bond length set by number, and an RDKit clean-up", async ({ page }) => {
    test.setTimeout(120_000);
    const root = page.locator('[data-testid="megane-builder"]');
    await page.setInputFiles('[data-testid="builder-open-input"]', "tests/fixtures/caffeine.sdf");
    await waitForReady(page);
    await expect(root).toHaveAttribute("data-atom-count", "24");

    // Right-click an atom (scan the middle of the view until one is under the
    // pointer): its menu selects the whole molecule.
    const menu = page.locator('[data-testid="builder-atom-menu"]');
    const box = (await page.locator('[data-testid="viewer-root"]').boundingBox())!;
    scan: for (let fy = 0.35; fy <= 0.65; fy += 0.03) {
      for (let fx = 0.35; fx <= 0.65; fx += 0.03) {
        await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, {
          button: "right",
        });
        if ((await menu.count()) > 0) break scan;
      }
    }
    await expect(menu).toBeVisible();
    await page.locator('[data-testid="builder-atom-menu-molecule"]').click();
    await expect(page.locator('[data-testid="builder-status-selection"]')).toHaveText(
      "24 selected",
    );

    // Pick a bonded pair and stretch the bond to 2.5 Å in the Inspector.
    // Measured between the pair chosen below (Undo clears the selection).
    let pair: [number, number] = [0, 0];
    const distance = () =>
      page.evaluate(([a, b]) => {
        const s = (
          window as unknown as {
            __megane_test_builder_store: {
              getState: () => { result: { snapshot: { positions: Float32Array } } };
            };
          }
        ).__megane_test_builder_store.getState();
        const p = s.result.snapshot.positions;
        return Math.hypot(
          p[a * 3] - p[b * 3],
          p[a * 3 + 1] - p[b * 3 + 1],
          p[a * 3 + 2] - p[b * 3 + 2],
        );
      }, pair);
    pair = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_builder_store: {
            getState: () => {
              result: { snapshot: { bonds: Uint32Array } };
              setSelected: (i: number[]) => void;
            };
          };
        }
      ).__megane_test_builder_store;
      const bonds = store.getState().result.snapshot.bonds;
      store.getState().setSelected([bonds[0], bonds[1]]);
      return [bonds[0], bonds[1]] as [number, number];
    });
    const bonded = await distance();
    expect(bonded).toBeGreaterThan(0.9);
    expect(bonded).toBeLessThan(1.6);
    await page.locator('[data-testid="builder-inspector-measure-input"]').fill("2.5");
    await page.locator('[data-testid="builder-inspector-measure-apply"]').click();
    await expect(page.locator('[data-testid="builder-inspector-measure"]')).toContainText(
      "2.500 Å",
    );
    expect(await distance()).toBeCloseTo(2.5, 3);

    // Clean up with the real RDKit worker: the bond goes back to a sane
    // length, the molecule stays in place, and one Undo takes it all back.
    await page.locator('[data-testid="builder-structure"]').click();
    await page.locator('[data-testid="builder-structure-cleanup"]').click();
    await expect(page.locator('[data-testid="builder-notice"]')).toContainText(
      "Cleaned up 1 molecule",
      { timeout: 90_000 },
    );
    const cleaned = await distance();
    expect(cleaned).toBeGreaterThan(0.9);
    expect(cleaned).toBeLessThan(1.6);
    await expect(root).toHaveAttribute("data-atom-count", "24");
    await page.locator('[data-testid="builder-topbar-undo"]').click();
    expect(await distance()).toBeCloseTo(2.5, 3);
  });

  test("adds library presets, places one with the Place tool, and keeps a Ketcher sketch", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const root = page.locator('[data-testid="megane-builder"]');
    const library = page.locator('[data-testid="builder-library"]');
    const openLibrary = async () => {
      await page.locator('[data-testid="builder-tool-place"]').click();
      await expect(library).toBeVisible();
    };
    // The library is the Place tool's gallery; the operations rail has no
    // Insert menu repeating it.
    await expect(page.locator('[data-testid="builder-insert"]')).toHaveCount(0);
    await expect(library).toHaveCount(0);
    await newEmptyCell(page);
    await waitForReady(page);
    await openLibrary();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("10 molecules");
    const water = page.locator('[data-testid="builder-library-item-preset:water"]');

    // With an empty cell, Add lands at the centre.
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
    // Choosing closes the gallery; the picker names the molecule and reopens it.
    await expect(library).toHaveCount(0);
    await expect(page.locator('[data-testid="builder-place-fragment"]')).toContainText("Methane");
    await page.locator('[data-testid="builder-place-fragment"]').click();
    await expect(methane).toHaveAttribute("data-placing", "true");
    await page.locator('[data-testid="builder-place-fragment"]').click();
    await expect(library).toHaveCount(0);
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
    // molecule set through its API is embedded in 3D by RDKit (the real
    // megane-rdkit WASM build, in a worker) with its implicit hydrogens.
    await page.locator('[data-testid="builder-place-fragment"]').click();
    await page.locator('[data-testid="builder-library-sketch"]').click();
    await expect(page.locator('[data-testid="sketch-modal"]')).toBeVisible();
    await page.waitForFunction(
      () => !!(window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher,
      null,
      { timeout: 60_000 },
    );
    const setSketch = async (smiles: string) => {
      await page.evaluate(async (s) => {
        const k = (
          window as unknown as {
            __megane_test_ketcher: { setMolecule: (s: string) => Promise<void> };
          }
        ).__megane_test_ketcher;
        await k.setMolecule(s);
      }, smiles);
    };
    await setSketch("CCO");
    await page.locator('[data-testid="sketch-name"]').fill("Ethanol sketch");
    await page.locator('[data-testid="sketch-add"]').click();
    await expect(page.locator('[data-testid="sketch-modal"]')).toHaveCount(0, { timeout: 60_000 });
    // The gallery the sketch was started from is still open, with the new molecule.
    await expect(library).toBeVisible();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("11 molecules");
    const sketched = page.locator('[data-testid="builder-library-item-name"]', {
      hasText: "Ethanol sketch",
    });
    await expect(sketched).toHaveCount(1);
    const row = page.locator('[data-testid^="builder-library-item-user:"]').first();
    // Ethanol drawn as C–C–O comes back as C2H6O: the six implicit hydrogens are added.
    await expect(row).toContainText("C2H6O");
    // An RDKit conformer is a 3D molecule, not a flat sketch.
    await expect(row).not.toContainText("flat");
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
    const at = (i: number) => sketchOp.positions.slice(i * 3, i * 3 + 3);
    const dist = (i: number, j: number) => Math.hypot(...at(i).map((v, k) => v - at(j)[k]));
    // MMFF94s geometry: C–C ≈ 1.52 Å, C–O ≈ 1.42 Å, C–H ≈ 1.09 Å, O–H ≈ 0.97 Å …
    expect(dist(0, 1)).toBeGreaterThan(1.45);
    expect(dist(0, 1)).toBeLessThan(1.6);
    expect(dist(1, 2)).toBeGreaterThan(1.35);
    expect(dist(1, 2)).toBeLessThan(1.5);
    for (const [i, j] of sketchOp.bonds) {
      const [a, b] = [sketchOp.elements[i], sketchOp.elements[j]];
      if (a === 1 || b === 1) {
        const heavy = a === 1 ? b : a;
        expect(dist(i, j)).toBeGreaterThan(heavy === 8 ? 0.9 : 1.0);
        expect(dist(i, j)).toBeLessThan(heavy === 8 ? 1.05 : 1.15);
      }
    }
    // … and a tetrahedral C–C–O angle (a flat Ketcher drawing has 120°).
    const v1 = at(0).map((v, k) => v - at(1)[k]);
    const v2 = at(2).map((v, k) => v - at(1)[k]);
    const cosAngle =
      (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (Math.hypot(...v1) * Math.hypot(...v2));
    const angle = (Math.acos(cosAngle) * 180) / Math.PI;
    expect(angle).toBeGreaterThan(100);
    expect(angle).toBeLessThan(116);
    // The hydrogens leave the heavy-atom plane on both sides: a real conformer.
    const normal = [
      v1[1] * v2[2] - v1[2] * v2[1],
      v1[2] * v2[0] - v1[0] * v2[2],
      v1[0] * v2[1] - v1[1] * v2[0],
    ];
    const nLen = Math.hypot(...normal);
    const heights = [3, 4, 5, 6, 7, 8].map((i) => {
      const d = at(i).map((v, k) => v - at(1)[k]);
      return (d[0] * normal[0] + d[1] * normal[1] + d[2] * normal[2]) / nLen;
    });
    expect(Math.max(...heights)).toBeGreaterThan(0.5);
    expect(Math.min(...heights)).toBeLessThan(-0.5);

    // Edit reopens the original drawing, not the conformer, and adding it
    // again embeds it again to the same geometry (RDKit's fixed seed).
    await row.locator('[data-testid="builder-library-edit"]').click();
    await expect(page.locator('[data-testid="sketch-modal"]')).toBeVisible();
    await page.waitForFunction(
      () => !!(window as unknown as { __megane_test_ketcher?: unknown }).__megane_test_ketcher,
      null,
      { timeout: 60_000 },
    );
    await expect(page.locator('[data-testid="sketch-name"]')).toHaveValue("Ethanol sketch");
    await page.locator('[data-testid="sketch-name"]').fill("Ethanol again");
    await page.locator('[data-testid="sketch-add"]').click();
    await expect(page.locator('[data-testid="sketch-modal"]')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("12 molecules");
    const againRow = page.locator('[data-testid^="builder-library-item-user:"]', {
      hasText: "Ethanol again",
    });
    await expect(againRow).toContainText("C2H6O");
    await expect(againRow).not.toContainText("flat");
    await againRow.locator('[data-testid="builder-library-add"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "38");
    await expect(root).toHaveAttribute("data-bond-count", "34");
    state = await builderState(page);
    const againOp = state.edits[4] as { positions: number[] };
    expect(againOp.positions.length).toBe(sketchOp.positions.length);
    for (let k = 0; k < againOp.positions.length; k++) {
      expect(Math.abs(againOp.positions[k] - sketchOp.positions[k])).toBeLessThan(1e-3);
    }

    // The user library survives a reload (localStorage); presets do not duplicate.
    await page.reload({ waitUntil: "domcontentloaded" });
    await newEmptyCell(page);
    await waitForReady(page);
    await openLibrary();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("12 molecules");
    await expect(sketched).toHaveCount(1);
    await row.locator('[data-testid="builder-library-remove"]').click();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("11 molecules");
    await againRow.locator('[data-testid="builder-library-remove"]').click();
    await expect(page.locator('[data-testid="builder-library-count"]')).toHaveText("10 molecules");
  });
  test("builds a bulk crystal, a supercell and a slab, then adsorbs a molecule on it", async ({
    page,
  }) => {
    const root = page.locator('[data-testid="megane-builder"]');

    // Bulk: the Cu fcc example in its conventional cell, from the File menu.
    await page.locator('[data-testid="builder-file"]').click();
    await page.locator('[data-testid="builder-new-bulk-item"]').click();
    await page.locator('[data-testid="builder-bulk-example"]').selectOption("Cu (fcc)");
    await page.locator('[data-testid="builder-bulk-create"]').click();
    await waitForReady(page);
    await expect(root).toHaveAttribute("data-atom-count", "4");
    await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText("Cu-fcc");
    await expect(page.locator('[data-testid="builder-crystal-cell-summary"]')).toHaveText(
      "3.61 × 3.61 × 3.61 Å",
    );

    // Supercell 2×2×1 from the Structure menu: the dialog announces the count
    // and the view previews the result before the op is written.
    await page.locator('[data-testid="builder-structure"]').click();
    await page.locator('[data-testid="builder-structure-supercell"]').click();
    await page.locator('[data-testid="builder-supercell-nc"]').fill("1");
    await expect(page.locator('[data-testid="builder-supercell-preview"]')).toHaveText(
      "4 images → 16 atoms",
    );
    await expect(page.locator('[data-testid="builder-status-atoms"]')).toHaveText(
      "16 atoms · 0 bonds",
    );
    await expect(root).toHaveAttribute("data-edit-count", "0");
    await expect(root).toHaveAttribute("data-atom-count", "4");
    // Cancel leaves the document as it was.
    await page.locator('[data-testid="builder-crystal-cancel"]').click();
    await expect(page.locator('[data-testid="builder-status-atoms"]')).toHaveText(
      "4 atoms · 0 bonds",
    );
    await page.locator('[data-testid="builder-structure"]').click();
    await page.locator('[data-testid="builder-structure-supercell"]').click();
    await page.locator('[data-testid="builder-supercell-nc"]').fill("1");
    await page.locator('[data-testid="builder-supercell-apply"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "16");
    await expect(page.locator('[data-testid="builder-op-list"]')).toContainText("Supercell 2×2×1");
    await expect(page.locator('[data-testid="builder-crystal-cell-summary"]')).toHaveText(
      "7.22 × 7.22 × 3.61 Å",
    );

    // Undo the supercell, cut a (111) slab from the unit cell instead.
    await page.locator('[data-testid="builder-topbar-undo"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "4");
    await page.locator('[data-testid="builder-structure"]').click();
    await page.locator('[data-testid="builder-structure-slab"]').click();
    await page.locator('[data-testid="builder-slab-layers"]').fill("3");
    await page.locator('[data-testid="builder-slab-vacuum"]').fill("10");
    await expect(page.locator('[data-testid="builder-slab-preview"]')).toContainText("12 atoms");
    await page.locator('[data-testid="builder-slab-apply"]').click();
    await expect(root).toHaveAttribute("data-atom-count", "12");
    await expect(page.locator('[data-testid="builder-op-list"]')).toContainText(
      "Slab (1 1 1), 3 layers, 10 Å vacuum",
    );
    let state = await builderState(page);
    expect(state.edits.map((e) => e.op)).toEqual(["slab"]);
    // The slab cell: a1 along x, the normal along z with the vacuum added.
    const slabBox = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_builder_store: {
            getState: () => { result: { snapshot: { box: Float32Array } } };
          };
        }
      ).__megane_test_builder_store;
      return Array.from(store.getState().result.snapshot.box);
    });
    // The (111) surface vector of the conventional cell is a face diagonal, a√2.
    expect(slabBox[0]).toBeCloseTo(3.61 * Math.SQRT2, 3);
    expect(slabBox[1]).toBeCloseTo(0, 5);
    expect(slabBox[8]).toBeGreaterThan(20);

    // Adsorb water 2 Å above a surface atom with the Place tool.
    await page.locator('[data-testid="builder-tool-place"]').click();
    await page
      .locator('[data-testid="builder-library-item-preset:water"]')
      .locator('[data-testid="builder-library-place"]')
      .click();
    await page.locator('[data-testid="builder-adsorb-toggle"]').check();
    await pickAtom(page, 11);
    await expect(root).toHaveAttribute("data-atom-count", "15");
    state = await builderState(page);
    expect(state.edits.map((e) => e.op)).toEqual(["slab", "add_fragment"]);
    const placed = state.edits[1] as { translate: [number, number, number] };
    const site = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_builder_store: {
            getState: () => {
              source: { positions: Float32Array };
              result: { snapshot: { positions: Float32Array } };
            };
          };
        }
      ).__megane_test_builder_store;
      // The slab atoms come first in the shown structure; atom 11 is the last of them.
      return Array.from(store.getState().result.snapshot.positions.slice(33, 36));
    });
    expect(placed.translate[0]).toBeCloseTo(site[0], 3);
    expect(placed.translate[1]).toBeCloseTo(site[1], 3);
    // (Water was placed with its centroid at the site + 2 Å, so the atoms are ~2 Å above.)
    expect(placed.translate[2]).toBeCloseTo(site[2] + 2, 3);

    // Structure › Set cell…: the form in the Details panel shows the slab cell
    // and setting a cell records the op.
    await page.locator('[data-testid="builder-structure"]').click();
    await page.locator('[data-testid="builder-structure-cell"]').click();
    await expect(page.locator('[data-testid="builder-cell-c"]')).toHaveValue(String(slabBox[8]));
    await page.locator('[data-testid="builder-cell-scale-atoms"]').uncheck();
    await page.locator('[data-testid="builder-cell-c"]').fill("30");
    await page.locator('[data-testid="builder-cell-apply"]').click();
    await expect(page.locator('[data-testid="builder-crystal-cell-summary"]')).toContainText(
      "× 30.00 Å",
    );
    await expect(root).toHaveAttribute("data-edit-count", "3");
    await expect(root).toHaveAttribute("data-atom-count", "15");

    // Save keeps working on the built structure.
    const download = page.waitForEvent("download");
    await saveAs(page, "xyz");
    expect((await download).suggestedFilename()).toBe("Cu-fcc.xyz");
  });
  test("keyboard shortcuts drive the tools and the history; sections remember their state", async ({
    page,
  }) => {
    const root = page.locator('[data-testid="megane-builder"]');
    await page.setInputFiles('[data-testid="builder-open-input"]', "tests/fixtures/caffeine.sdf");
    await waitForReady(page);
    await expect(root).toHaveAttribute("data-atom-count", "24");

    // A key picks the tool; the status bar says which one is active.
    await page.keyboard.press("d");
    await expect(page.locator('[data-testid="builder-tool-delete"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator('[data-testid="builder-status-tool"]')).toContainText("Delete (D)");
    await pickAtom(page, 0);
    await expect(root).toHaveAttribute("data-atom-count", "23");

    // Undo / redo without touching the buttons.
    await page.keyboard.press("Control+z");
    await expect(root).toHaveAttribute("data-atom-count", "24");
    await page.keyboard.press("Control+Shift+z");
    await expect(root).toHaveAttribute("data-atom-count", "23");

    // Select, then Delete removes the selection; Escape clears it.
    await page.keyboard.press("s");
    await pickAtom(page, 1);
    await pickAtom(page, 2);
    await expect(page.locator('[data-testid="builder-status-selection"]')).toHaveText("1 selected");
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="builder-status-selection"]')).toHaveCount(0);
    await pickAtom(page, 1);
    await page.keyboard.press("Delete");
    await expect(root).toHaveAttribute("data-atom-count", "22");
    await expect(root).toHaveAttribute("data-edit-count", "2");

    // Typing in a field is never a shortcut.
    await page.locator('[data-testid="builder-tool-add"]').click();
    await page.locator('[data-testid="builder-element-z"]').fill("8");
    await expect(page.locator('[data-testid="builder-tool-add"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // A panel opened by hand stays open across a reload: History starts
    // collapsed for a document without edits, unless you opened it.
    const reopen = async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.setInputFiles('[data-testid="builder-open-input"]', "tests/fixtures/caffeine.sdf");
      await waitForReady(page);
    };
    await reopen();
    await expect(page.locator('[data-testid="builder-undo"]')).toHaveCount(0);
    await page.locator('[data-testid="panel-history-toggle"]').click();
    await expect(page.locator('[data-testid="builder-undo"]')).toBeVisible();
    await reopen();
    await expect(page.locator('[data-testid="builder-undo"]')).toBeVisible();
  });
});
