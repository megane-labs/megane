/**
 * "Open from server..." on the Load nodes (webapp host).
 *
 * Under `megane serve` the webapp probes `/api/files` at startup and, when it
 * answers with a listing, the Load Structure / Load Trajectory nodes get a
 * second button that browses the server's files in megane's own dialog. The
 * E2E static server has no such API, so the spec answers `/api/files` itself
 * (`page.route`) from `tests/fixtures/` with the response shapes
 * `python/megane/server.py` produces — the server side is covered by
 * `tests/python/test_server_files.py`. Assertions are DOM-contract only.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "playwright/test";
import { getReadyState, waitForReady } from "./lib/setup";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const FIXTURES = join(REPO, "tests", "fixtures");

/** Serve `tests/fixtures/` (top level only) as megane serve's `/api/files`. */
async function routeServerFiles(page: Page, requests: string[] = []): Promise<void> {
  await page.route("**/api/files**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    requests.push(`${url.pathname}?path=${path}`);
    if (url.pathname.endsWith("/api/files/content")) {
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: readFileSync(join(FIXTURES, path)),
      });
      return;
    }
    if (path === "run") {
      await route.fulfill({
        json: { path: "run", parent: "", entries: [] },
      });
      return;
    }
    const entries = readdirSync(FIXTURES)
      .filter((name) => !name.startsWith("."))
      .map((name) => {
        const isDir = statSync(join(FIXTURES, name)).isDirectory();
        return {
          name,
          path: name,
          isDir,
          size: isDir ? null : statSync(join(FIXTURES, name)).size,
        };
      })
      .filter((e) => !e.isDir);
    entries.unshift({ name: "run", path: "run", isDir: true, size: null });
    await route.fulfill({ json: { path: "", parent: null, entries } });
  });
}

/** Select a node's card so its form (with the Load buttons) shows in the properties pane. */
async function openNodeForm(page: Page, type: "load_structure" | "load_trajectory") {
  await page.locator('[data-testid="pipeline-editor-tab-editor"]').click();
  const card = page.locator(`[data-testid="pipeline-node-${type}"]`).first();
  await expect(card).toBeVisible();
  await card.click();
}

function entry(page: Page, name: string) {
  return page.locator(`[data-testid="remote-file-dialog-entry"][data-name="${name}"]`);
}

test.describe("remote files: webapp under megane serve", () => {
  test("opens a structure from the server through the Load Structure node", async ({ page }) => {
    const requests: string[] = [];
    await routeServerFiles(page, requests);
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);

    await openNodeForm(page, "load_structure");
    const button = page.locator('[data-testid="load-structure-remote"]').first();
    await expect(button).toHaveText("Open from server...");
    await button.click();

    const dialog = page.locator('[data-testid="remote-file-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Open structure");
    // Folders open; files the node can't load are listed but disabled.
    await expect(entry(page, "1crn.pdb")).toBeEnabled();
    await expect(entry(page, "caffeine_water_vibration.xtc")).toBeDisabled();

    await entry(page, "run").click();
    await expect(page.locator('[data-testid="remote-file-dialog-path"]')).toHaveText("/run");
    await expect(dialog).toContainText("This folder is empty.");
    await page.locator('[data-testid="remote-file-dialog-up"]').click();

    const before = await getReadyState(page);
    await entry(page, "1crn.pdb").click();
    await page.locator('[data-testid="remote-file-dialog-open"]').click();
    await expect(dialog).toHaveCount(0);
    await waitForReady(page, { untilEpoch: before.renderEpoch + 1 });

    await expect(page.locator('[data-testid="load-structure-filename"]').first()).toHaveText(
      "1crn.pdb",
    );
    await expect(page.locator('[data-testid="megane-viewer"]')).toHaveAttribute(
      "data-atom-count",
      "327",
    );
    expect(requests).toContain("/api/files/content?path=1crn.pdb");
  });

  test("opens a trajectory from the server through the Load Trajectory node", async ({ page }) => {
    await routeServerFiles(page);
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);

    await openNodeForm(page, "load_trajectory");
    await page.locator('[data-testid="load-trajectory-remote"]').first().click();
    const dialog = page.locator('[data-testid="remote-file-dialog"]');
    await expect(dialog).toContainText("Open trajectory");
    await expect(entry(page, "1crn.pdb")).toBeDisabled();
    await entry(page, "caffeine_water_vibration.xtc").dblclick();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-testid="load-trajectory-filename"]').first()).toHaveText(
      "caffeine_water_vibration.xtc",
    );
    await expect
      .poll(async () =>
        Number(
          (await page.locator('[data-testid="megane-viewer"]').getAttribute("data-total-frames")) ??
            0,
        ),
      )
      .toBeGreaterThan(1);
  });

  test("Escape closes the dialog without loading anything", async ({ page }) => {
    await routeServerFiles(page);
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await openNodeForm(page, "load_structure");
    await page.locator('[data-testid="load-structure-remote"]').first().click();
    await expect(entry(page, "1crn.pdb")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="remote-file-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="load-structure-filename"]').first()).toHaveText(
      "caffeine_water.pdb",
    );
  });
});

test.describe("remote files: webapp without a file API", () => {
  test("shows no Open from server button", async ({ page }) => {
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await openNodeForm(page, "load_structure");
    await expect(page.locator('[data-testid="load-structure-input"]').first()).toBeAttached();
    await expect(page.locator('[data-testid="load-structure-remote"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="load-trajectory-remote"]')).toHaveCount(0);
  });
});
