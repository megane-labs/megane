/**
 * megane Builder in the JupyterLab extension.
 *
 * The megane panel in the left sidebar lists the structure files of the file
 * browser's folder and opens one in a main-area Builder tab; the file
 * browser's context menu and the launcher reach it too. Every Builder tab
 * edits a document of its own, so *Open Builder* adds one each time. Checks that the
 * labextension's bundle runs the Builder's heavy parts (the RDKit worker built
 * by webpack, the lazily loaded Ketcher), that its keyboard shortcuts stay
 * inside the tab, and that Save writes into the server's contents. The
 * *Tools* menu reaches a stdio MCP tool server configured on the Jupyter
 * server (`MeganeBuilderTools.mcp_servers`) through megane's server extension.
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
  // megane's server extension, with a stdio server replaying the reference
  // tool server's recorded responses.
  const config = "/tmp/megane-e2e-builder-lab-config.json";
  writeFileSync(
    config,
    JSON.stringify({
      ServerApp: { jpserver_extensions: { "megane.builder_tools": true } },
      MeganeBuilderTools: {
        mcp_servers: {
          "recorded-tools": {
            command: "node",
            args: [join(REPO, "tests", "e2e", "lib", "fake-builder-tools.mjs")],
          },
        },
      },
    }),
  );
  lab = await startJupyterLab({
    configFile: config,
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

/** The Builder in the main-area tab on screen. */
const shownBuilder = (page: Page) =>
  page
    .locator(".megane-builder-panel")
    .filter({ visible: true })
    .locator('[data-testid="megane-builder"]');

/** The main area's tabs titled `text`. */
const mainTabs = (page: Page, text: string) =>
  page.locator("#jp-main-dock-panel .lm-TabBar-tab", { hasText: text });

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
  const builder = page.locator('.megane-builder-panel [data-testid="megane-builder"]');
  await expect(builder).toHaveAttribute("data-atom-count", "24", { timeout: 60_000 });
  await waitForReady(page);
  await expect(page.locator('[data-testid="builder-file-name"]')).toHaveText("caffeine.sdf");
  // The Tools menu reaches the Jupyter server's tool servers.
  await expect(page.locator('[data-testid="builder-tools"]')).toHaveCount(1);

  // The tab's keys act only while the focus is in it.
  await page.locator('.megane-builder-panel [data-testid="viewer-root"]').click();
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

test("the Tools menu runs the Jupyter server's stdio tool server", async ({ page }) => {
  await openLab(page);
  await sidebarTab(page).click();
  await page.locator('[data-testid="megane-builder-sidebar-open"]').click();
  const panel = page.locator(".megane-builder-panel").filter({ visible: true });
  const tools = panel.locator('[data-testid="builder-tools"]');

  // The menu offers the configured server; connecting asks first (§9).
  await tools.click();
  await page.locator('[data-testid="builder-tools-connect-recorded-tools"]').click();
  const dialog = page.locator(".jp-Dialog");
  await expect(dialog).toContainText('Allow the tool server "recorded-tools"?');
  await expect(dialog).toContainText("fake-builder-tools.mjs");
  await dialog.locator(".jp-Dialog-button", { hasText: "Allow" }).click();
  await expect(page.locator('[data-testid="builder-tools-connected"]')).toContainText(
    "Connected to megane-builder-tools: 3 tools",
    { timeout: 60_000 },
  );

  // A new-document tool replaces the empty document.
  await tools.click();
  await page.locator('[data-testid="builder-tools-button-liquid_box"]').click();
  await page
    .locator('[data-testid="builder-tool-field-components-0-molecule"]')
    .selectOption("preset:water");
  await page.locator('[data-testid="builder-tool-field-seed"]').fill("42");
  await page.locator('[data-testid="builder-tool-run"]').click();
  const builder = panel.locator('[data-testid="megane-builder"]');
  await expect(builder).toHaveAttribute("data-atom-count", "300", { timeout: 60_000 });

  // An insert tool adds its atoms to the open document as one step.
  await tools.click();
  await page.locator('[data-testid="builder-tools-button-solvate"]').click();
  await page.locator('[data-testid="builder-tool-run"]').click();
  await expect(builder).toHaveAttribute("data-atom-count", "1098", { timeout: 60_000 });
  await expect(page.locator('[data-testid="builder-notice"]')).toContainText("Solvate");

  // The answer is remembered: reconnecting does not ask again.
  await tools.click();
  await page.locator('[data-testid="builder-tools-server"]').click();
  await page.locator('[data-testid="builder-tools-disconnect"]').click();
  await page.locator('[data-testid="builder-tools-connect"]').click();
  await expect(page.locator('[data-testid="builder-tools-connected"]')).toBeVisible();
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
  await expect(page.locator('.megane-builder-panel [data-testid="megane-builder"]')).toBeVisible();
  await openSketch(page);
  await waitForKetcher(page);
  await expect(page.locator('[data-testid="sketch-fallback"]')).toHaveCount(0);
});

