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
 *   - Initial state: orthographic, target near origin, VESTA standard
 *     orientation derived from the fixture's cell (issue #661)
 *   - setCameraMode('perspective') flips mode and re-fits
 *   - resetCamera() returns target to the snapshot center after pan
 *   - alignCamera('+c') / the ±a…±z buttons turn the camera onto an axis
 *     keeping the distance (issue #661)
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
import {
  alignCamera,
  getCameraState,
  getProjectedAtoms,
  resetCamera,
  setCameraMode,
  type CameraState,
} from "./lib/render-utils";

const PLATFORM = "camera";
const FIXTURE = "caffeine_water.pdb";
const FIXTURE_ATOMS = 3024;

/** VESTA standard orientation angles (see src/renderer/cameraOrientation.ts). */
const AZIMUTH = Math.atan(1 / 3);
const ELEVATION = Math.atan(1 / 6);

/** Unit vector from the target to the camera. */
function eyeOf(s: CameraState): [number, number, number] {
  const d = [s.position[0] - s.target[0], s.position[1] - s.target[1], s.position[2] - s.target[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / len, d[1] / len, d[2] / len];
}

function distanceOf(s: CameraState): number {
  return Math.hypot(
    s.position[0] - s.target[0],
    s.position[1] - s.target[1],
    s.position[2] - s.target[2],
  );
}

function expectVec(got: ArrayLike<number>, want: ArrayLike<number>, digits = 3) {
  for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], digits);
}

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

/**
 * Issue #661: the initial view is VESTA's standard orientation computed from
 * the fixture's CRYST1 cell (44 × 44 × 44 Å, orthogonal): +c up, +b right,
 * eye swung by arctan(1/3) toward +b and raised by arctan(1/6).
 */
test("camera: initial view is the standard orientation of the cell", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const state = (await getCameraState(boot!.scope))!;
  const cosA = Math.cos(AZIMUTH);
  const sinA = Math.sin(AZIMUTH);
  const cosE = Math.cos(ELEVATION);
  const sinE = Math.sin(ELEVATION);
  expectVec(eyeOf(state), [cosE * cosA, cosE * sinA, sinE]);
  expect(state.up).toBeDefined();
  expectVec(state.up!, [-sinE * cosA, -sinE * sinA, cosE]);
  // The target is the cell centre.
  expectVec(state.target, [44.042 / 2, 44.046 / 2, 44.45 / 2], 2);
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
 * Issue #661: aligning with an axis only turns the camera — target, distance
 * and zoom stay — and "+c" puts the camera above the cell looking down c
 * with b up.
 */
test("camera: alignCamera('+c') looks down the c axis keeping the distance", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;
  await resetCamera(scope);
  await scope.waitForTimeout(200);
  const before = (await getCameraState(scope))!;

  await alignCamera(scope, "+c");
  await scope.waitForTimeout(200);
  const after = (await getCameraState(scope))!;

  expectVec(eyeOf(after), [0, 0, 1]);
  expectVec(after.up!, [0, 1, 0]);
  expectVec(after.target, before.target);
  expect(distanceOf(after)).toBeCloseTo(distanceOf(before), 3);
  expect(after.zoom).toBeCloseTo(before.zoom, 6);
  await stabilizeUi(scope);
  await expectFullPageMatch(scope, PLATFORM, `${getHost()}-align-c`);
});

/**
 * Issue #661: the axis buttons in the viewer chrome drive the same operation.
 * The fixture carries a cell, so both the crystal and the Cartesian rows are
 * present; "-a" puts the camera on the -a side of the cell.
 */
