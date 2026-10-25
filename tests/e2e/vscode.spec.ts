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

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
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
import { expectTooltipNearCursor } from "./lib/tooltip";

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

/**
 * A `.megane.json` whose Load Structure node names a *binary* structure file
 * (ASE `.traj`). The extension host must send the companion as bytes; it used
 * to decode Load Structure companions as UTF-8 text, which corrupted the file
 * so the pipeline opened with no atoms.
 */
const BINARY_PIPELINE = "water_traj.megane.json";
const BINARY_PIPELINE_JSON = {
  version: 3,
  nodes: [
    {
      id: "load-1",
      type: "load_structure",
      fileName: "water.traj",
      hasTrajectory: true,
      hasCell: false,
      position: { x: 0, y: 0 },
      enabled: true,
    },
    {
      id: "viewport-1",
      type: "viewport",
      perspective: false,
      cellAxesVisible: true,
      pivotMarkerVisible: true,
      position: { x: 400, y: 0 },
      enabled: true,
    },
  ],
  edges: [
    { source: "load-1", sourceHandle: "particle", target: "viewport-1", targetHandle: "particle" },
  ],
};

/**
 * A multi-frame XYZ larger than the extension's 8 MB head + 4 MB tail, so the
 * host posts it in pieces (src/hosts/progressiveFile.ts): frame 0 is drawn
 * from the head, and every frame must still be there once the rest arrives.
 */
const PROGRESSIVE_XYZ = "progressive_1000x420.xyz";
const PROGRESSIVE_ATOMS = 1000;
const PROGRESSIVE_FRAMES = 420;

function progressiveXyz(): string {
  const parts: string[] = [];
  for (let f = 0; f < PROGRESSIVE_FRAMES; f++) {
    parts.push(`${PROGRESSIVE_ATOMS}\nframe ${f}\n`);
    for (let i = 0; i < PROGRESSIVE_ATOMS; i++) {
      const x = (i % 10) * 3 + 0.1 * Math.sin(f + i);
      const y = (Math.floor(i / 10) % 10) * 3;
      const z = Math.floor(i / 100) * 3;
      parts.push(`Ar ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}\n`);
    }
  }
  return parts.join("");
}

let cs: CodeServerHandle | null = null;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  mkdirSync(WORKSPACE, { recursive: true });
  for (const f of FORMATS) {
    copyFileSync(join(REPO, "tests", "fixtures", f.file), join(WORKSPACE, f.file));
  }
  writeFileSync(join(WORKSPACE, BINARY_PIPELINE), JSON.stringify(BINARY_PIPELINE_JSON, null, 2));
  writeFileSync(join(WORKSPACE, PROGRESSIVE_XYZ), progressiveXyz());
  cs = await startCodeServer({ port: PORT, workspace: WORKSPACE, e2eMode: true });
});

test.afterAll(() => {
  stopCodeServer(cs);
  cs = null;
});

