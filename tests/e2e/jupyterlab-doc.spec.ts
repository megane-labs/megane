/**
 * JupyterLab DocWidget E2E (M4).
 *
 * Opens a .pdb file directly via the megane DocWidget (the "MeganeReactView"
 * code path, not the anywidget/notebook path). Tests that the same
 * MeganeViewer renders correctly under JupyterLab and that the
 * "data-megane-context" attribute is set to "jupyterlab-doc" — proving the
 * test will catch a regression where the host context is misreported.
 */

import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  expectViewerRegionMatch,
} from "./lib/setup";
import {
  startJupyterLab,
  stopJupyterLab,
  openLabFile,
  type JupyterLabHandle,
} from "./lib/hosts/jupyterlab";
import { expectGifFile, openRenderModal, useSmallGifExport } from "./lib/render-modal";
import { expectTooltipNearCursor } from "./lib/tooltip";

const PLATFORM = "jupyterlab-doc";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const NOTEBOOK_DIR = join(REPO, "tests", "e2e", "notebooks");
const PORT = Number(process.env.MEGANE_LAB_DOC_PORT ?? 18889);
const TOKEN = "megane-e2e-doc";

interface DocFormatFixture {
  id: string;
  file: string;
  expectedAtoms?: number;
  /** When true, assert that data-total-frames is > 0 (trajectory rendering). */
  expectTrajectory?: boolean;
}

const FORMATS: DocFormatFixture[] = [
  { id: "pdb-1crn", file: "1crn.pdb", expectedAtoms: 327 },
  { id: "gro-water", file: "water.gro" },
  { id: "xyz-perovskite", file: "perovskite_srtio3.xyz" },
  { id: "mol-methane", file: "methane.mol" },
  { id: "sdf-ethanol", file: "ethanol.sdf" },
  { id: "cif-nacl", file: "nacl.cif" },
  { id: "lammps-water", file: "water.lammps" },
  { id: "xyz-water-multiframe", file: "water_multiframe.xyz", expectTrajectory: true },
  { id: "traj-water", file: "water.traj", expectTrajectory: true },
];

let lab: JupyterLabHandle | null = null;

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  if (!existsSync(join(REPO, "wheel-share/data/share/jupyter/labextensions/megane-jupyterlab"))) {
    throw new Error("megane labextension not built. Run `npm run build:lab`.");
  }
  mkdirSync(NOTEBOOK_DIR, { recursive: true });
  for (const f of FORMATS) {
    copyFileSync(join(REPO, "tests", "fixtures", f.file), join(NOTEBOOK_DIR, f.file));
  }
  lab = await startJupyterLab({
    port: PORT,
    token: TOKEN,
    notebookDir: NOTEBOOK_DIR,
    cwd: REPO,
    runtimeDir: "/tmp/megane-jupyter-doc-runtime",
  });
});

test.afterAll(() => {
  stopJupyterLab(lab);
  lab = null;
});

for (const f of FORMATS) {
  test(`DocWidget renders ${f.id} with jupyterlab-doc context`, async ({ page }) => {
    await openLabFile(page, { port: PORT, token: TOKEN, file: f.file });

    await assertDomContract(page, [
      ...defaultViewerContract({
        expectedAtoms: f.expectedAtoms,
        context: "jupyterlab-doc",
      }),
    ]);

    await expectFullPageMatch(page, PLATFORM, `${f.id}-doc`);
    await expectViewerRegionMatch(page, PLATFORM, `${f.id}-doc-viewer`);

    const viewer = page.locator('[data-testid="megane-viewer"]');
    const ctx = await viewer.getAttribute("data-megane-context");
    expect(ctx).toBe("jupyterlab-doc");

    if (f.expectTrajectory) {
      const totalFrames = Number(await viewer.getAttribute("data-total-frames"));
      expect(totalFrames, `${f.id}: expected trajectory frames`).toBeGreaterThan(0);
    }

    // The pipeline editor's LoadStructure node must reflect the file the
    // user actually opened, not the seed graph's literal default — guards
    // the bug PR-A2 fixed (clicking bond_change.traj while the pipeline
    // still showed caffeine_water.pdb).
    await expect(
      page.locator('[data-testid="load-structure-filename"]').first(),
      `${f.id}: load_structure node should display the opened file`,
    ).toHaveText(f.file);
  });
}

/**
 * Regression: Lumino gives every dock panel `contain: strict`, which makes the
 * panel (not the viewport) the containing block of the `position: fixed`
 * hover tooltip, so it used to render a sidebar-and-menubar's distance away
 * from the cursor.
 */
test("hover tooltip renders beside the cursor", async ({ page }) => {
  await openLabFile(page, { port: PORT, token: TOKEN, file: "1crn.pdb" });
  await assertDomContract(page, [
    ...defaultViewerContract({ expectedAtoms: 327, context: "jupyterlab-doc" }),
  ]);
  await expectTooltipNearCursor(page);
});

/**
 * Regression: opening a second structure file after a first one used to
 * leave the singleton pipeline store in an inconsistent state because every
 * DocBody mutates it on mount and the previously-opened tab continued to
 * subscribe. The current tab's `MeganeReactView.onAfterShow` now re-runs
 * the load when activated, so switching tabs deterministically restores
 * the active document's data.
 */
