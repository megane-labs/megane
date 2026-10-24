/**
 * Immersive view (WebXR) E2E on the webapp host.
 *
 * Headless Chromium has no headset, so the page gets Meta's Immersive Web
 * Emulation Runtime (IWER, the `iwer` devDependency) emulating a Quest 3:
 * `navigator.xr`, a stereo XRWebGLLayer that draws both eyes side by side on
 * the page, and two scriptable Touch controllers. The specs drive the real
 * VR / AR buttons, then check the session through `__megane_test.getXRState()`
 * and the drawn pixels — no baselines, so the GL drift between hosts does not
 * matter.
 */

import { join } from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { test, expect, type Page } from "playwright/test";
import { waitForReady } from "./lib/setup";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const IWER_BUNDLE = join(REPO, "node_modules", "iwer", "build", "iwer.min.js");

interface XRState {
  presenting: boolean;
  mode: string | null;
  frames: number;
  scale: number;
  position: [number, number, number];
}

type XRWindow = Window & {
  IWER: {
    XRDevice: new (config: unknown) => EmulatedDevice;
    metaQuest3: unknown;
  };
  __iwer: EmulatedDevice;
  __megane_test: { getXRState: () => XRState | null };
};

interface EmulatedController {
  position: { x: number; y: number; z: number };
  updateButtonValue(id: string, value: number): void;
}

interface EmulatedDevice {
  installRuntime(options: { forceInstall: boolean }): void;
  stereoEnabled: boolean;
  controllers: { left: EmulatedController; right: EmulatedController };
  activeSession?: { end(): Promise<void> };
}

/** Install the emulated Quest 3 before any page script runs. */
async function emulateQuest3(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(() => {
    const w = window as unknown as XRWindow;
    const device = new w.IWER.XRDevice(w.IWER.metaQuest3);
    // Chromium ships a native navigator.xr (with no device behind it).
    device.installRuntime({ forceInstall: true });
    device.stereoEnabled = true;
    w.__iwer = device;
  });
}

async function xrState(page: Page): Promise<XRState> {
  const state = await page.evaluate(() =>
    (window as unknown as XRWindow).__megane_test.getXRState(),
  );
  expect(state).not.toBeNull();
  return state!;
}

async function waitForXRFrames(page: Page, atLeast: number): Promise<void> {
  await page.waitForFunction(
    (n) => ((window as unknown as XRWindow).__megane_test.getXRState()?.frames ?? 0) >= n,
    atLeast,
    { timeout: 20_000 },
  );
}

/** Let the emulator report input changes and the session draw a few frames. */
async function settle(page: Page): Promise<void> {
  const { frames } = await xrState(page);
  await waitForXRFrames(page, frames + 3);
}

/** Fraction of pixels in each half of the page that are not background white. */
async function inkPerEye(page: Page): Promise<[number, number]> {
  const png = PNG.sync.read(await page.screenshot());
  const half = Math.floor(png.width / 2);
  const ink = [0, 0];
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (r + g + b < 3 * 235) ink[x < half ? 0 : 1]++;
    }
  }
  const perHalf = half * png.height;
  return [ink[0] / perHalf, ink[1] / perHalf];
}

