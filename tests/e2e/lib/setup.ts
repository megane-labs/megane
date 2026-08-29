/**
 * Shared E2E test helpers for megane (M1 foundation).
 *
 * Provides three layers of assertion that all platform specs use:
 *
 *   1. assertDomContract  — required test-ids (presence, attributes, count)
 *   2. captureFullPage    — full-window pixel-diff baseline (incl. host UI)
 *   3. captureViewerRegion — pixel-diff of the viewer-root rectangle only,
 *                             used for cross-platform Parity assertions
 *
 * It also exposes a shared waitForReady() that synchronizes against the
 * deterministic ready signal exposed by MoleculeRenderer when the page is
 * loaded with `?test=1` (or globalThis.__MEGANE_TEST__ === true).
 *
 * The smoke-level "canvas exists + non-white pixel ratio" check from earlier
 * E2E suites is intentionally absent here — it is the regression-detection
 * gap this rewrite is meant to close.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import type { Frame, Locator, Page } from "playwright/test";
import { expect } from "playwright/test";

// pixelmatch / pngjs are project devDeps and resolve from the project's
// node_modules. The dynamic import lets this module compile under tsc even
// when tests are not being run.
async function loadPixelMatch(): Promise<{
  pixelmatch: (
    img1: Uint8Array,
    img2: Uint8Array,
    out: Uint8Array | null,
    w: number,
    h: number,
    opts?: { threshold?: number },
  ) => number;
  PNG: typeof import("pngjs").PNG;
}> {
  const pm = await import("pixelmatch");
  const pngMod = await import("pngjs");
  return {
    pixelmatch: (pm as { default: typeof pm }).default ?? (pm as never),
    PNG: pngMod.PNG,
  };
}

const PIXEL_THRESHOLD = 0.15;
const DEFAULT_MAX_DIFF_PERCENT = 2.0;

/* ─── Ready signal ─────────────────────────────────────────────── */

/**
 * Wait for the renderer's `window.__megane_test_ready` to satisfy the given
 * gates. Set when the page is loaded with `?test=1`.
 *
 * - `firstFrame: true`           — at least one render with a snapshot bound
 * - `dataLoaded: true`           — loadSnapshot() was called
 * - `untilEpoch: <n>`            — wait until renderEpoch >= n (post-interaction)
 * - `inFrame`                    — search inside an iframe (Widget/VSCode webview)
 */
export async function waitForReady(
  scope: Page | Frame,
  opts: {
    needsData?: boolean;
    untilEpoch?: number;
    timeout?: number;
  } = {},
): Promise<void> {
  const { needsData = true, untilEpoch, timeout = 30_000 } = opts;
  try {
    await scope.waitForFunction(
      ([needsData, minEpoch]: [boolean, number | undefined]) => {
        const w = window as unknown as {
          __megane_test_ready?: {
            firstFrame: boolean;
            dataLoaded: boolean;
            renderEpoch: number;
          };
        };
        const r = w.__megane_test_ready;
        if (!r) return false;
        if (!r.firstFrame) return false;
        if (needsData && !r.dataLoaded) return false;
        if (typeof minEpoch === "number" && r.renderEpoch < minEpoch) return false;
        return true;
      },
      [needsData, untilEpoch],
      { timeout },
    );
  } catch (e) {
    // Best-effort diagnostic: dump what the page sees so the test
    // log shows whether testMode never engaged vs data never loaded.
    const state = await scope
      .evaluate(() => {
        const w = window as unknown as {
          __megane_test_ready?: unknown;
          __MEGANE_TEST__?: unknown;
          location?: { search?: string; href?: string };
        };
        return {
          ready: w.__megane_test_ready ?? null,
          testFlag: w.__MEGANE_TEST__ ?? null,
          search: w.location?.search ?? null,
          href: w.location?.href ?? null,
        };
      })
      .catch(() => null);
    // eslint-disable-next-line no-console
    console.error("waitForReady timeout. State:", JSON.stringify(state));
    throw e;
  }
}

/** Read the current ready state — used to snapshot epoch before an interaction. */
export async function getReadyState(scope: Page | Frame): Promise<{
  firstFrame: boolean;
  dataLoaded: boolean;
  renderEpoch: number;
  frame?: number;
  atomCount?: number;
}> {
  return scope.evaluate(() => {
    const w = window as unknown as {
      __megane_test_ready?: {
        firstFrame: boolean;
        dataLoaded: boolean;
        renderEpoch: number;
        frame?: number;
        atomCount?: number;
      };
    };
    return (
      w.__megane_test_ready ?? {
        firstFrame: false,
        dataLoaded: false,
        renderEpoch: 0,
      }
    );
  });
}

