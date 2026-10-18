/**
 * megane Builder as a Jupyter widget (`megane.Builder`) in JupyterLab.
 *
 * Python opens a file in it and reads the edited structure back; File › Save
 * writes through the kernel into the notebook's folder; RDKit (Clean up, and
 * the sketch dialog's 3D embedding of a pasted molecule) arrives from the
 * kernel on first use; Ketcher is not bundled, so the sketch dialog offers
 * Paste MOL. Two `Builder` objects edit two documents side by side, while two
 * outputs of one `Builder` take turns showing its document.
 *
 * Drives the Builder through its UI only: each `Builder` object loads its own
 * copy of the bundle, so the page-wide test hook would name just one of them.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "playwright/test";
import {
  startJupyterLab,
  stopJupyterLab,
  writeNotebook,
  openLabNotebook,
  type JupyterLabHandle,
} from "./lib/hosts/jupyterlab";
import { addPastedMolecule, cleanUpWithRDKit, openSketch, saveAs } from "./lib/builder";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const DIR = "/tmp/megane-e2e-builder-widget";
const PORT = Number(process.env.MEGANE_LAB_BUILDER_WIDGET_PORT ?? 18894);
const TOKEN = "megane-e2e-builder-widget";

let lab: JupyterLabHandle | null = null;

test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  if (!existsSync(join(REPO, "python/megane/static/builder_widget.js"))) {
    throw new Error("builder_widget.js missing. Run `npm run build:widget`.");
  }
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  copyFileSync(join(REPO, "tests", "fixtures", "caffeine.sdf"), join(DIR, "caffeine.sdf"));
  writeNotebook(DIR, "builder", {
    cells: [
      {
        cell_type: "code",
        source: ["import megane\n", "b = megane.Builder('caffeine.sdf', height='520px')\n", "b"],
      },
      // A second output of the same Builder: it takes the document over.
      { cell_type: "code", source: ["b"] },
      // Another Builder: a document of its own.
      { cell_type: "code", source: ["other = megane.Builder(height='420px')\n", "other"] },
    ],
  });
  lab = await startJupyterLab({
    port: PORT,
    token: TOKEN,
    notebookDir: DIR,
    cwd: REPO,
    runtimeDir: "/tmp/megane-jupyter-builder-widget-runtime",
  });
});

test.afterAll(() => {
  stopJupyterLab(lab);
  lab = null;
});

/** Run `code` in the notebook's kernel and return what it printed. */
async function kernelPrint(page: Page, code: string): Promise<string> {
  return await page.evaluate(async (src) => {
    const app = (
      window as unknown as {
        jupyterapp: {
          shell: {
            currentWidget: {
              sessionContext: {
                session: {
                  kernel: {
                    requestExecute: (c: { code: string }) => {
                      onIOPub: (msg: {
                        header: { msg_type: string };
                        content: { text?: string };
                      }) => void;
                      done: Promise<unknown>;
                    };
                  };
                };
              };
            };
          };
        };
      }
    ).jupyterapp;
    const future = app.shell.currentWidget.sessionContext.session.kernel.requestExecute({
      code: src,
    });
    let out = "";
    future.onIOPub = (msg) => {
      if (msg.header.msg_type === "stream") out += msg.content.text ?? "";
    };
    await future.done;
    return out.trim();
  }, code);
}

/**
 * The output area of each code cell, in notebook order. Scoped per cell (not
 * per `.jp-OutputArea-output`) because the reused kernel can print a stray
 * stderr output above a widget, e.g. ipykernel's asyncio "Task was destroyed
 * but it is pending!" warning when the second test re-runs the notebook; a
 * flat output index would then name the wrong Builder.
 */
const outputs = (page: Page) => page.locator(".jp-Notebook .jp-CodeCell .jp-Cell-outputArea");