test("a file larger than head + tail arrives in pieces and keeps every frame", async ({ page }) => {
  expect(statSync(join(WORKSPACE, PROGRESSIVE_XYZ)).size).toBeGreaterThan(12 * 1024 * 1024);
  const wv = await openVscodeFile(page, {
    port: PORT,
    file: PROGRESSIVE_XYZ,
    waitTimeoutMs: 120_000,
  });
  const viewer = wv.locator('[data-testid="megane-viewer"]');
  await expect(viewer).toHaveAttribute("data-atom-count", String(PROGRESSIVE_ATOMS));
  await expect
    .poll(async () => Number(await viewer.getAttribute("data-total-frames")), { timeout: 120_000 })
    .toBe(PROGRESSIVE_FRAMES);
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

test("pipeline editor opens a .megane.json whose structure companion is binary (.traj)", async ({
  page,
}) => {
  const wv = await openVscodeFile(page, { port: PORT, file: BINARY_PIPELINE });
  await assertDomContract(wv, [...defaultViewerContract({ context: "vscode" })]);
  const viewer = wv.locator('[data-testid="megane-viewer"]');
  const atoms = Number(await viewer.getAttribute("data-atom-count"));
  expect(atoms, "binary .traj companion parsed into atoms").toBeGreaterThan(0);
  const totalFrames = Number(await viewer.getAttribute("data-total-frames"));
  expect(totalFrames, "the .traj frames reached the timeline").toBeGreaterThan(0);
});

test("hover tooltip renders beside the cursor", async ({ page }) => {
  const wv = await openVscodeFile(page, { port: PORT, file: "1crn.pdb" });
  await assertDomContract(wv, [
    ...defaultViewerContract({ expectedAtoms: 327, context: "vscode" }),
  ]);
  await expectTooltipNearCursor(page, wv);
});

/**
 * In a browser-hosted workbench (code-server) the webview's own file input
 * opens the dialog of the computer running the browser, not the workspace's
 * machine. The Load Structure node then also offers "Open from remote...",
 * which the extension host answers with VS Code's open dialog (the quick-input
 * "simple file dialog" here) and posts the chosen file's bytes back.
 */
test("Load Structure opens a workspace file through VS Code's open dialog", async ({ page }) => {
  const wv = await openVscodeFile(page, { port: PORT, file: "1crn.pdb" });
  await assertDomContract(wv, [
    ...defaultViewerContract({ expectedAtoms: 327, context: "vscode" }),
  ]);

  // The pipeline panel starts collapsed in a narrow editor pane.
  const panel = wv.locator('[data-testid="panel-pipeline"]').first();
  if ((await panel.getAttribute("data-collapsed")) === "true") {
    await wv.locator('[data-testid="panel-pipeline-toggle"]').first().click();
  }
  await wv.locator('[data-testid="pipeline-editor-tab-editor"]').first().click();
  await wv.locator('[data-testid="pipeline-node-load_structure"]').first().click();
  const button = wv.locator('[data-testid="load-structure-remote"]').first();
  await expect(button).toHaveText("Open from remote...");
  await button.click();

  const input = page.locator(".quick-input-widget input").first();
  await expect(input).toBeVisible({ timeout: 30_000 });
  // The simple file dialog writes its starting folder into the input after
  // it opens; a path filled in before that is overwritten with "/workspace/".
  await expect(input).toHaveValue(/\/$/, { timeout: 30_000 });
  await input.fill(join(WORKSPACE, "water.gro"));
  await expect(input).toHaveValue(join(WORKSPACE, "water.gro"));
  await input.press("Enter");

  await expect(wv.locator('[data-testid="load-structure-filename"]').first()).toHaveText(
    "water.gro",
    { timeout: 30_000 },
  );
  await expect
    .poll(async () =>
      Number(await wv.locator('[data-testid="megane-viewer"]').getAttribute("data-atom-count")),
    )
    .not.toBe(327);
});

/**
 * A template swaps the graph *and* loads its own demo files, as in the webapp.
 * The webview used to do only the first half, leaving the opened file on
 * screen. Solid then Molecule: the fixtures are assets of webview.js, fetched
 * from the extension's resource origin, and Molecule's XTC is binary.
 */
test("applying a template replaces the opened file with the template's scene", async ({ page }) => {
  const wv = await openVscodeFile(page, { port: PORT, file: "1crn.pdb" });
  await assertDomContract(wv, [
    ...defaultViewerContract({ expectedAtoms: 327, context: "vscode" }),
  ]);
  const panel = wv.locator('[data-testid="panel-pipeline"]').first();
  if ((await panel.getAttribute("data-collapsed")) === "true") {
    await wv.locator('[data-testid="panel-pipeline-toggle"]').first().click();
  }
  const applyTemplate = async (templateId: string) => {
    await wv.locator('[data-testid="pipeline-editor-tab-editor"]').first().click();
    await wv.locator('[data-testid="pipeline-editor-templates"]').first().click();
    await wv.locator(`[data-testid="pipeline-template-${templateId}"]`).first().click();
  };
  const viewer = wv.locator('[data-testid="megane-viewer"]');
  const atomCount = async () => Number(await viewer.getAttribute("data-atom-count"));
  const loaderFileName = wv.locator('[data-testid="load-structure-filename"]').first();

  await applyTemplate("solid");
  await expect.poll(atomCount, { timeout: 30_000 }).toBe(135);
  await expect(loaderFileName).toHaveText("perovskite_srtio3_3x3x3.xyz");

  await applyTemplate("molecule");
  await expect.poll(atomCount, { timeout: 30_000 }).toBe(3024);
  await expect(loaderFileName).toHaveText("caffeine_water.pdb");
  await expect
    .poll(async () => Number(await viewer.getAttribute("data-total-frames")), { timeout: 30_000 })
    .toBeGreaterThan(1);
});

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
