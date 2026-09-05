/**
 * Phase 2.3 — Camera operations.
 *
 * Drives the renderer's camera state via the test API exposed in Stage 1
 * (`window.__megane_test.{setCameraMode,resetCamera,getCameraState}`).
 * The pixel cases deliberately avoid mouse-driven camera input (pointer
 * event batching makes a drag's exact end pose timing-dependent) and
 * assert state transitions through the programmatic API; the
 * pole-crossing case drags for real but only asserts camera state, never
 * pixels.
 *
 * Cases:
 *   - Initial state: orthographic, target near origin
 *   - setCameraMode('perspective') flips mode and re-fits
 *   - resetCamera() returns target to the snapshot center after pan
 *   - a vertical left-drag rotates past the pole (issue #662)
 *
 * Widget hosts skip — WidgetViewer also exposes the renderer test API,
 * but the widget-jupyterlab/widget-vscode boots add ~30s+ overhead per
 * test, and camera state is host-agnostic. Coverage on webapp +
 * jupyterlab-doc + vscode is sufficient regression detection.
 */

import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectFullPageMatch,
  pinFrame,
  stabilizeUi,
  waitForReady,
  getReadyState,
} from "./lib/setup";
import { bootHost, getHost, type HostBoot } from "./lib/host-fixture";
import { getCameraState, getProjectedAtoms, resetCamera, setCameraMode } from "./lib/render-utils";

const PLATFORM = "camera";
const FIXTURE = "caffeine_water.pdb";
const FIXTURE_ATOMS = 3024;

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;

test.beforeAll(async ({ browser }, info) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: info.workerIndex + 21 });
  await assertDomContract(boot.scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot.context }),
  ]);
  // Pin the displayed trajectory frame before any capture: the webapp host
  // attaches the default 100-frame vibration XTC, whose frame 0 is decoded
  // lazily and applied asynchronously — without the pin the full-page
  // baselines race between base-snapshot and frame-0 positions (the
  // camera__webapp CI flake).
  await pinFrame(boot.scope, 0);
});

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    boot = null;
  }
});

test("camera: default state is orthographic and viewer-region baseline matches", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const state = await getCameraState(boot!.scope);
  expect(state).not.toBeNull();
  expect(state!.mode).toBe("orthographic");
  // Target is the snapshot bounding-box center; for caffeine_water it is
  // a finite number. Just sanity-check it's not NaN/Inf.
  expect(Number.isFinite(state!.target[0])).toBe(true);
  expect(Number.isFinite(state!.position[0])).toBe(true);
  await stabilizeUi(boot!.scope);
  await expectFullPageMatch(boot!.scope, PLATFORM, `${getHost()}-orthographic`);
});

test("camera: setCameraMode('perspective') flips mode and re-fits", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const before = await getReadyState(boot!.scope);
  await setCameraMode(boot!.scope, "perspective");
  await waitForReady(boot!.scope, { untilEpoch: before.renderEpoch + 1, timeout: 10_000 });
  const state = await getCameraState(boot!.scope);
  expect(state!.mode).toBe("perspective");
  await stabilizeUi(boot!.scope);
  await expectFullPageMatch(boot!.scope, PLATFORM, `${getHost()}-perspective`);
});

test("camera: resetCamera() restores fitted view", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  // Switch back to orthographic first so the reset baseline is comparable
  // with the initial orthographic capture.
  const beforeMode = await getReadyState(boot!.scope);
  await setCameraMode(boot!.scope, "orthographic");
  await waitForReady(boot!.scope, { untilEpoch: beforeMode.renderEpoch + 1, timeout: 10_000 });
  const stateA = await getCameraState(boot!.scope);
  await resetCamera(boot!.scope);
  // resetCamera doesn't necessarily increment renderEpoch on its own —
  // the next animate() tick will. Wait briefly for any frame.
  await boot!.scope.waitForTimeout(200);
  const stateB = await getCameraState(boot!.scope);
  // Targets should agree to within 1e-3 since both states fit the same
  // bounding box.
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(stateA!.target[i] - stateB!.target[i])).toBeLessThan(1e-3);
  }
  await stabilizeUi(boot!.scope);
  await expectFullPageMatch(boot!.scope, PLATFORM, `${getHost()}-reset`);
});

/**
 * Regression: zooming in then back out with the wheel must restore the model
 * without pressing "Reset view". The orthographic wheel zoom previously
 * over-shifted the frustum at high zoom and accumulated the offset
 * irreversibly, stranding all atoms off-screen on zoom-out. We drive real
 * WheelEvents (the OrbitControls dolly path Playwright's mouse.wheel takes
 * doesn't reach the capture-phase handler) and assert the on-screen atom
 * count recovers.
 */
