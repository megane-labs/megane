/**
 * Two-phase-vs-single-read A/B profiler for the lazy trajectory path.
 *
 * Both arms run with lazy streaming ON (`__MEGANE_LAZY_XTC__=true`); the only
 * difference is the phase-1 partial read:
 *   - "single" : `__MEGANE_TRAJ_FRAME0__=false` → loadXtc reads the WHOLE file,
 *     scans the index, THEN shows frame 0 (the pre-two-phase behaviour).
 *   - "twophase": phase 1 decodes ONLY frame 0 from a bounded prefix and shows
 *     it immediately; the full index + streaming provider attach in the
 *     background.
 * Measures the wall-clock from trajectory-drop to the file-trajectory channel
 * going live (fileFrames OR fileProvider changes) — i.e. time-to-interactive.
 *
 * NOTE: unoptimized local wasm inflates absolute numbers; the same-.wasm A/B
 * (single vs twophase) is valid. See AGENTS.md rule #10.
 *
 * Usage: node scripts/profile-trajectory-frame0.mjs
 *   env STRUCT_FIXTURE / TRAJ_FIXTURE override the defaults; RUNS sets repeats.
 *   The defaults (tests/fixtures/caffeine_water.pdb + caffeine_water_vibration.xtc)
 *   only smoke-test the harness: the win shows up on multi-MB trajectories, so
 *   point TRAJ_FIXTURE at a large XTC / LAMMPS dump whose atom count matches
 *   STRUCT_FIXTURE for a real measurement.
 */

import { join } from "path";
import {
  REPO_ROOT,
  getChromium,
  startViteServer,
  setupPerfHooks,
  collectPerf,
  waitForCanvasNonEmpty,
} from "../tests/e2e/utils/playwright.mjs";

const RUNS = Number(process.env.RUNS ?? 3);
const LOAD_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 200000);
const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const STRUCT = process.env.STRUCT_FIXTURE ?? join(FIXTURES, "caffeine_water.pdb");
const TRAJ = process.env.TRAJ_FIXTURE ?? join(FIXTURES, "caffeine_water_vibration.xtc");

function median(arr) {
  const a = arr.filter((v) => v !== null && v !== undefined).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

async function measureOnce(context, server, twophase) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  try {
    await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page
      .waitForFunction(() => window.__meganeRendererReady === true, null, { timeout: 30000 })
      .catch(() => {});
    await waitForCanvasNonEmpty(page, "canvas", { timeout: 30000, interval: 100 });

    const loaderId = await page.evaluate(
      () =>
        window.__megane_test_pipeline_store
          .getState()
          .nodes.find((n) => n.type === "load_structure")?.id,
    );
    const structInput = page.locator('[data-testid="load-structure-input"]').first();
    await structInput.waitFor({ state: "attached", timeout: 5000 });
    await structInput.setInputFiles(STRUCT);
    await page.waitForFunction(
      (id) => !!window.__megane_test_pipeline_store.getState().nodeSnapshots[id]?.snapshot,
      loaderId,
      { timeout: 60000, polling: 30 },
    );
    await page.waitForTimeout(500);

    // Lazy always on; toggle the phase-1 partial read. Baseline the channel.
    await page.evaluate((tp) => {
      window.__MEGANE_LAZY_XTC__ = true;
      window.__MEGANE_TRAJ_FRAME0__ = tp; // false → single full read (old path)
      const s = window.__megane_test_pipeline_store.getState();
      window.__baseFp = s.fileProvider;
      window.__baseFf = s.fileFrames;
      performance.clearMeasures();
    }, twophase);

    const trajInput = page.locator('[data-testid="load-trajectory-input"]').first();
    await trajInput.waitFor({ state: "attached", timeout: 5000 });
    const t0 = Date.now();
    await trajInput.setInputFiles(TRAJ);
    await page.waitForFunction(
      () => {
        const s = window.__megane_test_pipeline_store.getState();
        return s.fileProvider !== window.__baseFp || s.fileFrames !== window.__baseFf;
      },
      null,
      { timeout: LOAD_TIMEOUT_MS, polling: 20 },
    );
    const wallMs = Date.now() - t0;

    const perf = await collectPerf(page);
    const parseSumMs = perf.measures
      .filter((m) => m.name.startsWith("megane:parse:"))
      .reduce((s, m) => s + m.duration, 0);

    await page.evaluate(() => window.__megane_test_pipeline_store?.getState?.().reset?.());
    return { wallMs, parseSumMs };
  } finally {
    await page.close().catch(() => {});
  }
}

let server = null;
let browser = null;
try {
  console.log("[traj-frame0] starting Vite dev server...");
  server = await startViteServer();
  const chromium = getChromium();
  browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    window.__MEGANE_TEST__ = true;
  });
  await setupPerfHooks(context);

  const out = {};
  for (const mode of ["single", "twophase"]) {
    const runs = [];
    for (let i = 0; i < RUNS; i++)
      runs.push(await measureOnce(context, server, mode === "twophase"));
    out[mode] = {
      wallMs: median(runs.map((r) => r.wallMs)),
      parseSumMs: median(runs.map((r) => r.parseSumMs)),
    };
  }
  const speedup =
    out.single.wallMs && out.twophase.wallMs
      ? (out.single.wallMs / out.twophase.wallMs).toFixed(1)
      : "?";
  console.log(
    `\n[traj-frame0] ${TRAJ.split("/").pop()}` +
      `\n  single-read: wall=${out.single.wallMs}ms  parseSum=${out.single.parseSumMs?.toFixed(0)}ms` +
      `\n  two-phase  : wall=${out.twophase.wallMs}ms  parseSum=${out.twophase.parseSumMs?.toFixed(0)}ms` +
      `\n  => time-to-interactive ${out.single.wallMs - out.twophase.wallMs}ms faster (${speedup}x)`,
  );
  console.log(`\n[traj-frame0] JSON: ${JSON.stringify(out)}`);
} catch (err) {
  console.error("[traj-frame0] fatal:", err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
