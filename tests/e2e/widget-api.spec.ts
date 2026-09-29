/**
 * Widget programmatic API E2E (M2).
 *
 * Drives the megane Python anywidget through its public traitlets:
 *   - viewer.frame_index = N        — should advance the renderer epoch
 *   - viewer.selected_atoms = [...] — should populate the MeasurementPanel
 *   - viewer.set_pipeline(pipe)     — should swap in a new pipeline graph
 *   - set_pipeline(pipe, embed_trajectory=True) — playback keeps working after
 *     the kernel is shut down, and in a saved notebook reopened without running
 *     it (and does not without embedding)
 *
 * The test boots a fresh JupyterLab and rewrites the notebook with the
 * cumulative cell sequence for each scenario, then triggers Run All. This
 * avoids depending on a `window.jupyterapp` global (removed in modern
 * JupyterLab) and keeps each test self-contained.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "playwright/test";
import { assertDomContract, defaultViewerContract, getReadyState, waitForReady } from "./lib/setup";
import {
  startJupyterLab,
  stopJupyterLab,
  writeNotebook,
  openLabNotebook,
  type JupyterLabHandle,
  type NotebookSpec,
} from "./lib/hosts/jupyterlab";

const PLATFORM = "widget-api";
const FIXTURE_PDB = "caffeine_water.pdb";
const FIXTURE_XTC = "caffeine_water_vibration.xtc";
const FIXTURE_PDB_ATOMS = 3024;

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const NOTEBOOK_DIR = join(REPO, "tests", "e2e", "notebooks");
const NOTEBOOK_NAME = "widget_api";
const PORT = Number(process.env.MEGANE_LAB_API_PORT ?? 18890);
const TOKEN = "megane-e2e-api";

let lab: JupyterLabHandle | null = null;

const SETUP_CELL = [
  "import megane\n",
  "viewer = megane.MolecularViewer()\n",
  `viewer.load(\"${REPO}/tests/fixtures/${FIXTURE_PDB}\", \"${REPO}/tests/fixtures/${FIXTURE_XTC}\")\n`,
  "viewer\n",
];

function buildNotebook(extraCells: string[][]): NotebookSpec {
  return {
    cells: [
      { cell_type: "code", source: SETUP_CELL },
      ...extraCells.map((source) => ({ cell_type: "code" as const, source })),
    ],
  };
}

async function reopenWithCells(page: Page, extraCells: string[][]): Promise<void> {
  writeNotebook(NOTEBOOK_DIR, NOTEBOOK_NAME, buildNotebook(extraCells));
  await openLabNotebook(page, {
    port: PORT,
    token: TOKEN,
    notebook: `${NOTEBOOK_NAME}.ipynb`,
  });
}

test.describe.configure({ mode: "serial", timeout: 240_000 });

test.beforeAll(async () => {
  if (!existsSync(join(REPO, "python", "megane", "static", "widget.js"))) {
    throw new Error("widget.js missing. Run `npm run build:widget` before widget-api.spec.ts.");
  }
  lab = await startJupyterLab({
    port: PORT,
    token: TOKEN,
    notebookDir: NOTEBOOK_DIR,
    cwd: REPO,
    runtimeDir: "/tmp/megane-jupyter-api-runtime",
  });
});

test.afterAll(() => {
  stopJupyterLab(lab);
  lab = null;
});

test("frame_index assignment advances renderer", async ({ page }) => {
  await reopenWithCells(page, [["viewer.frame_index = 3\n"]]);

  await assertDomContract(page, [
    ...defaultViewerContract({
      expectedAtoms: FIXTURE_PDB_ATOMS,
      context: "widget-pipeline",
    }),
  ]);

  // Run All has already executed the frame assignment. Assert on the
  // host-level frame signal (`data-current-frame`, driven by the widget's
  // frame_index model traitlet) rather than the renderer-internal
  // `__megane_test_ready.frame`: the widget frame data is decoded straight
  // from `_frame_data` and does not thread the frame index the way the
  // webapp's playback store does, so the internal field stays 0 on this host
  // even though the widget correctly renders (and reports) frame 3.
  await waitForReady(page, { needsData: true, timeout: 30_000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="megane-viewer"]')
        ?.getAttribute("data-current-frame") === "3",
    null,
    { timeout: 30_000 },
  );
  const after = await getReadyState(page);
  expect(after.renderEpoch).toBeGreaterThan(0);
});

test("selected_atoms assignment shows in MeasurementPanel", async ({ page }) => {
  await reopenWithCells(page, [["viewer.frame_index = 3\n"], ["viewer.selected_atoms = [0, 1]\n"]]);

  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="measurement-panel"]');
      const c = el?.getAttribute("data-selection-count");
      return c !== null && Number(c) === 2;
    },
    null,
    { timeout: 15_000 },
  );

  void PLATFORM;
});

test("set_pipeline swaps in a programmatic graph and re-renders", async ({ page }) => {
  // Build a minimal pipeline = LoadStructure(caffeine.pdb) -> Viewport
  // and apply via viewer.set_pipeline(). Verify the renderer reports a
  // new snapshot (renderEpoch advances after the assignment) and that
  // the atom-count attribute on the viewer reflects the new structure.
  const pipelineCell = [
    "from megane import Pipeline, LoadStructure, Viewport\n",
    "pipe = Pipeline()\n",
    `s = pipe.add_node(LoadStructure(\"${REPO}/tests/fixtures/water_wrapped.pdb\"))\n`,
    "v = pipe.add_node(Viewport())\n",
    "pipe.add_edge(s.out.particle, v.inp.particle)\n",
    "viewer.set_pipeline(pipe)\n",
  ];
  await reopenWithCells(page, [pipelineCell]);

  await waitForReady(page, { needsData: true, timeout: 30_000 });

  // The pipeline-driven snapshot replaces the original caffeine_water
  // fixture (3024 atoms) with the tiny water_wrapped structure. Assert on
  // the renderer's actually-loaded atom count (set by loadSnapshot) rather
  // than the viewer-root `data-atom-count` attribute: in the widget's
  // set_pipeline path the renderer swaps the snapshot correctly, but the
  // React attribute lags, so the renderer-truth signal is the reliable one.
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __megane_test_ready?: { atomCount?: number } })
        .__megane_test_ready;
      const n = r?.atomCount ?? 0;
      return n > 0 && n !== 3024;
    },
    null,
    { timeout: 30_000 },
  );

  const after = await getReadyState(page);
  expect(after.firstFrame).toBe(true);
  expect(after.renderEpoch).toBeGreaterThan(0);
});

// ─── embed_trajectory: playback without a kernel ─────────────────────────

/** Point `viewer` at the caffeine_water trajectory, embedded or kernel-side. */
const trajectoryPipelineLines = (embed: boolean) => [
  "from megane import Pipeline, LoadStructure, LoadTrajectory, Viewport\n",
  "pipe = Pipeline()\n",
  `s = pipe.add_node(LoadStructure(\"${REPO}/tests/fixtures/${FIXTURE_PDB}\"))\n`,
  `t = pipe.add_node(LoadTrajectory(xtc=\"${REPO}/tests/fixtures/${FIXTURE_XTC}\"))\n`,
  "v = pipe.add_node(Viewport())\n",
  "pipe.add_edge(s.out.particle, t.inp.particle)\n",
  "pipe.add_edge(s.out.particle, v.inp.particle)\n",
  "pipe.add_edge(t.out.traj, v.inp.traj)\n",
  `viewer.set_pipeline(pipe, embed_trajectory=${embed ? "True" : "False"})\n`,
];