/* ─── DOM contract ─────────────────────────────────────────────── */

export interface DomContractItem {
  /** test id required by the contract */
  testid: string;
  /** must be present and visible */
  visible?: boolean;
  /** exact text content (trimmed) */
  text?: string;
  /** must be enabled (not have the disabled attribute) */
  enabled?: boolean;
  /** required count of elements with this testid (default 1) */
  count?: number;
  /** required attribute key/value pairs on the element */
  attrs?: Record<string, string | number>;
}

/**
 * Assert that all required test-ids (and their attributes) are present and
 * in the expected state. This is the cheapest layer in the 3-layer stack
 * and catches regressions like "menu item disappeared in widget but still
 * exists in webapp" before any pixel comparison runs.
 */
export async function assertDomContract(
  scope: Page | Frame,
  contract: DomContractItem[],
): Promise<void> {
  for (const item of contract) {
    const sel = `[data-testid="${item.testid}"]`;
    const expectedCount = item.count ?? 1;
    const handles = scope.locator(sel);
    await expect(
      handles,
      `data-testid="${item.testid}" expected count=${expectedCount}`,
    ).toHaveCount(expectedCount);

    const target = handles.first();
    if (item.visible !== false) {
      await expect(target, `data-testid="${item.testid}" should be visible`).toBeVisible();
    }
    if (item.text !== undefined) {
      await expect(target, `data-testid="${item.testid}" text mismatch`).toHaveText(item.text);
    }
    if (item.enabled === true) {
      await expect(target, `data-testid="${item.testid}" should be enabled`).toBeEnabled();
    } else if (item.enabled === false) {
      await expect(target, `data-testid="${item.testid}" should be disabled`).toBeDisabled();
    }
    if (item.attrs) {
      for (const [k, v] of Object.entries(item.attrs)) {
        await expect(
          target,
          `data-testid="${item.testid}" attribute ${k} mismatch`,
        ).toHaveAttribute(k, String(v));
      }
    }
  }
}

/** Common contract that EVERY platform must satisfy when a structure is loaded. */
export function defaultViewerContract(
  opts: {
    expectedAtoms?: number;
    context?: string;
  } = {},
): DomContractItem[] {
  const items: DomContractItem[] = [
    { testid: "megane-viewer", visible: true },
    { testid: "viewer-root", visible: true },
  ];
  if (opts.context) {
    items[0].attrs = { "data-megane-context": opts.context };
  }
  if (opts.expectedAtoms !== undefined) {
    items[0] = {
      ...items[0],
      attrs: { ...(items[0].attrs ?? {}), "data-atom-count": String(opts.expectedAtoms) },
    };
  }
  return items;
}

/* ─── Capture helpers ──────────────────────────────────────────── */

/**
 * Take a full-page screenshot. Defaults are tuned to suppress accidental
 * sources of pixel jitter (animations, blinking caret, scrollbars).
 */
export async function captureFullPage(
  scope: Page | Frame,
  outPath: string,
  opts: { mask?: Locator[] } = {},
): Promise<Buffer> {
  await stabilizeUi(scope);
  // For Frame inputs (vscode webview, widget-vscode notebook output),
  // resolve up to the owning Page so the screenshot covers the entire
  // host window (IDE chrome + the embedded viewer), not just the
  // iframe contents.
  const ownerPage =
    "screenshot" in scope && "mouse" in scope ? (scope as Page) : (scope as Frame).page();
  const buf = await ownerPage.screenshot({
    path: outPath,
    fullPage: true,
    animations: "disabled",
    caret: "hide",
    mask: opts.mask,
  });
  return buf;
}

/**
 * Take a screenshot of just the viewer-root region. Used as the
 * cross-platform Parity baseline (the same fixed input should produce the
 * same viewer pixels regardless of host UI chrome).
 */
export async function captureViewerRegion(scope: Page | Frame, outPath: string): Promise<Buffer> {
  if ("evaluate" in scope && typeof (scope as Page).screenshot === "function") {
    await stabilizeUi(scope as Page);
  }
  const target = scope.locator('[data-testid="viewer-root"]').first();
  const buf = await target.screenshot({
    path: outPath,
    animations: "disabled",
    caret: "hide",
  });
  return buf;
}

/**
 * Compare a freshly captured PNG against an on-disk baseline. On first run
 * the baseline is created. On size mismatch or pixel-diff exceeding
 * `maxDiffPercent`, a `.new.png` and `.diff.png` are written next to the
 * baseline and the function returns `ok: false` so callers can throw with a
 * test-aware message.
 */