test("DocWidget recovers when switching between two open files", async ({ page }) => {
  await openLabFile(page, { port: PORT, token: TOKEN, file: "1crn.pdb" });

  // JupyterLab does not expose its app instance globally; the megane
  // labextension publishes it on `window.jupyterapp` only when the page
  // sets `__MEGANE_TEST__=true` (set by `openLabFile`).
  const opened = await page.evaluate(async (fileName) => {
    const w = window as unknown as {
      jupyterapp?: { commands: { execute: (id: string, args?: unknown) => Promise<unknown> } };
    };
    if (!w.jupyterapp) return false;
    await w.jupyterapp.commands.execute("docmanager:open", {
      path: fileName,
      factory: "megane Molecular Viewer",
    });
    return true;
  }, "water.gro");
  expect(opened, "labextension must expose window.jupyterapp under __MEGANE_TEST__").toBe(true);

  // Wait for a second viewer instance to mount and report a non-zero atom count.
  await page.waitForFunction(
    () => {
      const viewers = document.querySelectorAll('[data-testid="megane-viewer"]');
      if (viewers.length < 2) return false;
      const last = viewers[viewers.length - 1];
      const atoms = Number(last?.getAttribute("data-atom-count") ?? "0");
      return atoms > 0;
    },
    null,
    { timeout: 30_000 },
  );

  // The currently-visible tab's atom count must reflect water.gro, not 1crn.
  // We can't directly identify visibility, but Jupyter sets the active tab
  // as the last-rendered widget — assert any visible viewer reports the
  // small water.gro atom count instead of 1crn's 327.
  const visibleAtoms = await page.evaluate(() => {
    const viewers = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="megane-viewer"]'),
    );
    const visible = viewers.find((v) => v.offsetParent !== null);
    return Number(visible?.getAttribute("data-atom-count") ?? "0");
  });
  expect(visibleAtoms, "second-opened file should drive the visible viewer").toBeGreaterThan(0);
  expect(visibleAtoms).not.toBe(327);
});

/**
 * The Load Structure node's "Open from server..." browses the Jupyter server's
 * files (the Contents API) — the files the browser's own dialog can't reach
 * when JupyterLab runs on another machine — and loads the chosen one.
 */
test("Load Structure opens a file from the Jupyter server", async ({ page }) => {
  await openLabFile(page, { port: PORT, token: TOKEN, file: "1crn.pdb" });
  const viewer = page.locator('[data-testid="megane-viewer"]');
  await expect(viewer).toHaveAttribute("data-atom-count", "327");

  // The pipeline panel starts collapsed in a narrow editor pane.
  const panel = page.locator('[data-testid="panel-pipeline"]').first();
  if ((await panel.getAttribute("data-collapsed")) === "true") {
    await page.locator('[data-testid="panel-pipeline-toggle"]').first().click();
  }
  await page.locator('[data-testid="pipeline-editor-tab-editor"]').first().click();
  await page.locator('[data-testid="pipeline-node-load_structure"]').first().click();
  const button = page.locator('[data-testid="load-structure-remote"]').first();
  await expect(button).toHaveText("Open from server...");
  await button.click();

  const dialog = page.locator('[data-testid="remote-file-dialog"]');
  await expect(dialog).toBeVisible();
  const water = dialog.locator('[data-testid="remote-file-dialog-entry"][data-name="water.gro"]');
  await expect(water).toBeEnabled();
  await water.dblclick();
  await expect(dialog).toHaveCount(0);

  await expect(page.locator('[data-testid="load-structure-filename"]').first()).toHaveText(
    "water.gro",
  );
  await expect.poll(async () => Number(await viewer.getAttribute("data-atom-count"))).not.toBe(327);
});

/**
 * Regression test for issue #497 — the JupyterLab half of the GIF-export bug
 * whose VSCode twin is #599 (see tests/e2e/vscode.spec.ts).
 *
 * gif.js encodes in a Web Worker, and the labextension serves its assets from
 * a different base path than the document, so resolving that worker as a URL
 * used to 404 and feed gif.js an HTML error page. gif.js never listens for its
 * worker's onerror, so the encode froze at 80% and produced no download at all.
 * The unit tests pin the worker-source contract; only a real browser proves the
 * bundled labextension can actually finish an encode.
 */
test("GIF export completes in the DocWidget (issue #497)", async ({ page }) => {
  await openLabFile(page, { port: PORT, token: TOKEN, file: "water_multiframe.xyz" });

  const viewer = page.locator('[data-testid="megane-viewer"]').last();
  await expect(viewer).toHaveAttribute("data-megane-context", "jupyterlab-doc");
  expect(Number(await viewer.getAttribute("data-total-frames"))).toBeGreaterThan(1);

  // Export failures surface as an alert(); report its text rather than waiting
  // out the download timeout.
  let exportError: string | null = null;
  page.on("dialog", (dialog) => {
    exportError = dialog.message();
    void dialog.dismiss();
  });

  await openRenderModal(page);
  await useSmallGifExport(page);

  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator('[data-testid="render-modal-export"]').click();

  const file = await download;
  expect(exportError, `export alert: ${exportError}`).toBeNull();
  expect(file.suggestedFilename()).toBe("megane-render.gif");
  expectGifFile(await file.path());
});