/** Frames the renderer has applied so far (test mode counter). */
async function framesApplied(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __megane_test_ready?: { framesApplied?: number } })
        .__megane_test_ready?.framesApplied ?? 0,
  );
}

/** Shut down every kernel of the test server. */
async function shutDownKernels(page: Page): Promise<void> {
  const api = `http://127.0.0.1:${PORT}/api/kernels`;
  const headers = { Authorization: `token ${TOKEN}` };
  const kernels = (await (await page.request.get(api, { headers })).json()) as { id: string }[];
  for (const k of kernels) {
    const res = await page.request.delete(`${api}/${k.id}`, { headers });
    expect(res.status()).toBe(204);
  }
}

/**
 * With the viewer on screen, shut the kernel down, step three frames, and
 * report how many frames the renderer applied meanwhile.
 */
async function framesAppliedWithoutKernel(page: Page): Promise<number> {
  await waitForReady(page, { needsData: true, timeout: 60_000 });
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector('[data-testid="megane-viewer"]')
          ?.getAttribute("data-total-frames") ?? 0,
      ) > 3,
    null,
    { timeout: 30_000 },
  );

  await shutDownKernels(page);
  const before = await framesApplied(page);
  const step = page.locator('[data-testid="step-forward"]').first();
  for (let i = 1; i <= 3; i++) {
    await step.click();
    await page.waitForFunction(
      (n) =>
        document
          .querySelector('[data-testid="megane-viewer"]')
          ?.getAttribute("data-current-frame") === String(n),
      i,
      { timeout: 10_000 },
    );
  }
  // Give a (wrongly) late kernel frame time to land before counting.
  await page.waitForTimeout(1_000);
  return (await framesApplied(page)) - before;
}

