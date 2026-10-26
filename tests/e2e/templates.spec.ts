/**
 * Pipeline template E2E — the templates whose scenes are built from more than
 * a plain structure-plus-viewport graph.
 *
 * "ESP Map" pairs a molecule with two volumetric grids (one contoured, one
 * coloring the contour); "Coarse-Grained Overlay" pairs two structures in one
 * Viewport. Both go through code paths no other template exercises
 * (`load_volumetric`'s ephemeral data addressed by node id, and a second
 * `load_structure` node addressed by id). "Protein" fetches its PDB as an
 * emitted asset and splits it into four selection branches; "Surface Mesh"
 * wraps a nanoparticle in an alpha-shape envelope; "Solid" reaches its
 * Coordination node through Symmetry, Wrap and Drawing Boundary, which once
 * left the node's element lists empty. All of them would fail
 * silently — an empty or uncolored isosurface, a missing bead layer, a filter
 * that selects nothing — rather than throw, so the checks here assert the
 * scene actually arrived rather than just that the graph mounted.
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
/** 1hsg.pdb: 1514 protein + 45 indinavir (MK1) + 127 crystallographic waters. */
const ATOM_COUNT_PROTEASE = 1686;
/** au_nanoparticle.xyz: a Wulff-shaped fcc Au cluster. */
const ATOM_COUNT_AU_PARTICLE = 1385;
/**
 * 1ubq's 660 atoms: 602 protein + 58 crystallographic waters. Both the
 * `data-atom-count` attribute and `__megane_test_ready.atomCount` report the
 * *primary* structure only, so the overlay's 76 coarse-grained beads are
 * counted separately, through the per-loader snapshots.
 */
