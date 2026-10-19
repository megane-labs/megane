/**
 * megane Builder in the JupyterLab extension.
 *
 * The megane panel in the left sidebar lists the structure files of the file
 * browser's folder and opens one in the Builder's main-area tab; the file
 * browser's context menu and the launcher reach it too. Checks that the
 * labextension's bundle runs the Builder's heavy parts (the RDKit worker built
 * by webpack, the lazily loaded Ketcher), that its keyboard shortcuts stay
 * inside the tab, and that Save writes into the server's contents.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "playwright/test";
import { waitForReady } from "./lib/setup";
import { startJupyterLab, stopJupyterLab, type JupyterLabHandle } from "./lib/hosts/jupyterlab";
import {
  builderState,
  cleanUpWithRDKit,
  deleteAtom,
  openSketch,
  saveAs,
  waitForKetcher,
} from "./lib/builder";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const DIR = "/tmp/megane-e2e-builder-lab";
const PORT = Number(process.env.MEGANE_LAB_BUILDER_PORT ?? 18893);
const TOKEN = "megane-e2e-builder";

let lab: JupyterLabHandle | null = null;

test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  if (!existsSync(join(REPO, "wheel-share/data/share/jupyter/labextensions/megane-jupyterlab"))) {
    throw new Error("megane labextension not built. Run `npm run build:lab`.");
  }
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  copyFileSync(join(REPO, "tests", "fixtures", "caffeine.sdf"), join(DIR, "caffeine.sdf"));
  writeFileSync(join(DIR, "notes.txt"), "not a structure\n");
  lab = await startJupyterLab({
    port: PORT,
    token: TOKEN,
    notebookDir: DIR,
    cwd: REPO,
    runtimeDir: "/tmp/megane-jupyter-builder-runtime",
  });
});

test.afterAll(() => {
  stopJupyterLab(lab);
  lab = null;
});

async function openLab(page: Page) {
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  await page.goto(`http://127.0.0.1:${PORT}/lab?token=${TOKEN}&reset`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#jp-main-dock-panel", { timeout: 60_000 });
}

/** The megane tab in the left sidebar. */
const sidebarTab = (page: Page) =>
  page.locator('.jp-SideBar.jp-mod-left [data-id="megane-builder-sidebar"]');

test("the megane sidebar opens a structure in the Builder tab, which edits, cleans up and saves it", async ({
  page,
}) => {
  await openLab(page);
  await sidebarTab(page).click();
  const sidebar = page.locator("#megane-builder-sidebar");
  await expect(sidebar).toBeVisible();
  const files = sidebar.locator('[data-testid="megane-builder-sidebar-file"]');
  await expect(files).toHaveText(["caffeine.sdf"]);

  await files.first().click();
  const builder = page.locator('#megane-builder [data-testid="megane-builder"]');
  await expect(builder).toHaveAttribute("data-atom-count", "24", { timeout: 60_000 });
  await waitForReady(page);
  await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText("caffeine.sdf");
  // No tool server is reachable from JupyterLab: the Tools menu is left out.
  await expect(page.locator('[data-testid="builder-tools"]')).toHaveCount(0);

  // The tab's keys act only while the focus is in it.
  await page.locator('#megane-builder [data-testid="viewer-root"]').click();
  await page.keyboard.press("m");
  expect((await builderState(page)).tool).toBe("move");
  await sidebar.locator("h2").click();
  await page.keyboard.press("b");
  expect((await builderState(page)).tool).toBe("move");

  // The RDKit worker webpack built for the labextension loads and answers.
  await cleanUpWithRDKit(page);
  await deleteAtom(page, 23);
  await expect(builder).toHaveAttribute("data-atom-count", "23");

  // Save asks for a path in the folder of the opened file and writes there.
  await saveAs(page, "xyz");
  const dialog = page.locator(".jp-Dialog");
  await expect(dialog.locator("input")).toHaveValue("caffeine.xyz");
  await dialog.locator(".jp-Dialog-button.jp-mod-accept").click();
  await expect(page.locator('[data-testid="builder-notice"]')).toContainText("Saved caffeine.xyz");
  expect(readFileSync(join(DIR, "caffeine.xyz"), "utf8").split("\n")[0].trim()).toBe("23");

  // Saving onto an existing file asks first.
  await saveAs(page, "xyz");
  await dialog.locator(".jp-Dialog-button.jp-mod-accept").click();
  await expect(dialog).toContainText("caffeine.xyz already exists");
  await dialog.locator(".jp-Dialog-button", { hasText: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("Ketcher loads in the labextension's sketch dialog", async ({ page }) => {
  await openLab(page);
  await page.waitForFunction(() => !!(window as { jupyterapp?: unknown }).jupyterapp);
  await page.evaluate(() =>
    (
      window as unknown as { jupyterapp: { commands: { execute: (id: string) => Promise<void> } } }
    ).jupyterapp.commands.execute("megane:open-builder"),
  );
  await expect(page.locator('#megane-builder [data-testid="megane-builder"]')).toBeVisible();
  await openSketch(page);
  await waitForKetcher(page);
  await expect(page.locator('[data-testid="sketch-fallback"]')).toHaveCount(0);
});

test("the file browser's context menu and the launcher reach the Builder", async ({ page }) => {
  await openLab(page);
  const item = page.locator(".jp-DirListing-item", { hasText: "caffeine.sdf" });
  await item.click({ button: "right" });
  const entry = page.locator(".lm-Menu-item", { hasText: "Open in Megane Builder" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#megane-builder [data-testid="megane-builder"]')).toHaveAttribute(
    "data-atom-count",
    "24",
    { timeout: 60_000 },
  );

  // A file that is not a structure has no such entry.
  await page.locator(".jp-DirListing-item", { hasText: "notes.txt" }).click({ button: "right" });
  await expect(page.locator(".lm-Menu").first()).toBeVisible();
  await expect(page.locator(".lm-Menu-item", { hasText: "Open in Megane Builder" })).toBeHidden();
  await page.keyboard.press("Escape");

  await page.evaluate(() =>
    (
      window as unknown as { jupyterapp: { commands: { execute: (id: string) => Promise<void> } } }
    ).jupyterapp.commands.execute("launcher:create"),
  );
  await expect(
    page.locator(".jp-LauncherCard", { hasText: "Megane Builder" }).filter({ visible: true }),
  ).toBeVisible();
});
