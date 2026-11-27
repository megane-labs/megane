/**
 * Capture the screenshots of the JupyterLab first-steps walkthrough
 * (docs/docs/guide/jupyterlab-walkthrough.md, #959).
 *
 * Usage:
 *   PATH="$(pwd)/.venv/bin:$PATH" node scripts/capture-jupyterlab-walkthrough.mjs
 *
 * Starts JupyterLab on a copy of the walkthrough's sample files
 * (docs/public/samples/), does each step in the browser and writes
 * docs/public/screenshots/jupyterlab-*.png at 2x.
 *
 * Requires the labextension built and installed (`npm run build:lab`, then
 * `maturin develop --release`), as for the jupyterlab-doc E2E project.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getChromium, randomPort, startJupyterLab } from "../tests/e2e/utils/playwright.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = join(ROOT, "docs", "public", "samples");
const OUT = join(ROOT, "docs", "public", "screenshots");
const TOKEN = "walkthrough";

const workDir = mkdtempSync(join(tmpdir(), "megane-walkthrough-"));
for (const f of readdirSync(SAMPLES)) copyFileSync(join(SAMPLES, f), join(workDir, f));
mkdirSync(OUT, { recursive: true });

const lab = await startJupyterLab({
  token: TOKEN,
  notebookDir: workDir,
  port: randomPort(28000, 1000),
});
const browser = await getChromium().launch({ args: ["--use-gl=swiftshader"] });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  // Test mode keeps the first-visit tour out of the pictures and exposes
  // the projected atom positions used to right-click atoms.
  await context.addInitScript(() => {
    globalThis.__MEGANE_TEST__ = true;
  });
  const page = await context.newPage();
  const ready = () =>
    page.waitForFunction(
      () => {
        const r = window.__megane_test_ready;
        return !!r && r.firstFrame && r.dataLoaded;
      },
      null,
      { timeout: 120_000 },
    );
  const settle = () => page.waitForTimeout(1500);
  const shot = async (name) => {
    // JupyterLab's own toasts (e.g. "get notified about Jupyter news?") are
    // not part of the walkthrough; hide them rather than answer them, so no
    // preference is saved.
    await page.addStyleTag({ content: ".Toastify { display: none !important; }" });
    await page.mouse.move(1, 1);
    await page.screenshot({ path: join(OUT, `jupyterlab-${name}.png`) });
    console.log(`wrote jupyterlab-${name}.png`);
  };

  // 1. Open a structure from the file browser.
  await page.goto(`http://127.0.0.1:${lab.port}/lab?token=${TOKEN}&reset`, {
    waitUntil: "domcontentloaded",
  });
  const item = (name) =>
    page.locator(".jp-DirListing-item").filter({ has: page.getByText(name, { exact: true }) });
  await item("1crn.pdb").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  await item("1crn.pdb").dblclick();
  await ready();
  await settle();
  await item("1crn.pdb").click();
  await shot("open");

  // 2. Style: Inspector tab → Quick style → Cartoon.
  await page.locator('[data-testid="pipeline-editor-tab-inspector"]').click();
  await page.locator('[data-testid="quick-style-rep"]').selectOption("cartoon");
  await settle();
  await shot("style");
  await page.locator('[data-testid="quick-style-rep"]').selectOption("");
  await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
  await settle();

  // 3. Measure: right-click two neighbouring atoms near the middle of the 3D
  // view (the viewer root also holds the panel, so take the canvas area).
  const root = await page.locator('[data-testid="viewer-root"]').first().boundingBox();
  const canvas = await page.locator('[data-tour-anchor="viewport"]').first().boundingBox();
  const atoms = await page.evaluate(() => window.__megane_test.getProjectedAtomPositions());
  const cx = canvas.x - root.x + canvas.width / 2;
  const cy = canvas.y - root.y + canvas.height / 2;
  // The front-most atom near the middle, then one beside it at about the same
  // depth (`depth` is the camera-space distance in Å), so both highlights show.
  const near = (a, x, y, r) => Math.hypot(a.sx - x, a.sy - y) < r;
  const first = atoms
    .filter((a) => a.depth > 0 && near(a, cx, cy, 180))
    .sort((a, b) => a.depth - b.depth)[0];
  const second = atoms
    .filter(
      (a) =>
        a.index !== first.index &&
        Math.abs(a.depth - first.depth) < 2.5 &&
        near(a, first.sx, first.sy, 160) &&
        !near(a, first.sx, first.sy, 60),
    )
    .sort(
      (a, b) =>
        Math.hypot(a.sx - first.sx, a.sy - first.sy) - Math.hypot(b.sx - first.sx, b.sy - first.sy),
    )[0];
  for (const a of [first, second]) {
    await page.mouse.click(root.x + a.sx, root.y + a.sy, { button: "right" });
    await page.waitForTimeout(400);
  }
  await page.locator('[data-testid="measurement-panel"]').waitFor();
  await settle();
  await shot("measure");

  // 4. Open a trajectory and step into it.
  await item("cu_slab_opt.traj").dblclick();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-total-frames]")].some(
        (e) => e.getAttribute("data-total-frames") === "9" && e.checkVisibility(),
      ),
    null,
    { timeout: 120_000 },
  );
  await settle();
  const seek = page.locator('[data-testid="playback-seekbar"]:visible');
  await seek.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await settle();
  await shot("trajectory");
} finally {
  await browser.close();
  lab.kill();
  rmSync(workDir, { recursive: true, force: true });
}