export interface ComparisonResult {
  isNew: boolean;
  diffPixels: number;
  totalPixels: number;
  diffPercent: number;
  sizeMismatch?: boolean;
  ok: boolean;
}

export async function compareToBaseline(
  baselinePath: string,
  current: Buffer,
  opts: { maxDiffPercent?: number; threshold?: number } = {},
): Promise<ComparisonResult> {
  const maxDiff = opts.maxDiffPercent ?? DEFAULT_MAX_DIFF_PERCENT;
  const threshold = opts.threshold ?? PIXEL_THRESHOLD;

  mkdirSync(dirname(baselinePath), { recursive: true });

  if (!existsSync(baselinePath)) {
    // In CI check mode a missing baseline is a hard failure — silently
    // recording a fresh one would make any un-baselined capture pass.
    if (process.env.MEGANE_E2E_REQUIRE_BASELINE === "1") {
      writeFileSync(baselinePath.replace(/\.png$/, ".new.png"), current);
      return { isNew: true, diffPixels: 0, totalPixels: 0, diffPercent: 100, ok: false };
    }
    writeFileSync(baselinePath, current);
    return { isNew: true, diffPixels: 0, totalPixels: 0, diffPercent: 0, ok: true };
  }

  const { pixelmatch, PNG } = await loadPixelMatch();
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const cur = PNG.sync.read(current);

  if (baseline.width !== cur.width || baseline.height !== cur.height) {
    writeFileSync(baselinePath.replace(/\.png$/, ".new.png"), current);
    return {
      isNew: false,
      diffPixels: baseline.width * baseline.height,
      totalPixels: baseline.width * baseline.height,
      diffPercent: 100,
      sizeMismatch: true,
      ok: false,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const numDiff = pixelmatch(baseline.data, cur.data, diff.data, width, height, { threshold });
  const total = width * height;
  const diffPercent = (numDiff / total) * 100;

  if (diffPercent > maxDiff) {
    writeFileSync(baselinePath.replace(/\.png$/, ".diff.png"), PNG.sync.write(diff));
    writeFileSync(baselinePath.replace(/\.png$/, ".new.png"), current);
  }

  return {
    isNew: false,
    diffPixels: numDiff,
    totalPixels: total,
    diffPercent,
    ok: diffPercent <= maxDiff,
  };
}

/**
 * Convenience wrapper: capture full page and compare to baseline at
 * `<repoRoot>/tests/e2e/baselines/<platform>/<name>.png`.
 */
export async function expectFullPageMatch(
  scope: Page | Frame,
  platform: string,
  name: string,
  opts: { maxDiffPercent?: number; mask?: Locator[]; updateBaselines?: boolean } = {},
): Promise<void> {
  const baseline = baselinePath(platform, name);
  const shouldUpdate = opts.updateBaselines || process.env.MEGANE_E2E_UPDATE === "1";
  if (shouldUpdate && existsSync(baseline)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { unlinkSync } = await import("fs");
      unlinkSync(baseline);
    } catch {}
  }
  const tmp = baseline.replace(/\.png$/, ".current.png");
  const buf = await captureFullPage(scope, tmp, { mask: opts.mask });
  const r = await compareToBaseline(baseline, buf, { maxDiffPercent: opts.maxDiffPercent });
  expect(
    r.ok,
    r.isNew && !r.ok
      ? `${platform}/${name}: baseline missing under ${dirname(baseline)} (MEGANE_E2E_REQUIRE_BASELINE=1 — record it via the "E2E update baselines" workflow)`
      : r.sizeMismatch
        ? `${platform}/${name}: full-page size mismatch with baseline`
        : `${platform}/${name}: full-page diff ${r.diffPercent.toFixed(2)}% > ${opts.maxDiffPercent ?? DEFAULT_MAX_DIFF_PERCENT}%`,
  ).toBe(true);
}

/** Same as expectFullPageMatch but for the viewer-root rectangle only. */
export async function expectViewerRegionMatch(
  scope: Page | Frame,
  platform: string,
  name: string,
  opts: { maxDiffPercent?: number; updateBaselines?: boolean } = {},
): Promise<void> {
  const baseline = baselinePath(platform, name);
  const shouldUpdate = opts.updateBaselines || process.env.MEGANE_E2E_UPDATE === "1";
  if (shouldUpdate && existsSync(baseline)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { unlinkSync } = await import("fs");
      unlinkSync(baseline);
    } catch {}
  }
  const tmp = baseline.replace(/\.png$/, ".current.png");
  const buf = await captureViewerRegion(scope, tmp);
  const r = await compareToBaseline(baseline, buf, { maxDiffPercent: opts.maxDiffPercent });
  expect(
    r.ok,
    r.isNew && !r.ok
      ? `${platform}/${name}: baseline missing under ${dirname(baseline)} (MEGANE_E2E_REQUIRE_BASELINE=1 — record it via the "E2E update baselines" workflow)`
      : r.sizeMismatch
        ? `${platform}/${name}: viewer-region size mismatch`
        : `${platform}/${name}: viewer-region diff ${r.diffPercent.toFixed(2)}%`,
  ).toBe(true);
}

