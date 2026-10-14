/**
 * Widget E2E under JupyterLab (M3).
 *
 * The notebook is generated programmatically from a fixed Python source and
 * executed by JupyterLab's notebook runtime. Each cell that mutates widget
 * state (legacy load, set_pipeline, frame_index assignment) produces a
 * checkpoint at which we run the 3-layer assertion.
 *
 * Boot is delegated to `lib/hosts/jupyterlab.ts` so that
 * `jupyterlab-doc.spec.ts` and the cross-host feature specs share one
 * implementation of `startJupyterLab` / `openLabNotebook`.
 */

import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  expectViewerRegionMatch,
  getReadyState,
} from "./lib/setup";
import {
  startJupyterLab,
  stopJupyterLab,
  writeNotebook,
  openLabNotebook,
  type JupyterLabHandle,
  type NotebookSpec,
} from "./lib/hosts/jupyterlab";
import { expectTooltipNearCursor } from "./lib/tooltip";

const PLATFORM = "widget-jupyterlab";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const NOTEBOOK_DIR = join(REPO, "tests", "e2e", "notebooks");
const PORT = Number(process.env.MEGANE_LAB_PORT ?? 18888);
const TOKEN = "megane-e2e-token";

interface WidgetFormatFixture {
  id: string;
  file: string;
  expectedAtoms?: number;
}

// `MolecularViewer.load()` now dispatches by file extension to the
// shared Rust-backed parsers (Phase 1.4 of the E2E COVERAGE_PLAN).
// Multi-format coverage on this host therefore mixes PDB and non-PDB
// fixtures so the dispatch path stays exercised. Pipeline-based loads
// (which exposed every format earlier) remain the recommended API.
const FORMATS: WidgetFormatFixture[] = [
  { id: "pdb-1crn", file: "1crn.pdb", expectedAtoms: 327 },
  { id: "pdb-water-wrapped", file: "water_wrapped.pdb" },
  { id: "pdb-caffeine-water", file: "caffeine_water.pdb" },
  { id: "xyz-si-diamond", file: "si_diamond.xyz" },
  // Offset simulation box (LAMMPS): exercises the box-origin path through the
  // Python→JS binary protocol so the widget draws the cell around its atoms.
  { id: "lammps-offset-box", file: "confined_offset.data", expectedAtoms: 64 },
];

let lab: JupyterLabHandle | null = null;

function legacyNotebook(file: string): NotebookSpec {
  return {
    cells: [
      {
        cell_type: "code",
        source: ["import megane\n", "viewer = megane.MolecularViewer()\n"],
      },
      {
        cell_type: "code",
        source: [`viewer.load("${REPO}/tests/fixtures/${file}")\n`, "viewer\n"],
      },
    ],
  };
}

test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(REPO, "python", "megane", "static", "widget.js"))) {
    throw new Error(
      "widget.js missing. Run `npm run build:widget` before widget-jupyterlab.spec.ts.",
    );
  }
  lab = await startJupyterLab({
    port: PORT,
    token: TOKEN,
    notebookDir: NOTEBOOK_DIR,
    cwd: REPO,
    runtimeDir: "/tmp/megane-jupyter-runtime",
  });
});

test.afterAll(() => {
  stopJupyterLab(lab);
  lab = null;
});

for (const f of FORMATS) {
  test(`widget legacy load() ${f.id} satisfies 3-layer contract`, async ({ page }) => {
    const nb = writeNotebook(NOTEBOOK_DIR, `widget_legacy_${f.id}`, legacyNotebook(f.file));
    await openLabNotebook(page, {
      port: PORT,
      token: TOKEN,
      notebook: `widget_legacy_${f.id}.ipynb`,
    });

    await assertDomContract(page, [
      ...defaultViewerContract({
        expectedAtoms: f.expectedAtoms,
        context: "widget-pipeline",
      }),
    ]);

    await expectFullPageMatch(page, PLATFORM, `legacy-${f.id}`);
    await expectViewerRegionMatch(page, PLATFORM, `legacy-${f.id}-viewer`);

    if (f.expectedAtoms !== undefined) {
      const ready = await getReadyState(page);
      expect(ready.atomCount).toBe(f.expectedAtoms);
    }

    void nb;
  });
}

// Regression: notebook cells carry `contain: layout style paint`, which makes
// the cell the containing block of the `position: fixed` hover tooltip — it
// used to render offset by the cell's position in the notebook.
test("widget hover tooltip renders beside the cursor", async ({ page }) => {
  writeNotebook(NOTEBOOK_DIR, "widget_tooltip", legacyNotebook("1crn.pdb"));
  await openLabNotebook(page, { port: PORT, token: TOKEN, notebook: "widget_tooltip.ipynb" });
  await assertDomContract(page, [
    ...defaultViewerContract({ expectedAtoms: 327, context: "widget-pipeline" }),
  ]);
  await expectTooltipNearCursor(page);
});