const ATOM_COUNT_UBIQUITIN = 660;
const BEAD_COUNT_UBIQUITIN = 76;
/** perovskite_srtio3_3x3x3.xyz: 27 Sr, 27 Ti, 81 O. */
const ATOM_COUNT_SRTIO3 = 135;

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
          nodeErrors: Record<string, unknown[]>;
          viewportState: {
            particles: Array<{ sourceNodeId: string; indices: Uint32Array | null }>;
            bonds: Array<{ nBonds: number }>;
            meshes: Array<{
              positions: Float32Array | number[];
              colors: Float32Array | number[];
            }>;
            representationMode: string;
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
      particleSelectionSizes: state.viewportState.particles.map((p) =>
        p.indices === null ? "all" : p.indices.length,
      ),
      bondCounts: state.viewportState.bonds.map((b) => b.nBonds),
      meshVertexCounts: state.viewportState.meshes.map((m) => m.positions.length / 3),
      // Vertices clearly red (r - b > 0.4) and clearly blue (b - r > 0.4):
      // a volume-colored ESP surface has both, a solid one neither.
      meshRedBlue: state.viewportState.meshes.map((m) => {
        let red = 0;
        let blue = 0;
        for (let i = 0; i + 2 < m.colors.length; i += 4) {
          if (m.colors[i] - m.colors[i + 2] > 0.4) red++;
          if (m.colors[i + 2] - m.colors[i] > 0.4) blue++;
        }
        return [red, blue];
      }),
      erroredNodes: Object.keys(state.nodeErrors).filter((id) => state.nodeErrors[id].length > 0),
      representationMode: state.viewportState.representationMode,
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

  test("ESP Map renders caffeine inside a density surface colored by its potential", async ({
    page,
  }) => {
    await applyTemplate(page, "esp");
    await expect
      .poll(async () => (await getReadyState(page)).atomCount, { timeout: 30_000 })
      .toBe(ATOM_COUNT_CAFFEINE);

    await assertDomContract(page, [
      ...defaultViewerContract({ expectedAtoms: ATOM_COUNT_CAFFEINE, context: "webapp" }),
      { testid: "pipeline-node-load_volumetric", visible: true, count: 2 },
      { testid: "pipeline-node-isosurface", visible: true },
    ]);

    // Both cubes reached their nodes: the voxel-count readout replaces the
    // "No volumetric file loaded" placeholder only once parsing succeeded.
    const volumetricNodes = page.locator('[data-testid="pipeline-node-load_volumetric"]');
    for (let i = 0; i < 2; i++) {
      await expect(volumetricNodes.nth(i)).toContainText(/\d+×\d+×\d+ voxels/);
    }
    await expect(page.locator('[data-testid="load-volumetric-error"]')).toHaveCount(0);

    // The surface carries the potential, not the solid fallback color: wait
    // for the second grid to land and repaint the mesh.
    await expect
      .poll(
        async () => {
          const [red, blue] = (await viewportSummary(page)).meshRedBlue[0] ?? [0, 0];
          return red > 0 && blue > 0;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const summary = await viewportSummary(page);
    // Caffeine's 25 SDF bonds, and a marching-cubes mesh with real geometry —
    // an iso level outside the data range would still produce a mesh entry,
    // but an empty one.
    expect(summary.bondCounts).toEqual([25]);
    expect(summary.meshVertexCounts).toHaveLength(1);
    expect(summary.meshVertexCounts[0]).toBeGreaterThan(1000);

    await expectFullPageMatch(page, PLATFORM, "esp-map");
    await expectViewerRegionMatch(page, PLATFORM, "esp-map-viewer");
  });

  test("Protein renders the protease cartoon with indinavir and its contact waters", async ({
    page,
  }) => {
    await applyTemplate(page, "protein");
    await expect
      .poll(async () => (await getReadyState(page)).atomCount, { timeout: 30_000 })
      .toBe(ATOM_COUNT_PROTEASE);

    await assertDomContract(page, [
      ...defaultViewerContract({ expectedAtoms: ATOM_COUNT_PROTEASE, context: "webapp" }),
      { testid: "pipeline-node-filter", visible: true, count: 5 },
    ]);

    const summary = await viewportSummary(page);
    // No filter came back empty or invalid — "MK1" ends in a digit, so a
    // regression in resname matching shows up here as "Filter returned 0 atoms".
    expect(summary.erroredNodes).toEqual([]);
    // Polymer, indinavir, contact waters, bulk waters: disjoint and complete.
    expect(summary.particleSelectionSizes).toEqual([1514, 45, 7, 120]);
    expect(summary.representationMode).toBe("both");

    await expectFullPageMatch(page, PLATFORM, "protein");
    await expectViewerRegionMatch(page, PLATFORM, "protein-viewer");
  });

  test("Surface Mesh wraps the gold nanoparticle in one alpha-shape envelope", async ({ page }) => {
    await applyTemplate(page, "surface_mesh");
    await expect
      .poll(async () => (await getReadyState(page)).atomCount, { timeout: 30_000 })
      .toBe(ATOM_COUNT_AU_PARTICLE);

    await assertDomContract(page, [
      ...defaultViewerContract({ expectedAtoms: ATOM_COUNT_AU_PARTICLE, context: "webapp" }),
      { testid: "pipeline-node-surface_mesh", visible: true },
    ]);

    const summary = await viewportSummary(page);
    expect(summary.erroredNodes).toEqual([]);
    expect(summary.bondCounts).toEqual([]);
    expect(summary.meshVertexCounts).toHaveLength(1);
    expect(summary.meshVertexCounts[0]).toBeGreaterThan(1000);

    await expectFullPageMatch(page, PLATFORM, "surface-mesh");
    await expectViewerRegionMatch(page, PLATFORM, "surface-mesh-viewer");
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

  test("Solid lets Coordination pick its centers by element list or by query", async ({ page }) => {
    await applyTemplate(page, "solid");
    await expect
      .poll(async () => (await viewportSummary(page)).snapshotAtomCounts["loader-1"], {
        timeout: 30_000,
      })
      .toBe(ATOM_COUNT_SRTIO3);
    const meshVertices = async () => (await viewportSummary(page)).meshVertexCounts[0] ?? 0;
    await expect.poll(meshVertices, { timeout: 30_000 }).toBeGreaterThan(0);
    const both = await viewportSummary(page);
    expect(both.erroredNodes).toEqual([]);

    // Coordination reaches the structure through Symmetry → Wrap → Drawing
    // Boundary; its element lists used to read "None detected" here.
    await page.locator('[data-testid="pipeline-node-coordination_generator"]').first().click();
    const sr = page.getByRole("checkbox", { name: "Sr", exact: true });
    await expect(sr).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Ti", exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "O", exact: true })).toBeVisible();
    await expect(page.getByText("None detected")).toHaveCount(0);

    // Sr–O (2.76 Å) is inside the cutoff, so Sr cuboctahedra are drawn next to
    // the TiO6 octahedra until Sr is unticked.
    await sr.uncheck();
    await expect.poll(meshVertices).toBeLessThan(both.meshVertexCounts[0]);
    const tiOnly = await viewportSummary(page);
    await sr.check();
    await expect.poll(meshVertices).toBe(both.meshVertexCounts[0]);

    // A center query builds the same TiO6-only scene and replaces the list.
    const centerQuery = page.getByLabel("Center query");
    await centerQuery.fill('element == "Ti"');
    await centerQuery.press("Enter");
    await expect.poll(meshVertices).toBe(tiOnly.meshVertexCounts[0]);
    expect((await viewportSummary(page)).bondCounts).toEqual(tiOnly.bondCounts);
    await expect(sr).toHaveCount(0);
  });
});