export function baselinePath(platform: string, name: string): string {
  const repo = repoRoot();
  // MEGANE_E2E_BASELINE_DIR switches the baseline root (repo-relative or
  // absolute). CI uses tests/e2e/baselines-ci, captured inside the pinned
  // Playwright container so fonts/Chromium match between record and compare;
  // the default tests/e2e/baselines set stays owned by the local dev flow.
  const override = process.env.MEGANE_E2E_BASELINE_DIR;
  const root = override
    ? isAbsolute(override)
      ? override
      : join(repo, override)
    : join(repo, "tests", "e2e", "baselines");
  return join(root, platform, `${name}.png`);
}

function repoRoot(): string {
  // tests/e2e/lib/setup.ts → repo root is three levels up.
  return join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
}

/* ─── Stabilization ────────────────────────────────────────────── */

/**
 * Reduce sources of pixel jitter before screenshotting. Per the plan, we do
 * NOT loosen pixel diff tolerance to hide flakiness — we mask it.
 *
 * Accepts a Page or Frame — for Frame inputs we resolve the parent Page
 * to drive the mouse, then run the evaluate within the Frame so the
 * stabilising stylesheet lands in the right document.
 */
export async function stabilizeUi(scope: Page | Frame): Promise<void> {
  const ownerPage = "mouse" in scope ? (scope as Page) : ((scope as Frame).page?.() ?? null);
  await ownerPage?.mouse.move(0, 0).catch(() => {});
  await scope
    .evaluate(() => {
      try {
        window.scrollTo(0, 0);
      } catch {}
      // Disable CSS animations/transitions globally
      const style = document.createElement("style");
      style.id = "megane-test-stabilize";
      style.textContent = `
        *, *::before, *::after {
          transition: none !important;
          animation: none !important;
          caret-color: transparent !important;
        }
        ::-webkit-scrollbar { display: none !important; }
        /*
         * JupyterLab host chrome that is not ours and does not hold still.
         * The file browser lists whatever the notebook dir accumulated from
         * earlier specs and dates it with a relative "2m ago" column, so a
         * full-page capture drifts with how much of the suite ran before it —
         * that alone is ~2% and flips these projects red in a full sweep
         * while they pass in a small one. visibility keeps the panel's box so
         * only the text drops out. Toasts are hidden outright as a belt to
         * JUPYTERLAB_SETTINGS_DIR's braces, since a baseline with one painted
         * in is worse than no baseline.
         */
        .jp-DirListing-content, .jp-FileBrowser-filterBox { visibility: hidden !important; }
        .jp-Notification-Toast, .Toastify, .Toastify__toast-container { display: none !important; }
      `;
      document.head.appendChild(style);
    })
    .catch(() => {});
}

/**
 * Pin the trajectory to a fixed frame so full-page / viewer captures are
 * deterministic. The webapp default (caffeine_water) carries a multi-frame
 * vibration trajectory whose frames are streamed lazily; depending on timing
 * the renderer can settle on frame 0 or frame 1 by screenshot time, which
 * across ~1000 vibrating waters is a multi-percent full-page diff (a source
 * of batch-vs-isolated flakiness). Seeking the timeline slider to a known
 * frame and waiting for `data-current-frame` removes that timing dependence.
 *
 * Host-tolerant: no-ops on hosts without a timeline slider (e.g. widget
 * shells), and the readback wait is best-effort.
 */
