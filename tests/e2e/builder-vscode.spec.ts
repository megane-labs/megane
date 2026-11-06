/**
 * megane Builder in the VS Code extension, under code-server.
 *
 * The megane container in the activity bar holds the Builder view, whose
 * welcome buttons open a Builder tab; structure files get *Open in megane
 * Builder* in the Explorer's context menu and in a megane viewer tab's title
 * bar. Checks that the webview's chunked bundle runs the Builder's heavy parts
 * (the RDKit worker, the lazily loaded Ketcher and its Indigo worker) — also
 * after the webview's service worker has been stopped, which is when a worker
 * can no longer load anything from the extension's resource origin — and that
 * Save goes through the extension host (in E2E mode it skips the save dialog
 * and writes beside the file).
 * The *Tools* menu reaches the MCP tool servers of `megane.builder.mcpServers`
 * through the extension host: a stdio server replaying the reference tool
 * server's recorded responses is started after the user allows it, and its
 * results enter the document.
 *
 * Prereqs: `bash scripts/install-code-server.sh` with a VSIX packaged from
 * this tree (`npm --prefix vscode-megane run package`).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Frame, type Page } from "playwright/test";
import { waitForReady } from "./lib/setup";
import {
  openVscodeNotebook,
  startCodeServer,
  stopCodeServer,
  type CodeServerHandle,
} from "./lib/hosts/code-server";
import { writeNotebook } from "./lib/hosts/jupyterlab";
import {
  buildSmilesInFlow,
  cleanUpWithRDKit,
  openSketch,
  saveAs,
  waitForKetcher,
} from "./lib/builder";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const WORKSPACE = "/tmp/megane-e2e-builder-vscode";
const PORT = Number(process.env.MEGANE_VSCODE_BUILDER_PORT ?? 18995);

let cs: CodeServerHandle | null = null;

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  copyFileSync(join(REPO, "tests", "fixtures", "caffeine.sdf"), join(WORKSPACE, "caffeine.sdf"));
  copyFileSync(join(REPO, "tests", "fixtures", "1crn.pdb"), join(WORKSPACE, "1crn.pdb"));
  // Workspace trust is off in the E2E profile, so the workspace setting applies.
  mkdirSync(join(WORKSPACE, ".vscode"), { recursive: true });
  writeFileSync(
    join(WORKSPACE, ".vscode", "settings.json"),
    JSON.stringify({
      "megane.builder.mcpServers": {
        "recorded-tools": {
          command: process.execPath,
          args: [join(REPO, "tests", "e2e", "lib", "fake-builder-tools.mjs")],
        },
      },
    }),
  );
  writeNotebook(WORKSPACE, "builder", {
    cells: [
      {
        cell_type: "code",
        source: [
          "import megane\n",
          `b = megane.Builder("${WORKSPACE}/caffeine.sdf", height="460px")\n`,
          "b",
        ],
      },
    ],
  });
  cs = await startCodeServer({ port: PORT, workspace: WORKSPACE, e2eMode: true });
});

test.afterAll(() => {
  stopCodeServer(cs);
  cs = null;
});

async function openWorkbench(page: Page) {
  await page.goto(`http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(WORKSPACE)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
  // Let the extensions and the file tree settle before interacting.
  await page.waitForTimeout(3_000);
}

/** The webview frame that holds a megane Builder (not a megane viewer). */
async function builderFrame(page: Page, timeoutMs = 60_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        if (
          await frame.evaluate(() => !!document.querySelector('[data-testid="megane-builder"]'))
        ) {
          return frame;
        }
      } catch {
        // Navigating or detached.
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error("no Megane Builder webview appeared");
}

/**
 * Stop the webview's service worker, as the browser does after ~30 s without
 * an event. VS Code's service worker serves the extension's resources to a
 * Web Worker only through a message port it keeps in memory (the webview
 * page's own requests are routed without it), so after a restart a worker's
 * request for such a URL hangs for 30 s and fails with HTTP 408. A user who
 * spends a minute drawing in Ketcher always gets there.
 */
async function stopServiceWorkers(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
  } finally {
    await cdp.detach();
  }
}

/** Open an empty Builder tab from the megane view and return its frame. */
async function openEmptyBuilder(page: Page): Promise<Frame> {
  await openWorkbench(page);
  await page
    .getByRole("tab", { name: /^Megane/ })
    .first()
    .click();
  await page
    .locator(".welcome-view-content")
    .getByRole("button", { name: "New Structure" })
    .click();
  return await builderFrame(page);
}

