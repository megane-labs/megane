/**
 * Selection Inspector E2E (webapp).
 *
 * Verifies the third pipeline tab: building a selection from element chips
 * writes the expression, the live selected-count updates, and — crucially —
 * the selection + appearance are reflected as real pipeline nodes (a
 * filter → color chain) visible in the Editor tab. Asserts DOM and store
 * state rather than pixels to stay robust against font/GL drift.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect } from "playwright/test";
import { waitForReady } from "./lib/setup";
import { findNodeIdByType, removeNode } from "./lib/pipeline";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

test.describe("inspector: webapp", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
  });

  test("builds a selection layer reflected as pipeline nodes", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    await expect(page.locator('[data-testid="pipeline-inspector"]')).toBeVisible();

    // Add a layer, then select carbons via the element chip.
    await page.locator('[data-testid="inspector-add-layer"]').click();
    const carbon = page.locator('[data-testid="inspector-chip-element-C"]');
    await expect(carbon).toBeVisible();
    await carbon.click();

    // Expression and live count reflect the chip choice.
    await expect(page.locator('[data-testid="inspector-query"]')).toHaveValue('element == "C"');
    await expect(page.locator('[data-testid="inspector-selected-count"]')).toContainText("atom");

    // Reflection: the Editor tab now shows the generated filter + color nodes.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await expect(page.locator('[data-testid="pipeline-node-filter"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="pipeline-node-color"]').first()).toBeVisible();

    // The generated nodes are Inspector-owned and carry the selection query.
    const info = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: {
            getState: () => {
              nodes: {
                id: string;
                type?: string;
                data: { params: Record<string, unknown> };
              }[];
            };
          };
        }
      ).__megane_test_pipeline_store;
      const nodes = store?.getState().nodes ?? [];
      const insp = nodes.filter((n) => n.id.startsWith("insp-"));
      const filter = insp.find((n) => n.type === "filter");
      const color = insp.find((n) => n.type === "color");
      return {
        count: insp.length,
        query: filter?.data.params.query,
        colorMode: color?.data.params.mode,
      };
    });
    expect(info.count).toBeGreaterThanOrEqual(2);
    expect(info.query).toBe('element == "C"');
    expect(info.colorMode).toBe("uniform");
  });

  test("editing the raw expression drives the live count and filter node", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    await page.locator('[data-testid="inspector-add-layer"]').click();

    const query = page.locator('[data-testid="inspector-query"]');
    await query.fill('element != "H"');
    await expect(page.locator('[data-testid="inspector-selected-count"]')).toContainText("atom");

    const filterQuery = await page.evaluate(() => {
      const store = (
        window as unknown as {
          __megane_test_pipeline_store?: {
            getState: () => {
              nodes: { id: string; type?: string; data: { params: Record<string, unknown> } }[];
            };
          };
        }
      ).__megane_test_pipeline_store;
      const nodes = store?.getState().nodes ?? [];
      return nodes.find((n) => n.id.startsWith("insp-") && n.type === "filter")?.data.params.query;
    });
    expect(filterQuery).toBe('element != "H"');
  });

  test("Quick style restyles the whole structure through pipeline nodes", async ({ page }) => {
    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    const panel = page.locator('[data-testid="quick-style"]');
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="quick-style-atom-scale"]').fill("0.5");
    await panel.locator('[data-testid="quick-style-bond-scale"]').fill("2");
    await panel.locator('[data-testid="quick-style-rep"]').selectOption("licorice");
    await panel.locator('[data-testid="quick-style-labels-element"]').click();

    const read = () =>
      page.evaluate(() => {
        const store = (
          window as unknown as {
            __megane_test_pipeline_store?: {
              getState: () => {
                nodes: { id: string; data: { params: Record<string, unknown> } }[];
                viewportState: {
                  particles: { scaleOverrides: Float32Array | null }[];
                  bonds: { scale: number }[];
                  labels: unknown[];
                  representationMode: string;
                };
              };
            };
          }
        ).__megane_test_pipeline_store;
        const s = store!.getState();
        return {
          owned: s.nodes
            .filter((n) => n.id.startsWith("insp-global-"))
            .map((n) => n.id)
            .sort(),
          atomScale: s.viewportState.particles[0]?.scaleOverrides?.[0] ?? null,
          bondScale: s.viewportState.bonds[0]?.scale ?? null,
          labels: s.viewportState.labels.length,
          rep: s.viewportState.representationMode,
        };
      });

    await expect
      .poll(async () => (await read()).owned)
      .toEqual(["insp-global-atoms", "insp-global-bonds", "insp-global-labels", "insp-global-rep"]);
    const styled = await read();
    expect(styled.atomScale).toBe(0.5);
    expect(styled.bondScale).toBe(2);
    expect(styled.labels).toBe(1);
    expect(styled.rep).toBe("licorice");

    // The nodes are ordinary pipeline nodes: the Editor shows them.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await expect(
      page.locator('[data-testid="pipeline-node-representation"]').first(),
    ).toBeVisible();

    // Reset removes every Quick Style node again.
    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    await panel.locator('[data-testid="quick-style-reset"]').click();
    await expect.poll(async () => (await read()).owned).toEqual([]);
  });

  test("Quick style draws coordination polyhedra and Reset removes them", async ({ page }) => {
    // The default pipeline's demo trajectory would stamp caffeine's frames onto
    // the perovskite; drop it before opening the fixture.
    await removeNode(page, await findNodeIdByType(page, "load_trajectory"));
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles(join(REPO_ROOT, "tests", "fixtures", "perovskite_srtio3.xyz"));
    await waitForReady(page, { needsData: true, timeout: 30_000 });

    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    const panel = page.locator('[data-testid="quick-style"]');
    await expect(panel.locator('[data-testid="quick-style-polyhedra-opacity"]')).toHaveCount(0);
    await panel.locator('[data-testid="quick-style-polyhedra"]').click();
    await panel.locator('[data-testid="quick-style-polyhedra-edges"]').click();
    await panel.locator('[data-testid="quick-style-polyhedra-opacity"]').fill("0.7");

    const read = () =>
      page.evaluate(() => {
        const store = (
          window as unknown as {
            __megane_test_pipeline_store?: {
              getState: () => {
                nodes: { id: string }[];
                viewportState: { meshes: { opacity: number; showEdges: boolean }[] };
              };
            };
          }
        ).__megane_test_pipeline_store;
        const s = store!.getState();
        return {
          owned: s.nodes
            .filter((n) => n.id.startsWith("insp-global-"))
            .map((n) => n.id)
            .sort(),
          meshes: s.viewportState.meshes.map((m) => ({
            opacity: m.opacity,
            showEdges: m.showEdges,
          })),
        };
      });

    // The TiO6 and SrO12 polyhedra, completed across the cell boundary, share one mesh.
    await expect
      .poll(async () => (await read()).meshes)
      .toEqual([{ opacity: 0.7, showEdges: true }]);
    expect((await read()).owned).toEqual(["insp-global-coord", "insp-global-poly"]);
    await expect(panel.locator('[data-testid="quick-style-polyhedra-notice"]')).toHaveCount(0);

    // The branch is ordinary pipeline nodes: the Editor shows them.
    await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
    await expect(
      page.locator('[data-testid="pipeline-node-polyhedron_generator"]').first(),
    ).toBeVisible();

    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    await panel.locator('[data-testid="quick-style-reset"]').click();
    await expect.poll(async () => (await read()).owned).toEqual([]);
    expect((await read()).meshes).toEqual([]);
  });
});

/**
 * A recolored atom must recolor the far half of every bond that reaches one of
 * its periodic copies. In GaN every Ga–N bond leaving the cell is drawn as a
 * stub to a copy of the atom across the boundary; those stubs kept Ga's
 * default green after Ga was colored pink in the Inspector, because a copy's
 * half took its element color, not its atom's.
 */