test("camera: axis buttons align the camera", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;
  await assertDomContract(scope, [
    { testid: "view-axis-controls", visible: true },
    { testid: "view-axis-row-lattice", visible: true },
    { testid: "view-axis-row-cartesian", visible: true },
  ]);
  await resetCamera(scope);
  await scope.waitForTimeout(200);
  const before = (await getCameraState(scope))!;

  await scope.locator('[data-testid="view-axis--a"]').click();
  await scope.waitForTimeout(200);
  const alongA = (await getCameraState(scope))!;
  expectVec(eyeOf(alongA), [-1, 0, 0]);
  expectVec(alongA.up!, [0, 0, 1]);
  expect(distanceOf(alongA)).toBeCloseTo(distanceOf(before), 3);

  await scope.locator('[data-testid="view-axis-+y"]').click();
  await scope.waitForTimeout(200);
  const alongY = (await getCameraState(scope))!;
  expectVec(eyeOf(alongY), [0, 1, 0]);
  expectVec(alongY.up!, [0, 0, 1]);
  expectVec(alongY.target, before.target);
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
 * sits slightly above the ab plane with c up; a vertical left-drag tilts the
 * camera over the c pole. OrbitControls clamped the polar angle there, so
 * the camera could never reach the far side of the cell (its horizontal
 * offset from the target flipped sign). The trackball controls keep turning,
 * so repeated upward drags eventually put it there.
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
  // On the VSCode hosts the viewer lives in a webview iframe: the mouse
  // works in page coordinates while elementFromPoint wants frame-local
  // ones, so keep the offset between the two.
  const local = await canvas.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const offX = box!.x - local.x;
  const offY = box!.y - local.y;
  const viewportH = page.viewportSize()?.height ?? box!.y + box!.height;
  const visTop = Math.max(box!.y, 0);
  const visBottom = Math.min(box!.y + box!.height, viewportH);
  const visH = visBottom - visTop;
  expect(visH).toBeGreaterThan(50);
  // The Pipeline side panel overlays part of the canvas (on the JupyterLab
  // hosts the canvas spans the full width, so its centre sits under the
  // panel), and a notebook cell can clip the canvas vertically. Probe a few
  // columns and drag bands and use the first pair where the pointer lands
  // on the WebGL canvas at both ends of the drag.
  const pick = await scope.evaluate(
    ({ x0, w, top, h, offX, offY }) => {
      const onCanvas = (x: number, y: number) => {
        const el = document.elementFromPoint(x - offX, y - offY);
        return el?.tagName === "CANVAS" && !!el.closest('[data-testid="viewer-root"]');
      };
      for (const [fFrom, fTo] of [
        [0.85, 0.15],
        [0.7, 0.3],
      ]) {
        const yFrom = top + h * fFrom;
        const yTo = top + h * fTo;
        for (const f of [0.5, 0.3, 0.2, 0.15]) {
          const x = x0 + w * f;
          if (onCanvas(x, yFrom) && onCanvas(x, yTo)) return { cx: x, yFrom, yTo };
        }
      }
      throw new Error("no unobstructed drag path on the viewer canvas");
    },
    { x0: box!.x, w: box!.width, top: visTop, h: visH, offX, offY },
  );
  const { cx, yFrom, yTo } = pick;

  const start = (await getCameraState(scope))!;
  const startDistance = distanceOf(start);
  // Horizontal (ab-plane) direction the camera starts on; a vertical drag
  // rotates in the plane spanned by it and c, so once the camera is over the
  // pole its offset along this direction goes negative.
  const startEye = eyeOf(start);
  const hLen = Math.hypot(startEye[0], startEye[1]);
  const h0 = [startEye[0] / hLen, startEye[1] / hLen];
  const side = (s: CameraState) => {
    const e = eyeOf(s);
    return e[0] * h0[0] + e[1] * h0[1];
  };
  expect(side(start)).toBeGreaterThan(0);

  let crossed = false;
  for (let i = 0; i < 8 && !crossed; i++) {
    await page.mouse.move(cx, yFrom);
    await page.mouse.down();
    await page.mouse.move(cx, yTo, { steps: 12 });
    await page.mouse.up();
    // Let the render loop consume the final pointer segment.
    await scope.waitForTimeout(200);
    const s = (await getCameraState(scope))!;
    crossed = side(s) < 0;
  }
  expect(crossed).toBe(true);

  const end = (await getCameraState(scope))!;
  // A pure rotation keeps the camera on the same sphere around the pivot.
  expect(distanceOf(end)).toBeCloseTo(startDistance, 3);
  expect(end.target[0]).toBeCloseTo(start.target[0], 3);
  expect(end.target[1]).toBeCloseTo(start.target[1], 3);
  expect(end.target[2]).toBeCloseTo(start.target[2], 3);
});