/** Click the sketch dialog's Add and wait until it closes; a failed embedding fails with its message. */
async function addSketch(wv: Frame, name: string): Promise<void> {
  await wv.locator('[data-testid="sketch-name"]').fill(name);
  await wv.locator('[data-testid="sketch-add"]').click();
  const modal = wv.locator('[data-testid="sketch-modal"]');
  const error = wv.locator('[data-testid="sketch-error"]');
  await expect
    .poll(
      async () =>
        (await error.count()) > 0
          ? `error: ${await error.textContent()}`
          : (await modal.count()) > 0
            ? "open"
            : "added",
      { timeout: 90_000 },
    )
    .toBe("added");
  const row = wv.locator('[data-testid^="builder-library-item-user:"]', { hasText: name });
  // RDKit added the hydrogens and embedded the molecule in 3D.
  await expect(row).toContainText("C2H6O");
  await expect(row).not.toContainText("flat");
}

test("RDKit embeds a sketch after the webview's service worker restarted", async ({ page }) => {
  const wv = await openEmptyBuilder(page);
  await expect(wv.locator('[data-testid="builder-welcome"]')).toBeVisible();
  await stopServiceWorkers(page);

  await openSketch(wv);
  await wv.locator('[data-testid="sketch-paste-toggle"]').click();
  await wv.locator('[data-testid="sketch-molfile"]').fill("CCO");
  await addSketch(wv, "Ethanol paste");
});

test("Ketcher's Indigo engine and RDKit run after the webview's service worker restarted", async ({
  page,
}) => {
  const wv = await openEmptyBuilder(page);
  await expect(wv.locator('[data-testid="builder-welcome"]')).toBeVisible();
  await stopServiceWorkers(page);

  await openSketch(wv);
  await waitForKetcher(wv);
  // Ketcher converts a SMILES in its Indigo worker before the sketch shows it.
  const molfile = await wv.evaluate(async () => {
    const k = (
      window as unknown as {
        __megane_test_ketcher: {
          setMolecule: (s: string) => Promise<void>;
          getMolfile: (f: string) => Promise<string>;
        };
      }
    ).__megane_test_ketcher;
    await k.setMolecule("CCO");
    return await k.getMolfile("v2000");
  });
  expect(molfile).toContain("V2000");
  await addSketch(wv, "Ethanol sketch");
});

test("the megane activity-bar view opens an empty Builder tab", async ({ page }) => {
  await openWorkbench(page);
  await page
    .getByRole("tab", { name: /^Megane/ })
    .first()
    .click();
  // The welcome buttons (the view's title bar repeats them as icons).
  const welcome = page.locator(".welcome-view-content");
  const newStructure = welcome.getByRole("button", { name: "New Structure" });
  await expect(newStructure).toBeVisible({ timeout: 30_000 });
  await expect(welcome.getByRole("button", { name: "Open File in Builder…" })).toBeVisible();
  await newStructure.click();

  const wv = await builderFrame(page);
  await expect(wv.locator('[data-testid="builder-welcome"]')).toBeVisible();
  await expect(wv.locator('[data-testid="builder-tools"]')).toHaveCount(1);
  await expect(page.locator(".tab", { hasText: "Megane Builder" }).first()).toBeVisible();
});

test("Flow mode builds a molecule from SMILES in the webview and opens it in Manual mode", async ({
  page,
}) => {
  await openWorkbench(page);
  await page
    .getByRole("tab", { name: /^Megane/ })
    .first()
    .click();
  await page
    .locator(".welcome-view-content")
    .getByRole("button", { name: "New Structure" })
    .click();
  const wv = await builderFrame(page);
  // The graph editor's chunk loads from the extension's resource origin.
  await buildSmilesInFlow(wv, "CCO");
  await expect(wv.locator('[data-testid="megane-builder"]')).toHaveAttribute(
    "data-atom-count",
    "9",
  );
});

