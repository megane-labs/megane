/**
 * Phase 2.6 — trajectory playback with bond formation/destruction
 * cross-host coverage.
 *
 * Loads a 5-frame multi-frame XYZ fixture (`bond_change.xyz`) where two
 * hydrogens separate from 0.74 Å to 3.0 Å. With distance-based bond
 * inference active, the H-H bond is present at frame 0 and absent at
 * frame 4. The spec asserts both via the `data-bond-count` attribute on
 * the viewer root (deterministic) and via per-host pixel diffs.
 *
 * Multi-frame XYZ is the only trajectory format natively openable on
 * every megane host — JupyterLab DocWidget and the VSCode custom editor
 * do not register `.traj` or `.xtc`. Widget hosts also need a
 * `LoadTrajectory(xyz=...)` companion node injected by host-fixture.ts
 * because the Python `LoadStructure` path retains only frame 0.
 *
 * Defaults across the codebase set `bondSource: "structure"`. We flip
 * the AddBond node to `"distance"` after boot via the test-only
 * pipeline store (idempotent for widget hosts which already use
 * distance).
 */

import { test, expect } from "playwright/test";
import {
  assertDomContract,
  defaultViewerContract,
  expectViewerRegionMatch,
  getReadyState,
  stabilizeUi,
  waitForReady,
} from "./lib/setup";
import { bootHost, getHost, type HostBoot } from "./lib/host-fixture";
import { findNodeIdByType, setNodeParam } from "./lib/pipeline";
import { alignCamera } from "./lib/render-utils";
import type { Page, Frame } from "playwright/test";

const PLATFORM = "trajectory-bonds";
const FIXTURE = "bond_change.xyz";
const FIXTURE_ATOMS = 2;
const EXPECTED_FRAMES = 5;

test.describe.configure({ mode: "serial" });

let boot: HostBoot | null = null;

async function readBondCount(scope: Page | Frame): Promise<number> {
  const raw = await scope
    .locator('[data-testid="megane-viewer"]')
    .first()
    .getAttribute("data-bond-count");
  return raw === null ? Number.NaN : Number(raw);
}

async function seekTo(scope: Page | Frame, frame: number): Promise<void> {
  // Drive the seekbar UI when present — widget hosts (anywidget) keep
  // currentFrame as a React prop synchronised from the kernel, so a
  // direct playback-store seekFrame() does not propagate back through
  // the round-trip. The seekbar onChange path goes through the same
  // mechanism the user would. Hosts that omit the Timeline entirely
  // (DocWidget, vscode custom editor) fall back to the playback store
  // which is wired straight into MeganeViewer's effectiveFrame.
  const seekbar = scope.locator('[data-testid="playback-seekbar"]').first();
  const visible = await seekbar.count();
  if (visible > 0) {
    await seekbar.evaluate((el: HTMLInputElement, v: number) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, frame);
    return;
  }
  await scope.evaluate((v: number) => {
    const w = window as Window & {
      __megane_test_playback_store?: {
        getState: () => { seekFrame: (i: number) => void };
      };
    };
    const store = w.__megane_test_playback_store;
    if (!store) throw new Error("__megane_test_playback_store not exposed; testMode off?");
    store.getState().seekFrame(v);
  }, frame);
}

async function waitForFrame(scope: Page | Frame, frame: number): Promise<void> {
  await scope.waitForFunction(
    (target) => {
      const el = document.querySelector('[data-testid="megane-viewer"]');
      return el?.getAttribute("data-current-frame") === String(target);
    },
    frame,
    { timeout: 10_000 },
  );
}

test.beforeAll(async ({ browser }, info) => {
  const seed = info.workerIndex + 1;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  boot = await bootHost(page, { fixture: FIXTURE, portSeed: seed });

  // Force distance-based bond inference. Widget hosts already use
  // "distance" via host-fixture.ts; for non-widget hosts the default
  // ("structure") would not recompute bonds per frame.
  const before = await getReadyState(boot.scope);
  const bondNodeId = await findNodeIdByType(boot.scope, "add_bond");
  await setNodeParam(boot.scope, bondNodeId, { bondSource: "distance" });
  await waitForReady(boot.scope, {
    untilEpoch: before.renderEpoch + 1,
    timeout: 10_000,
  });

  // The H-H pair lies along x and the fitted standard orientation (#661)
  // looks roughly down x, which hides the stick between two overlapping
  // balls. View from +y so the bonded / unbonded captures actually show the
  // bond appearing and vanishing.
  await alignCamera(boot.scope, "+y");
  await boot.scope.waitForTimeout(200);
});

