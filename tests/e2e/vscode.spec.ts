/**
 * VSCode custom editor E2E (M3).
 *
 * Opens .pdb directly in the megane custom editor (registered by
 * vscode-megane/src/extension.ts as `megane.structureViewer`) under
 * code-server. The webview's React root mounts MeganeViewer with
 * `data-megane-context="vscode"`.
 *
 * Prereqs (run once per machine):
 *   - `bash scripts/install-code-server.sh`
 *   - `npm --prefix vscode-megane run build && npm --prefix vscode-megane run package`
 *
 * Test-mode injection: MEGANE_E2E_MODE=1 is plumbed through to the
 * extension host via env, which causes the webview HTML preamble to set
 * `window.__MEGANE_TEST__ = true` before the bundle loads.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  expectViewerRegionMatch,
} from "./lib/setup";
import { expectGifFile, openRenderModal, useSmallGifExport } from "./lib/render-modal";
import {
  startCodeServer,
  stopCodeServer,
  openVscodeFile,
  type CodeServerHandle,
} from "./lib/hosts/code-server";

const PLATFORM = "vscode";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const WORKSPACE = "/workspace";
const PORT = Number(process.env.MEGANE_VSCODE_PORT ?? 18991);

interface FormatFixture {
  /** Slug used in baseline filenames. */
  id: string;
  /** Filename inside `tests/fixtures/`. */
  file: string;
  /** Atom count exposed via data-atom-count when the parser succeeds. */
  expectedAtoms?: number;
  /** When true, assert that data-total-frames is > 0 (trajectory rendering). */
  expectTrajectory?: boolean;
}

/**
 * Each format the megane custom editor advertises in
 * `vscode-megane/package.json` (`customEditors[].selector`). Atom counts
 * mirror the fixtures used by `format-loading.spec.ts` so a regression
 * in the WASM parser surfaces here too. Trajectory fixtures additionally
 * verify that frames are detected and the playback bar can engage.
 */
const FORMATS: FormatFixture[] = [
  { id: "pdb-1crn", file: "1crn.pdb", expectedAtoms: 327 },
  { id: "gro-water", file: "water.gro" },
  { id: "xyz-perovskite", file: "perovskite_srtio3.xyz" },
  { id: "mol-methane", file: "methane.mol" },
  { id: "sdf-ethanol", file: "ethanol.sdf" },
  { id: "cif-nacl", file: "nacl.cif" },
  // Symmetry-op-carrying CIF: 10-atom asymmetric unit × 4 general positions.
  // The seed pipeline's symmetry node (expand mode) must fill the unit cell
  // automatically when the custom editor opens the file.
  { id: "cif-glycine-csd", file: "glycine_csd.cif", expectedAtoms: 40 },
  { id: "lammps-water", file: "water.lammps" },
  { id: "xyz-water-multiframe", file: "water_multiframe.xyz", expectTrajectory: true },
  { id: "traj-water", file: "water.traj", expectTrajectory: true },
];

let cs: CodeServerHandle | null = null;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  mkdirSync(WORKSPACE, { recursive: true });
  for (const f of FORMATS) {
    copyFileSync(join(REPO, "tests", "fixtures", f.file), join(WORKSPACE, f.file));
  }
  cs = await startCodeServer({ port: PORT, workspace: WORKSPACE, e2eMode: true });
});

test.afterAll(() => {
  stopCodeServer(cs);
  cs = null;
});

for (const f of FORMATS) {
  test(`vscode custom editor opens ${f.id} with vscode context`, async ({ page }) => {
    const wv = await openVscodeFile(page, { port: PORT, file: f.file });

    await assertDomContract(wv, [
      ...defaultViewerContract({
        expectedAtoms: f.expectedAtoms,
        context: "vscode",
      }),
    ]);

    await expectFullPageMatch(page, PLATFORM, `${f.id}-vscode`);
    await expectViewerRegionMatch(wv, PLATFORM, `${f.id}-vscode-viewer`);

    const viewer = wv.locator('[data-testid="megane-viewer"]');
    const ctx = await viewer.getAttribute("data-megane-context");
    expect(ctx).toBe("vscode");

    if (f.expectTrajectory) {
      const totalFrames = Number(await viewer.getAttribute("data-total-frames"));
      expect(totalFrames, `${f.id}: expected trajectory frames`).toBeGreaterThan(0);
    }
  });
}

test("render export is saved through the extension-host saveFile bridge", async ({ page }) => {
  // In MEGANE_E2E_MODE the extension host skips the native save dialog and
  // writes next to the open document, so the export lands in the workspace.
  const exported = join(WORKSPACE, "megane-render.png");
  rmSync(exported, { force: true });

  const wv = await openVscodeFile(page, { port: PORT, file: "1crn.pdb" });
  await assertDomContract(wv, [
    ...defaultViewerContract({ expectedAtoms: 327, context: "vscode" }),
  ]);

  await openRenderModal(wv);
  await wv.locator('[data-testid="render-modal-export"]').click();

  await expect
    .poll(() => existsSync(exported), {
      message: "expected the extension host to write megane-render.png into the workspace",
      timeout: 60_000,
    })
    .toBe(true);
});

/**
 * Regression test for issue #599: "Cannot find rendered GIF file".
 *
 * PNG/MP4 export worked in the VSCode webview while GIF silently hung at 80%,
 * because GIF is the only export that spawns a Web Worker: gif.js loaded its
 * worker from a URL the webview could not serve, and it never listens for the
 * worker's onerror, so no Blob was produced and the saveFile bridge (and with
 * it the save dialog) was never reached.
 *
 * This asserts the file actually lands on disk. It only holds inside a real
 * webview — the host CSP, the `vscode-webview` origin, and the built bundle's
 * asset URLs are all part of the bug — so it cannot be moved to a unit test or
 * to the webapp project, which serves from the origin root and never failed.
 */
test("GIF export reaches the saveFile bridge (issue #599)", async ({ page }) => {
  const exported = join(WORKSPACE, "megane-render.gif");
  rmSync(exported, { force: true });

  // A trajectory is required — the Animation tab is disabled for single-frame
  // structures.
  const wv = await openVscodeFile(page, { port: PORT, file: "water_multiframe.xyz" });
  await assertDomContract(wv, [...defaultViewerContract({ context: "vscode" })]);

  const viewer = wv.locator('[data-testid="megane-viewer"]');
  expect(Number(await viewer.getAttribute("data-total-frames"))).toBeGreaterThan(1);

  await openRenderModal(wv);
  await useSmallGifExport(wv);

  await wv.locator('[data-testid="render-modal-export"]').click();

  await expect
    .poll(() => (existsSync(exported) ? statSync(exported).size : 0), {
      message:
        "expected the extension host to write megane-render.gif into the workspace — " +
        "an empty poll means gif.js never finished encoding (the #599 hang)",
      timeout: 180_000,
    })
    .toBeGreaterThan(100);

  expectGifFile(exported);
});
