/**
 * Host open-latency profiler: how long a file takes to show, and to become
 * fully scrubbable, in a real JupyterLab DocWidget or VS Code (code-server)
 * custom editor.
 *
 * Per file and run it records
 *   - first : open → first frame drawn with data loaded (`__megane_test_ready`)
 *   - all   : open → `data-total-frames` reaches the file's frame count
 * where "open" is the navigation to `/lab/tree/<file>` in JupyterLab (so the
 * figure includes JupyterLab's own start-up, ~3 s here) and the explorer
 * double-click in VS Code. The first run of each file warms the server and
 * browser caches and is discarded; the table prints medians.
 *
 * Fixtures: `python tests/e2e/perf/gen_fixtures.py <dir>` writes a 1002-atom,
 * 900-frame water box as PDB+XTC (with a `.megane.json` naming both), a
 * multi-frame XYZ, a multi-MODEL PDB and an ASE `.traj` (needs MDAnalysis and
 * ASE). A/B two builds by swapping the installed labextension directory or the
 * installed VS Code extension's `media/` between runs.
 *
 * Usage (after `npm run build:lab` + the labextension copy, or the code-server
 * setup of the e2e-coverage skill):
 *   MEGANE_PERF_HOST=jupyterlab|vscode MEGANE_PERF_DIR=<dir> \
 *   MEGANE_PERF_FILES=w1002.megane.json,w1002.traj,1crn.pdb@1 \
 *   [MEGANE_PERF_RUNS=3] [MEGANE_PERF_FRAMES=900] [MEGANE_PERF_VERBOSE=1] \
 *   npx playwright test -c tests/e2e/perf/playwright.perf.config.ts
 *
 * `name@N` overrides the expected frame count for one file (`@1`: a single
 * frame, so only `first` is measured). MEGANE_PERF_VERBOSE prints the page's
 * `megane:*` perf marks (`src/perf.ts`) for each run.
 */
import { test, type Browser, type Frame, type Page } from "playwright/test";
import { fileURLToPath } from "url";
import { join } from "path";
import { startJupyterLab, stopJupyterLab } from "../lib/hosts/jupyterlab";
import { startCodeServer, stopCodeServer, getWebviewFrame } from "../lib/hosts/code-server";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const HOST = process.env.MEGANE_PERF_HOST ?? "jupyterlab";
const DIR = process.env.MEGANE_PERF_DIR ?? "";
const FILES = (process.env.MEGANE_PERF_FILES ?? "").split(",").filter(Boolean);
const RUNS = Number(process.env.MEGANE_PERF_RUNS ?? 3);
const FRAMES = Number(process.env.MEGANE_PERF_FRAMES ?? 900);
const VERBOSE = !!process.env.MEGANE_PERF_VERBOSE;
const LAB_PORT = 18899;
const LAB_TOKEN = "megane-perf";
const CODE_SERVER_PORT = 18898;
const WAIT_MS = 600_000;

test.describe.configure({ timeout: 3_600_000 });

/** Opens `file` and returns the scope the viewer renders in, plus the open time. */
type Opener = (page: Page, file: string) => Promise<{ scope: Page | Frame; t0: number }>;

async function openInJupyterLab(page: Page, file: string) {
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${LAB_PORT}/lab/tree/${file}?token=${LAB_TOKEN}&test=1&reset`, {
    waitUntil: "domcontentloaded",
  });
  return { scope: page, t0 };
}

async function openInVscode(page: Page, file: string) {
  await page.goto(`http://127.0.0.1:${CODE_SERVER_PORT}/?folder=${encodeURIComponent(DIR)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  // Let the explorer and extensions settle before opening (see openVscodeFile).
  await page.waitForTimeout(3_000);
  const tree = page.getByRole("treeitem", { name: file, exact: true });
  await tree.waitFor({ state: "visible", timeout: 30_000 });
  await tree.click({ force: true });
  const t0 = Date.now();
  await tree.dblclick({ force: true });
  return { scope: await getWebviewFrame(page, { timeoutMs: WAIT_MS }), t0 };
}

async function measure(browser: Browser, open: Opener): Promise<string> {
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const rows: string[] = [];
  for (const spec of FILES) {
    const [file, nStr] = spec.split("@");
    const nFrames = nStr ? Number(nStr) : FRAMES;
    const first: number[] = [];
    const all: number[] = [];
    for (let run = 0; run <= RUNS; run++) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      // Every frame, so the VS Code webview gets the flags too.
      await ctx.addInitScript(() => {
        (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
        (globalThis as { __MEGANE_PERF__?: boolean }).__MEGANE_PERF__ = true;
      });
      const page = await ctx.newPage();
      const { scope, t0 } = await open(page, file);
      await scope.waitForFunction(
        () => {
          const r = (
            window as { __megane_test_ready?: { firstFrame: boolean; dataLoaded: boolean } }
          ).__megane_test_ready;
          return !!r && r.firstFrame && r.dataLoaded;
        },
        undefined,
        { timeout: WAIT_MS, polling: 20 },
      );
      const t1 = Date.now();
      if (nFrames > 1) {
        await scope.waitForFunction(
          (n) =>
            Number(
              document.querySelector("[data-total-frames]")?.getAttribute("data-total-frames"),
            ) >= n,
          nFrames,
          { timeout: WAIT_MS, polling: 20 },
        );
      }
      const t2 = Date.now();
      if (VERBOSE) {
        const marks = await scope.evaluate(() =>
          [...performance.getEntriesByType("mark"), ...performance.getEntriesByType("measure")]
            .filter((e) => e.name.startsWith("megane:"))
            .map(
              (e) =>
                `  ${e.entryType} ${e.name} at=${e.startTime.toFixed(0)} dur=${e.duration.toFixed(0)}`,
            )
            .join("\n"),
        );
        console.log(marks);
      }
      console.log(`[${HOST}] ${file} run ${run}: first=${t1 - t0}ms all=${t2 - t0}ms`);
      if (run > 0) {
        first.push(t1 - t0);
        all.push(t2 - t0);
      }
      await ctx.close();
    }
    rows.push(`| ${file} | ${median(first)} | ${median(all)} |`);
  }
  return [
    `[${HOST}]`,
    "| file | first frame (ms) | all frames (ms) |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

test("open latency", async ({ browser }) => {
  if (HOST === "vscode") {
    const cs = await startCodeServer({ port: CODE_SERVER_PORT, workspace: DIR });
    try {
      console.log(await measure(browser, openInVscode));
    } finally {
      stopCodeServer(cs);
    }
    return;
  }
  const lab = await startJupyterLab({
    port: LAB_PORT,
    token: LAB_TOKEN,
    notebookDir: DIR,
    cwd: REPO,
    runtimeDir: "/tmp/megane-jupyter-perf-runtime",
  });
  try {
    console.log(await measure(browser, openInJupyterLab));
  } finally {
    stopJupyterLab(lab);
  }
});