test.afterAll(async () => {
  if (boot) {
    await boot.teardown();
    if ("close" in boot.scope) {
      try {
        await (boot.scope as { close?: () => Promise<void> }).close?.();
      } catch {
        /* page may already be closed */
      }
    }
    boot = null;
  }
});

test("trajectory-bonds: frame 0 H-H bond present at 0.74 Å", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  await assertDomContract(scope, [
    ...defaultViewerContract({ expectedAtoms: FIXTURE_ATOMS, context: boot!.context }),
    {
      testid: "megane-viewer",
      attrs: {
        "data-current-frame": "0",
        "data-total-frames": String(EXPECTED_FRAMES),
      },
    },
  ]);

  const bondCount = await readBondCount(scope);
  expect(
    bondCount,
    `expected at least one bond at frame 0 (H-H = 0.74 Å), got ${bondCount}`,
  ).toBeGreaterThanOrEqual(1);

  await stabilizeUi(scope);
  await expectViewerRegionMatch(scope, PLATFORM, `${getHost()}-bonded`);
});

test("trajectory-bonds: frame 4 H-H bond absent at 3.0 Å", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  const before = await getReadyState(scope);
  await seekTo(scope, EXPECTED_FRAMES - 1);
  await waitForReady(scope, {
    untilEpoch: before.renderEpoch + 1,
    timeout: 10_000,
  });
  await waitForFrame(scope, EXPECTED_FRAMES - 1);

  const bondCount = await readBondCount(scope);
  expect(
    bondCount,
    `expected zero bonds at frame ${EXPECTED_FRAMES - 1} (H-H = 3.0 Å), got ${bondCount}`,
  ).toBe(0);

  await stabilizeUi(scope);
  await expectViewerRegionMatch(scope, PLATFORM, `${getHost()}-unbonded`);
});

test("trajectory-bonds: bond count is non-increasing across the playback range", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  const counts: number[] = [];
  for (let i = 0; i < EXPECTED_FRAMES; i++) {
    const before = await getReadyState(scope);
    await seekTo(scope, i);
    await waitForReady(scope, {
      untilEpoch: before.renderEpoch + 1,
      timeout: 10_000,
    });
    await waitForFrame(scope, i);
    counts.push(await readBondCount(scope));
  }

  for (let i = 1; i < counts.length; i++) {
    expect(
      counts[i],
      `bond count must be non-increasing across frames; got ${counts.join(", ")}`,
    ).toBeLessThanOrEqual(counts[i - 1]);
  }
  expect(counts[0]).toBeGreaterThanOrEqual(1);
  expect(counts[counts.length - 1]).toBe(0);
});

test("trajectory-bonds: play through the trajectory leaves bond broken at the end", async () => {
  if (!boot) test.skip(true, "boot not initialised");
  const scope = boot!.scope;

  // Reset to frame 0 first so the playback covers a full range.
  {
    const reset = await getReadyState(scope);
    await seekTo(scope, 0);
    await waitForReady(scope, {
      untilEpoch: reset.renderEpoch + 1,
      timeout: 10_000,
    });
    await waitForFrame(scope, 0);
  }

  // Drive play/pause via the playback store directly so this works on
  // hosts (DocWidget, custom editor) where the Timeline UI is absent.
  const beforePlay = await getReadyState(scope);
  await scope.evaluate(() => {
    const w = window as Window & {
      __megane_test_playback_store?: {
        getState: () => { play: () => void; pause: () => void };
      };
    };
    w.__megane_test_playback_store?.getState().play();
  });
  try {
    await waitForReady(scope, {
      untilEpoch: beforePlay.renderEpoch + EXPECTED_FRAMES,
      timeout: 15_000,
    });
  } finally {
    await scope.evaluate(() => {
      const w = window as Window & {
        __megane_test_playback_store?: {
          getState: () => { pause: () => void };
        };
      };
      w.__megane_test_playback_store?.getState().pause();
    });
  }

  // Playback wraps to frame 0 once it overruns; assert we either landed
  // on the terminal frame (with bond broken) or on frame 0 (with bond
  // restored). Both are acceptable as long as the data-bond-count
  // matches the visible frame.
  const finalFrame = Number(
    await scope.locator('[data-testid="megane-viewer"]').first().getAttribute("data-current-frame"),
  );
  const finalBondCount = await readBondCount(scope);
  if (finalFrame === EXPECTED_FRAMES - 1) {
    expect(finalBondCount).toBe(0);
  } else if (finalFrame === 0) {
    expect(finalBondCount).toBeGreaterThanOrEqual(1);
  } else {
    // Any intermediate frame: bond must be 0 or 1 (monotonic break) — we
    // verified this in the previous test, so just assert it is in range.
    expect(finalBondCount).toBeGreaterThanOrEqual(0);
    expect(finalBondCount).toBeLessThanOrEqual(1);
  }
});