export async function pinFrame(scope: Page | Frame, frame = 0): Promise<void> {
  const seekbar = scope.locator('[data-testid="playback-seekbar"]');
  if ((await seekbar.count().catch(() => 0)) === 0) return;
  await seekbar
    .evaluate((el: HTMLInputElement, value: string) => {
      // Drive React's native value setter so the synthetic onChange fires
      // (a plain `el.value = ...` is shadowed by React's prop tracking).
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(frame))
    .catch(() => {});
  await scope
    .waitForFunction(
      (target: string) =>
        document
          .querySelector('[data-testid="megane-viewer"]')
          ?.getAttribute("data-current-frame") === target,
      String(frame),
      { timeout: 5_000 },
    )
    .catch(() => {});
  // The frame *counter* settling is not enough: lazily decoded trajectories
  // (the XTC worker path) apply the seeked frame's positions asynchronously
  // after the decode lands, so a capture can still race between the base
  // snapshot and the frame data. `framesApplied` is bumped by
  // MoleculeRenderer.updateFrame() in test mode; waiting for >= 1 guarantees
  // the displayed geometry is trajectory-frame data, whichever side of the
  // decode the capture would otherwise have landed on.
  await scope
    .waitForFunction(
      () => {
        const total = document
          .querySelector('[data-testid="megane-viewer"]')
          ?.getAttribute("data-total-frames");
        if (total === null || total === undefined || Number(total) <= 1) return true;
        const w = window as unknown as { __megane_test_ready?: { framesApplied?: number } };
        return (w.__megane_test_ready?.framesApplied ?? 0) >= 1;
      },
      null,
      { timeout: 15_000 },
    )
    .catch(() => {});

  // `framesApplied >= 1` still leaves one race open: the boot-time pipeline
  // executes more than once, and a late execution's loadSnapshot() (the
  // structure-file positions) can land AFTER the single frame application,
  // silently replacing the trajectory-frame geometry while every counter
  // still reads "frame 0" — the structure and trajectory frame 0 are
  // different coordinate sets (e.g. caffeine_water.pdb vs its XTC), so the
  // capture is bimodal. Force one more frame application now, via the
  // test-mode playback store, so the last geometry write before the capture
  // is deterministically the trajectory frame. Seek away and back in two
  // separate tasks — a same-task round trip can leave the store state
  // identical and never re-render.
  const framesAppliedBefore = await scope
    .evaluate((target: number) => {
      const w = window as unknown as {
        __megane_test_ready?: { framesApplied?: number };
        __megane_test_playback_store?: {
          getState: () => { totalFrames: number; seekFrame: (i: number) => void };
        };
      };
      const st = w.__megane_test_playback_store?.getState();
      if (!st || st.totalFrames <= 1) return null;
      const before = w.__megane_test_ready?.framesApplied ?? 0;
      st.seekFrame(target === 0 ? Math.min(1, st.totalFrames - 1) : 0);
      return before;
    }, frame)
    .catch(() => null);
  if (framesAppliedBefore !== null) {
    await scope
      .evaluate((target: number) => {
        const w = window as unknown as {
          __megane_test_playback_store?: {
            getState: () => { seekFrame: (i: number) => void };
          };
        };
        w.__megane_test_playback_store?.getState().seekFrame(target);
      }, frame)
      .catch(() => {});
    await scope
      .waitForFunction(
        (arg: { before: number; target: string }) => {
          const w = window as unknown as { __megane_test_ready?: { framesApplied?: number } };
          const atTarget =
            document
              .querySelector('[data-testid="megane-viewer"]')
              ?.getAttribute("data-current-frame") === arg.target;
          return atTarget && (w.__megane_test_ready?.framesApplied ?? 0) > arg.before;
        },
        { before: framesAppliedBefore, target: String(frame) },
        { timeout: 15_000 },
      )
      .catch(() => {});
  }
}

/* ─── Cross-platform Parity ─────────────────────────────────────── */

/**
 * Compare a captured viewer region against the contract baseline. Used by
 * `contract.spec.ts` to assert "viewer pixels are equivalent across all
 * platforms" — the assertion that catches "WebApp で動くものが Widget で動かない".
 */
export async function expectParityWithContract(
  scope: Page | Frame,
  contractName: string,
  opts: { maxDiffPercent?: number } = {},
): Promise<void> {
  // Slightly looser threshold than within-platform comparison: anti-aliasing
  // around shaded sphere/cylinder edges differs by a small amount across
  // host browsers (Chromium-in-VSCode vs Chromium-in-JupyterLab), and we
  // explicitly want regressions to be caught at the platform level too.
  const maxDiff = opts.maxDiffPercent ?? 4.0;
  const baseline = baselinePath("contract", contractName);
  const tmp = baseline.replace(/\.png$/, ".current.png");
  const buf = await captureViewerRegion(scope, tmp);
  const r = await compareToBaseline(baseline, buf, { maxDiffPercent: maxDiff });
  expect(
    r.ok,
    r.sizeMismatch
      ? `parity:${contractName} size mismatch (viewer-root rect differs)`
      : `parity:${contractName} viewer-region diff ${r.diffPercent.toFixed(2)}% > ${maxDiff}%`,
  ).toBe(true);
}
