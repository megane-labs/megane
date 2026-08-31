/**
 * Pipeline template E2E — the two templates that need more than a single
 * structure file to render.
 *
 * "ESP Isosurface" pairs a molecule with a volumetric grid; "Coarse-Grained
 * Overlay" pairs two structures in one Viewport. Both go through code paths no
 * other template exercises (`load_volumetric`'s ephemeral data, and a second
 * `load_structure` node addressed by id), and both would fail silently — an
 * empty isosurface, a missing bead layer — rather than throw, so the checks
 * here assert the scene actually arrived rather than just that the graph
 * mounted.
 */

import { test, expect, type Page } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  expectViewerRegionMatch,
  getReadyState,
  waitForReady,
} from "./lib/setup";

const PLATFORM = "templates";

/** Atoms in each template's scene. */
const ATOM_COUNT_CAFFEINE = 24;
/**
 * 1ubq's 660 atoms: 602 protein + 58 crystallographic waters. Both the
 * `data-atom-count` attribute and `__megane_test_ready.atomCount` report the
 * *primary* structure only, so the overlay's 76 coarse-grained beads are
 * counted separately, through the per-loader snapshots.
 */
const ATOM_COUNT_UBIQUITIN = 660;
const BEAD_COUNT_UBIQUITIN = 76;

/** Open the Templates dropdown and apply the template with this id. */
async function applyTemplate(page: Page, templateId: string): Promise<void> {
  await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
  await page.locator('[data-testid="pipeline-editor-templates"]').click();
  await page.locator(`[data-testid="pipeline-template-${templateId}"]`).click();
}

/**
 * The pipeline store's live state, for the assertions the DOM does not carry:
 * `data-atom-count` reports only the primary structure, and nothing on the
 * page says whether the isosurface mesh has geometry.
 */
async function viewportSummary(page: Page) {
  return page.evaluate(() => {
    const w = window as Window & {
      __megane_test_pipeline_store?: {
        getState: () => {
          nodes: Array<{ id: string; type?: string }>;
          nodeSnapshots: Record<string, { snapshot: { nAtoms: number } }>;
          viewportState: {
            particles: Array<{ sourceNodeId: string }>;
            bonds: Array<{ nBonds: number }>;
            meshes: Array<{ positions: Float32Array | number[] }>;
          };
        };
      };
    };
    const store = w.__megane_test_pipeline_store;
    if (!store) throw new Error("__megane_test_pipeline_store not exposed; testMode off?");
    const state = store.getState();
    return {
      loaderNodeIds: state.nodes.filter((n) => n.type === "load_structure").map((n) => n.id),
      snapshotAtomCounts: Object.fromEntries(
        Object.entries(state.nodeSnapshots).map(([id, s]) => [id, s.snapshot.nAtoms]),
      ),
      particleSources: state.viewportState.particles.map((p) => p.sourceNodeId),
      bondCounts: state.viewportState.bonds.map((b) => b.nBonds),
      meshVertexCounts: state.viewportState.meshes.map((m) => m.positions.length / 3),
    };
  });
}

test.describe("pipeline templates: data-heavy scenes", () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the tour: its driver.js overlay swallows toolbar clicks.
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
  });

  test("ESP Isosurface renders caffeine plus both potential lobes", async ({ page }) => {
    await applyTemplate(page, "esp");
    await expect
      .poll(async () => (await getReadyState(page)).atomCount, { timeout: 30_000 })
      .toBe(ATOM_COUNT_CAFFEINE);

    await assertDomContract(page, [
      ...defaultViewerContract({ expectedAtoms: ATOM_COUNT_CAFFEINE, context: "webapp" }),
      { testid: "pipeline-node-load_volumetric", visible: true },
      { testid: "pipeline-node-isosurface", visible: true },
    ]);

    // The cube reached the node: its voxel-count readout replaces the
    // "No volumetric file loaded" placeholder only once parsing succeeded.
    await expect(page.locator('[data-testid="pipeline-node-load_volumetric"]')).toContainText(
      /\d+×\d+×\d+ voxels/,
    );
    await expect(page.locator('[data-testid="load-volumetric-error"]')).toHaveCount(0);

    const summary = await viewportSummary(page);
    // Caffeine's 25 SDF bonds, and a marching-cubes mesh with real geometry —
    // an iso level outside the data range would still produce a mesh entry,
    // but an empty one.
    expect(summary.bondCounts).toEqual([25]);
    expect(summary.meshVertexCounts).toHaveLength(1);
    expect(summary.meshVertexCounts[0]).toBeGreaterThan(100);

    await expectFullPageMatch(page, PLATFORM, "esp-isosurface");
    await expectViewerRegionMatch(page, PLATFORM, "esp-isosurface-viewer");
  });

  test("Coarse-Grained Overlay renders both structures in one viewport", async ({ page }) => {
    await applyTemplate(page, "coarse_grained");
    await expect
      .poll(async () => (await getReadyState(page)).atomCount, { timeout: 30_000 })
      .toBe(ATOM_COUNT_UBIQUITIN);

    await assertDomContract(page, [
      ...defaultViewerContract({ expectedAtoms: ATOM_COUNT_UBIQUITIN, context: "webapp" }),
      { testid: "pipeline-node-color", visible: true },
    ]);

    const summary = await viewportSummary(page);
    // Both loaders present, both filled — the second one only gets a snapshot
    // if `loadTemplateStructureInto` found it by id.
    expect(summary.loaderNodeIds).toEqual(["loader-aa", "loader-cg"]);
    expect(summary.snapshotAtomCounts["loader-aa"]).toBe(ATOM_COUNT_UBIQUITIN);
    expect(summary.snapshotAtomCounts["loader-cg"]).toBe(BEAD_COUNT_UBIQUITIN);
    // Three particle streams reach the Viewport: the ghosted protein, the
    // hidden waters, and the beads. Two distinct sources — that is what makes
    // the two models render as separate overlaid structure layers.
    expect(summary.particleSources).toEqual(["loader-aa", "loader-aa", "loader-cg"]);
    // Exactly one bond stream: the 75 CONECT records joining consecutive
    // beads. The all-atom ghost is atoms only (1UBQ carries no protein CONECT).
    expect(summary.bondCounts).toEqual([BEAD_COUNT_UBIQUITIN - 1]);

    await expectFullPageMatch(page, PLATFORM, "coarse-grained-overlay");
    await expectViewerRegionMatch(page, PLATFORM, "coarse-grained-overlay-viewer");
  });
});