test.describe("xr: webapp", () => {
  test.setTimeout(120_000);

  test("offers no VR / AR buttons without a headset", async ({ page }) => {
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await expect(page.locator('[data-testid="reset-view-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="xr-controls"]')).toHaveCount(0);
  });

  test("enters VR, draws both eyes, and follows grabbing hands", async ({ page }) => {
    await emulateQuest3(page);
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await expect(page.locator('[data-testid="xr-enter-vr"]')).toBeVisible();
    await expect(page.locator('[data-testid="xr-enter-ar"]')).toBeVisible();

    await page.locator('[data-testid="xr-enter-vr"]').click();
    await waitForXRFrames(page, 5);
    const placed = await xrState(page);
    expect(placed).toMatchObject({ presenting: true, mode: "immersive-vr" });
    // Scaled from Å to a ~0.5 m wide model, a little ahead of the user.
    expect(placed.scale).toBeGreaterThan(1e-3);
    expect(placed.scale).toBeLessThan(5e-2);
    expect(placed.position[2]).toBeLessThan(0);

    // Both eyes show the structure.
    const [left, right] = await inkPerEye(page);
    expect(left).toBeGreaterThan(0.01);
    expect(right).toBeGreaterThan(0.01);

    // One hand: hold the trigger and move 20 cm right — the structure follows.
    await page.evaluate(() => {
      (window as unknown as XRWindow).__iwer.controllers.right.updateButtonValue("trigger", 1);
    });
    await settle(page);
    const grabbed = await xrState(page);
    await page.evaluate(() => {
      (window as unknown as XRWindow).__iwer.controllers.right.position.x += 0.2;
    });
    await settle(page);
    await page.evaluate(() => {
      (window as unknown as XRWindow).__iwer.controllers.right.updateButtonValue("trigger", 0);
    });
    await settle(page);
    const moved = await xrState(page);
    expect(moved.position[0] - grabbed.position[0]).toBeCloseTo(0.2, 3);
    expect(moved.scale).toBeCloseTo(grabbed.scale, 9);

    // Two hands: squeeze both and pull them apart to twice the spacing.
    await page.evaluate(() => {
      const { left, right } = (window as unknown as XRWindow).__iwer.controllers;
      left.updateButtonValue("squeeze", 1);
      right.updateButtonValue("squeeze", 1);
    });
    await settle(page);
    await page.evaluate(() => {
      const { left, right } = (window as unknown as XRWindow).__iwer.controllers;
      const half = (right.position.x - left.position.x) / 2;
      left.position.x -= half;
      right.position.x += half;
    });
    await settle(page);
    await page.evaluate(() => {
      const { left, right } = (window as unknown as XRWindow).__iwer.controllers;
      left.updateButtonValue("squeeze", 0);
      right.updateButtonValue("squeeze", 0);
    });
    await settle(page);
    expect((await xrState(page)).scale / moved.scale).toBeCloseTo(2, 3);
  });

  test("returns to the desktop view when the session ends", async ({ page }) => {
    await emulateQuest3(page);
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await page.locator('[data-testid="xr-enter-vr"]').click();
    await waitForXRFrames(page, 3);
    const epoch = await page.evaluate(
      () =>
        (window as unknown as { __megane_test_ready: { renderEpoch: number } }).__megane_test_ready
          .renderEpoch,
    );
    // The headset's system menu ends the session from outside the page.
    await page.evaluate(() => (window as unknown as XRWindow).__iwer.activeSession?.end());
    await page.waitForFunction(
      () => (window as unknown as XRWindow).__megane_test.getXRState()?.presenting === false,
    );
    await expect(page.locator('[data-testid="xr-enter-vr"]')).toBeVisible();
    // The desktop loop is back: new frames are drawn.
    await waitForReady(page, { untilEpoch: epoch + 2 });
    await expect(page.locator('[data-testid="reset-view-btn"]')).toBeVisible();
  });

  test("enters passthrough AR", async ({ page }) => {
    await emulateQuest3(page);
    await page.goto("/?test=1", { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await page.locator('[data-testid="xr-enter-ar"]').click();
    await waitForXRFrames(page, 3);
    expect(await xrState(page)).toMatchObject({ presenting: true, mode: "immersive-ar" });
    await page.evaluate(() => (window as unknown as XRWindow).__iwer.activeSession?.end());
    await page.waitForFunction(
      () => (window as unknown as XRWindow).__megane_test.getXRState()?.presenting === false,
    );
  });

  test("megane Builder offers the same immersive view", async ({ page }) => {
    await emulateQuest3(page);
    await page.addInitScript(() => {
      (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
    });
    await page.goto("/builder.html?test=1", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-testid="megane-builder"]')).toBeVisible();
    await page.locator('[data-testid="xr-enter-vr"]').click();
    await waitForXRFrames(page, 3);
    expect(await xrState(page)).toMatchObject({ presenting: true, mode: "immersive-vr" });
    await page.evaluate(() => (window as unknown as XRWindow).__iwer.activeSession?.end());
    await page.waitForFunction(
      () => (window as unknown as XRWindow).__megane_test.getXRState()?.presenting === false,
    );
    await expect(page.locator('[data-testid="xr-enter-vr"]')).toBeVisible();
  });
});
