/**
 * Selection Inspector E2E (webapp).
 *
 * Verifies the third pipeline tab: building a selection from element chips
 * writes the expression, the live selected-count updates, and — crucially —
 * the selection + appearance are reflected as real pipeline nodes (a
 * filter → color chain) visible in the Editor tab. Asserts DOM and store
 * state rather than pixels to stay robust against font/GL drift.
 */

import { test, expect } from "playwright/test";
import { waitForReady } from "./lib/setup";

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
});