/** Select the oxygens with the Select tool's element chip and delete them with the Delete key. */
async function deleteOxygens(scope: ReturnType<Page["locator"]>) {
  await scope.locator('[data-testid="builder-tool-select"]').click();
  await scope.locator('[data-testid="builder-inspector-element-O"]').click();
  await scope.locator('[data-testid="builder-inspector-element-O"]').press("Delete");
}

test("megane.Builder opens Python's file, syncs edits back, saves through the kernel, and runs RDKit", async ({
  page,
}) => {
  await openLabNotebook(page, { port: PORT, token: TOKEN, notebook: "builder.ipynb" });
  const out = outputs(page);
  const firstView = out.nth(0);
  const b = out.nth(1);
  const other = out.nth(2);
  const live = b.locator('[data-testid="megane-builder"]');
  await expect(live).toHaveAttribute("data-atom-count", "24");
  // The newer output of `b` has the document; the older one offers to take it back.
  await expect(firstView.locator('[data-testid="megane-builder"]')).toHaveCount(0);
  await expect(firstView.locator('[data-testid="builder-widget-show-here"]')).toBeVisible();
  // `other` is a Builder of its own, live beside it.
  await expect(other.locator('[data-testid="builder-welcome"]')).toBeVisible();
  await expect(b.locator('[data-testid="builder-tools"]')).toHaveCount(0);

  // An edit reaches Python: caffeine without its two oxygens.
  await deleteOxygens(b);
  await expect(live).toHaveAttribute("data-atom-count", "22");
  await expect
    .poll(() => kernelPrint(page, "print(b.n_atoms, b.file_name, other.n_atoms)"), {
      timeout: 15_000,
    })
    .toBe("22 caffeine.sdf 0");
  expect(await kernelPrint(page, "print(b.text('xyz').splitlines()[0])")).toBe("22");

  // File › Save: the kernel writes next to the notebook and says so.
  await saveAs(b, "pdb", page);
  await expect(b.locator('[data-testid="builder-notice"]')).toContainText("Saved caffeine.pdb", {
    timeout: 15_000,
  });
  const pdb = readFileSync(join(DIR, "caffeine.pdb"), "utf8");
  expect(pdb.split("\n").filter((l) => /^(ATOM|HETATM)/.test(l))).toHaveLength(22);

  // RDKit comes from the kernel the first time Clean up needs it.
  await cleanUpWithRDKit(b, page);

  // No Ketcher in the widget: the sketch dialog falls back to Paste MOL, and
  // RDKit embeds the pasted molecule.
  await openSketch(b, page);
  await expect(page.locator('[data-testid="sketch-fallback"]')).toContainText(
    "not part of the Jupyter widget",
  );
  await addPastedMolecule(b, "CCO", "Pasted ethanol", page);
  await expect(live).toHaveAttribute("data-atom-count", "22");
});

test("the outputs of one Builder hand its document back and forth", async ({ page }) => {
  await openLabNotebook(page, { port: PORT, token: TOKEN, notebook: "builder.ipynb" });
  const out = outputs(page);
  const firstView = out.nth(0);
  const secondView = out.nth(1);
  await expect(secondView.locator('[data-testid="megane-builder"]')).toHaveAttribute(
    "data-atom-count",
    "24",
  );
  await deleteOxygens(secondView);
  await expect(secondView.locator('[data-testid="megane-builder"]')).toHaveAttribute(
    "data-atom-count",
    "22",
  );

  await firstView.locator('[data-testid="builder-widget-show-here"]').click();
  await expect(firstView.locator('[data-testid="megane-builder"]')).toHaveAttribute(
    "data-atom-count",
    "22",
  );
  await expect(firstView.locator('[data-testid="builder-op-count"]')).toHaveText("1 edit");
  await expect(secondView.locator('[data-testid="builder-widget-show-here"]')).toBeVisible();
  await expect(secondView.locator('[data-testid="megane-builder"]')).toHaveCount(0);
});