test("the Tools menu runs a configured stdio tool server through the extension host", async ({
  page,
}) => {
  await openWorkbench(page);
  await page
    .getByRole("tab", { name: /^Megane/ })
    .first()
    .click();
  await page
    .locator(".welcome-view-content")
    .getByRole("button", { name: "New Structure" })
    .click();
  const wv = await builderFrame(page);
  const tools = wv.locator('[data-testid="builder-tools"]');

  // The menu offers the configured server; connecting asks first (§9).
  await tools.click();
  await wv.locator('[data-testid="builder-tools-connect-recorded-tools"]').click();
  const dialog = page.locator(".monaco-dialog-box");
  await expect(dialog).toContainText('Allow the tool server "recorded-tools"?', {
    timeout: 30_000,
  });
  await expect(dialog).toContainText("fake-builder-tools.mjs");
  await dialog.getByRole("button", { name: "Allow" }).click();
  await expect(wv.locator('[data-testid="builder-tools-connected"]')).toContainText(
    "Connected to megane-builder-tools: 3 tools",
    { timeout: 60_000 },
  );
  await expect(wv.locator('[data-testid="builder-tools-server-description"]')).toContainText(
    "fake-builder-tools.mjs",
  );

  // A new-document tool replaces the empty document.
  await tools.click();
  await wv.locator('[data-testid="builder-tools-button-liquid_box"]').click();
  await wv
    .locator('[data-testid="builder-tool-field-components-0-molecule"]')
    .selectOption("preset:water");
  await wv.locator('[data-testid="builder-tool-field-seed"]').fill("42");
  await wv.locator('[data-testid="builder-tool-run"]').click();
  const root = wv.locator('[data-testid="megane-builder"]');
  await expect(root).toHaveAttribute("data-atom-count", "300", { timeout: 60_000 });

  // An insert tool adds its atoms to the open document as one step.
  await tools.click();
  await wv.locator('[data-testid="builder-tools-button-solvate"]').click();
  await wv.locator('[data-testid="builder-tool-run"]').click();
  await expect(root).toHaveAttribute("data-atom-count", "1098", { timeout: 60_000 });
  await expect(wv.locator('[data-testid="builder-notice"]')).toContainText("Solvate");
});

test("Open in Megane Builder from the Explorer: RDKit, Ketcher and Save work in the webview", async ({
  page,
}) => {
  rmSync(join(WORKSPACE, "caffeine.xyz"), { force: true });
  await openWorkbench(page);
  const row = page.getByRole("treeitem", { name: "caffeine.sdf", exact: true });
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click({ button: "right" });
  const entry = page.getByRole("menuitem", { name: "Open in Megane Builder" });
  await expect(entry).toBeVisible();
  // The context menu ignores clicks while it is still animating in.
  await page.waitForTimeout(500);
  await entry.click();

  const wv = await builderFrame(page);
  const root = wv.locator('[data-testid="megane-builder"]');
  await expect(root).toHaveAttribute("data-atom-count", "24", { timeout: 60_000 });
  await waitForReady(wv);
  await expect(page.locator(".tab", { hasText: "caffeine.sdf — Builder" }).first()).toBeVisible();

  // The RDKit worker starts inside the webview, with the .wasm the page fetched.
  await cleanUpWithRDKit(wv);

  // Ketcher's chunk and its Indigo worker load too.
  await openSketch(wv);
  await waitForKetcher(wv);
  await wv.locator('[data-testid="sketch-cancel"]').click();

  // Save goes through the extension host, which writes beside the file.
  await saveAs(wv, "xyz");
  await expect(wv.locator('[data-testid="builder-notice"]')).toContainText("Saved caffeine.xyz", {
    timeout: 30_000,
  });
  await expect.poll(() => existsSync(join(WORKSPACE, "caffeine.xyz"))).toBe(true);
  expect(readFileSync(join(WORKSPACE, "caffeine.xyz"), "utf8").split("\n")[0].trim()).toBe("24");
});

test("a megane viewer tab's title bar opens its file in the Builder", async ({ page }) => {
  await openWorkbench(page);
  const row = page.getByRole("treeitem", { name: "1crn.pdb", exact: true });
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click({ force: true });
  await row.dblclick({ force: true });
  const action = page.getByRole("button", { name: "Open in Megane Builder" });
  await expect(action).toBeVisible({ timeout: 60_000 });
  await action.click();
  const wv = await builderFrame(page);
  await expect(wv.locator('[data-testid="megane-builder"]')).toHaveAttribute(
    "data-atom-count",
    "327",
    { timeout: 60_000 },
  );
});

test("megane.Builder in a VS Code notebook: RDKit and Save go through the kernel", async ({
  page,
}) => {
  rmSync(join(WORKSPACE, "caffeine.pdb"), { force: true });
  // Test mode reaches the widget's output frame through `window.parent`.
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  const wv = await openVscodeNotebook(page, {
    port: PORT,
    file: "builder.ipynb",
    notebook: "builder.ipynb",
    folder: WORKSPACE,
  });
  const root = wv.locator('[data-testid="megane-builder"]');
  await expect(root).toHaveAttribute("data-atom-count", "24");
  // The Jupyter extension's one-time notice about widget scripts covers the output.
  const notice = page.getByRole("button", { name: "Do not show again" });
  if (await notice.isVisible({ timeout: 5_000 }).catch(() => false)) await notice.click();
  await cleanUpWithRDKit(wv);
  await saveAs(wv, "pdb");
  await expect(wv.locator('[data-testid="builder-notice"]')).toContainText("Saved caffeine.pdb", {
    timeout: 30_000,
  });
  await expect.poll(() => existsSync(join(WORKSPACE, "caffeine.pdb"))).toBe(true);
});