test("camera: orthographic wheel zoom-out restores atoms (no reset needed)", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  await setCameraMode(scope, "orthographic");
  await resetCamera(scope);
  await scope.waitForTimeout(200);

  const dispatchWheel = (deltaY: number, n: number) =>
    scope.evaluate(
      ({ deltaY, n }) => {
        const el = document.querySelector("canvas");
        if (!el) throw new Error("no canvas");
        const r = el.getBoundingClientRect();
        for (let i = 0; i < n; i++) {
          el.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      { deltaY, n },
    );

  const onScreen = async () => {
    const atoms = await getProjectedAtoms(scope);
    const box = await scope.locator("canvas").first().boundingBox();
    const w = box?.width ?? 0;
    const h = box?.height ?? 0;
    return atoms.filter((a) => a.sx >= 0 && a.sx <= w && a.sy >= 0 && a.sy <= h).length;
  };

  const initial = await onScreen();
  expect(initial).toBeGreaterThan(0);

  // Zoom IN hard — most atoms leave the viewport (acceptable).
  await dispatchWheel(-120, 60);
  await scope.waitForTimeout(200);
  expect(await onScreen()).toBeLessThan(initial);

  // Zoom OUT the same amount — atoms must come back via the wheel alone.
  await dispatchWheel(120, 60);
  await scope.waitForTimeout(200);
  const recovered = await onScreen();
  expect(recovered).toBeGreaterThanOrEqual(initial * 0.95);

  const state = await getCameraState(scope);
  expect(state!.zoom).toBeCloseTo(1, 2);
});

/**
 * Issue #662: rotation must not stop at the ±c-axis poles. The fitted view
 * looks along +y with z up; a vertical left-drag tilts the camera over the
 * z pole. OrbitControls clamped the polar angle there, so the camera could
 * never reach the far side (position.y > target.y). The trackball controls
 * keep turning, so repeated upward drags eventually put it there.
 */
test("camera: left-drag rotates continuously across the pole", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;
  const page = "page" in scope ? scope.page() : scope;

  await setCameraMode(scope, "orthographic");
  await resetCamera(scope);
  await scope.waitForTimeout(200);

  const canvas = scope.locator('[data-testid="viewer-root"] canvas').first();
  // In a notebook the widget output can extend below the fold; bring the
  // canvas on screen and drag only within its visible band.
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const viewportH = page.viewportSize()?.height ?? box!.y + box!.height;
  const visTop = Math.max(box!.y, 0);
  const visBottom = Math.min(box!.y + box!.height, viewportH);
  const visH = visBottom - visTop;
  expect(visH).toBeGreaterThan(50);
  const yFrom = visBottom - visH * 0.15;
  const yTo = visTop + visH * 0.15;
  // The Pipeline side panel overlays part of the canvas (on the JupyterLab
  // hosts the canvas spans the full width, so its centre sits under the
  // panel). Probe a few columns and drag on the first one where the pointer
  // lands on the WebGL canvas at both ends of the drag.
  const cx = await scope.evaluate(
    ({ x0, w, ys }) => {
      const onCanvas = (x: number, y: number) => {
        const el = document.elementFromPoint(x, y);
        return el?.tagName === "CANVAS" && !!el.closest('[data-testid="viewer-root"]');
      };
      for (const f of [0.5, 0.3, 0.2, 0.15]) {
        const x = x0 + w * f;
        if (ys.every((y) => onCanvas(x, y))) return x;
      }
      throw new Error("no unobstructed column on the viewer canvas");
    },
    { x0: box!.x, w: box!.width, ys: [yFrom, yTo] },
  );

  const start = (await getCameraState(scope))!;
  const distance = (s: NonNullable<typeof start>) =>
    Math.hypot(
      s.position[0] - s.target[0],
      s.position[1] - s.target[1],
      s.position[2] - s.target[2],
    );
  const startDistance = distance(start);
  expect(start.position[1]).toBeLessThan(start.target[1]);

  let crossed = false;
  for (let i = 0; i < 8 && !crossed; i++) {
    await page.mouse.move(cx, yFrom);
    await page.mouse.down();
    await page.mouse.move(cx, yTo, { steps: 12 });
    await page.mouse.up();
    // Let the render loop consume the final pointer segment.
    await scope.waitForTimeout(200);
    const s = (await getCameraState(scope))!;
    crossed = s.position[1] > s.target[1];
  }
  expect(crossed).toBe(true);

  const end = (await getCameraState(scope))!;
  // A pure rotation keeps the camera on the same sphere around the pivot.
  expect(distance(end)).toBeCloseTo(startDistance, 3);
  expect(end.target[0]).toBeCloseTo(start.target[0], 3);
  expect(end.target[1]).toBeCloseTo(start.target[1], 3);
  expect(end.target[2]).toBeCloseTo(start.target[2], 3);
});