test.describe("inspector: recolor reaches bonds across the cell", () => {
  test("a Ga layer color recolors the bond stubs to Ga's periodic copies", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    const epoch = await page.evaluate(
      () =>
        (window as unknown as { __megane_test_ready: { renderEpoch: number } }).__megane_test_ready
          .renderEpoch,
    );
    await page
      .locator('[data-testid="load-structure-input"]')
      .first()
      .setInputFiles({
        name: "gan_wurtzite.vasp",
        mimeType: "text/plain",
        buffer: readFileSync(join(REPO_ROOT, "tests", "fixtures", "gan_wurtzite.vasp")),
      });
    await waitForReady(page, { untilEpoch: epoch + 1 });

    // Pixels in Ga's default color (VESTA green, 0.623 / 0.893 / 0.455), any shade.
    const { PNG } = await import("pngjs");
    const view = page.locator('[data-tour-anchor="viewport"]');
    const gaGreenPixels = async (): Promise<number> => {
      await page.mouse.move(1, 1);
      const png = PNG.sync.read(await view.screenshot());
      let n = 0;
      for (let i = 0; i < png.data.length; i += 4) {
        const r = png.data[i];
        const g = png.data[i + 1];
        const b = png.data[i + 2];
        if (g - r > 40 && g - b > 70) n++;
      }
      return n;
    };
    const before = await gaGreenPixels();
    expect(before, "Ga atoms and their bond halves start out green").toBeGreaterThan(5000);

    await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
    await page.locator('[data-testid="inspector-add-layer"]').click();
    await page.locator('[data-testid="inspector-chip-element-Ga"]').click();
    const colorEnabled = page.locator('[data-testid="inspector-color-enabled"]');
    if (!(await colorEnabled.isChecked())) await colorEnabled.check();
    await page.locator('[data-testid="inspector-color-value"]').fill("#ff69b4");

    // Only the pivot marker and axis inset stay green (~60 px here); the
    // stubs alone left ~2,600 before the fix.
    await expect.poll(gaGreenPixels, { timeout: 15_000 }).toBeLessThan(before * 0.02);
  });
});