test("the file browser's context menu and the launcher reach the Builder", async ({ page }) => {
  await openLab(page);
  const item = page.locator(".jp-DirListing-item", { hasText: "caffeine.sdf" });
  await item.click({ button: "right" });
  const entry = page.locator(".lm-Menu-item", { hasText: "Open in megane Builder" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(
    page.locator('.megane-builder-panel [data-testid="megane-builder"]'),
  ).toHaveAttribute("data-atom-count", "24", { timeout: 60_000 });

  // A file that is not a structure has no such entry.
  await page.locator(".jp-DirListing-item", { hasText: "notes.txt" }).click({ button: "right" });
  await expect(page.locator(".lm-Menu").first()).toBeVisible();
  await expect(page.locator(".lm-Menu-item", { hasText: "Open in megane Builder" })).toBeHidden();
  await page.keyboard.press("Escape");

  await page.evaluate(() =>
    (
      window as unknown as { jupyterapp: { commands: { execute: (id: string) => Promise<void> } } }
    ).jupyterapp.commands.execute("launcher:create"),
  );
  await expect(
    page.locator(".jp-LauncherCard", { hasText: "megane Builder" }).filter({ visible: true }),
  ).toBeVisible();
});

test("Open Builder adds a tab with a document of its own each time; a file opens in one tab", async ({
  page,
}) => {
  await openLab(page);
  await sidebarTab(page).click();
  const sidebar = page.locator("#megane-builder-sidebar");
  const openBuilder = sidebar.locator('[data-testid="megane-builder-sidebar-open"]');
  const file = sidebar.locator('[data-testid="megane-builder-sidebar-file"]', {
    hasText: "caffeine.sdf",
  });
  const panels = page.locator(".megane-builder-panel");

  await openBuilder.click();
  await expect(panels).toHaveCount(1);
  await openBuilder.click();
  await expect(panels).toHaveCount(2);
  await expect(mainTabs(page, "megane Builder")).toHaveCount(2);

  // The file opens in a tab of its own.
  await file.click();
  await expect(panels).toHaveCount(3);
  await expect(shownBuilder(page)).toHaveAttribute("data-atom-count", "24", { timeout: 60_000 });
  await expect(mainTabs(page, "caffeine.sdf — Builder")).toHaveClass(/lm-mod-current/);

  // The empty Builders kept their own (empty) documents.
  await mainTabs(page, "megane Builder").first().click();
  await expect(shownBuilder(page)).toHaveAttribute("data-atom-count", "0");

  // Asking for the file again brings its tab back instead of adding one.
  await file.click();
  await expect(panels).toHaveCount(3);
  await expect(mainTabs(page, "caffeine.sdf — Builder")).toHaveClass(/lm-mod-current/);
  await expect(shownBuilder(page)).toHaveAttribute("data-atom-count", "24");

  // A closed tab is gone, and Open Builder still opens a new one.
  await mainTabs(page, "caffeine.sdf — Builder").locator(".lm-TabBar-tabCloseIcon").click();
  await expect(panels).toHaveCount(2);
  await openBuilder.click();
  await expect(panels).toHaveCount(3);
  await expect(shownBuilder(page)).toHaveAttribute("data-atom-count", "0");
});