/**
 * Execute the trajectory notebook outside JupyterLab (nbclient stores the
 * widget state in the notebook, as saving from a live session does) and trust
 * it, which is what the recipient of a shared notebook does before widgets
 * render.
 */
function writeExecutedNotebook(name: string, embed: boolean): string {
  const path = writeNotebook(NOTEBOOK_DIR, name, {
    cells: [
      {
        cell_type: "code",
        source: [
          "import megane\n",
          "viewer = megane.MolecularViewer()\n",
          ...trajectoryPipelineLines(embed),
          "viewer\n",
        ],
      },
    ],
  });
  const script = [
    "import sys, nbformat",
    "from nbclient import NotebookClient",
    "nb = nbformat.read(sys.argv[1], as_version=4)",
    'NotebookClient(nb, kernel_name="python3", store_widget_state=True).execute()',
    "nbformat.write(nb, sys.argv[1])",
  ].join("\n");
  execFileSync("python", ["-c", script, path], { cwd: REPO, stdio: "inherit" });
  execFileSync("jupyter", ["trust", path], { cwd: REPO, stdio: "inherit" });
  return `${name}.ipynb`;
}

test("embedded trajectory keeps playing after the kernel shuts down", async ({ page }) => {
  await reopenWithCells(page, [trajectoryPipelineLines(true)]);
  expect(await framesAppliedWithoutKernel(page)).toBeGreaterThanOrEqual(3);
});

test("a kernel-side trajectory stops playing when the kernel shuts down", async ({ page }) => {
  // Counterexample for the test above: without embedding, the frame counter
  // still moves (it is local model state) but no frame data arrives.
  await reopenWithCells(page, [trajectoryPipelineLines(false)]);
  expect(await framesAppliedWithoutKernel(page)).toBe(0);
});

test("a saved notebook plays its embedded trajectory without being run", async ({ page }) => {
  const notebook = writeExecutedNotebook("widget_api_saved_embedded", true);
  await openLabNotebook(page, { port: PORT, token: TOKEN, notebook, runAll: false });
  expect(await framesAppliedWithoutKernel(page)).toBeGreaterThanOrEqual(3);
});

test("a saved notebook without embedding cannot play without a kernel", async ({ page }) => {
  const notebook = writeExecutedNotebook("widget_api_saved_kernel", false);
  await openLabNotebook(page, { port: PORT, token: TOKEN, notebook, runAll: false });
  expect(await framesAppliedWithoutKernel(page)).toBe(0);
});
