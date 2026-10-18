/**
 * Trajectory-decode A/B profiler (XTC / LAMMPS dump), sibling of
 * profile-streaming.mjs for the structure path.
 *
 * Loads a structure first (so loadXtc has an atom count), then loads a
 * trajectory through the LoadTrajectory node input with lazy streaming FORCED
 * OFF (`__MEGANE_LAZY_XTC__=false`, eager: decode all frames) and ON (`=true`,
 * lazy: index + frame 0, stream the rest), and measures the wall-clock from
 * trajectory-drop to the pipeline's file-trajectory channel becoming live
 * (fileProvider for lazy / fileFrames for eager).
 *
 * NOTE: unoptimized local wasm inflates absolute numbers; the eager-vs-lazy
 * relative A/B on the same .wasm is valid.
 *
 * Usage: node scripts/profile-trajectory.mjs
 *   env STRUCT_FIXTURE / TRAJ_FIXTURE override the defaults.
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

const RUNS = Number(process.env.RUNS ?? 1);
const LOAD_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 200000);
const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const STRUCT = process.env.STRUCT_FIXTURE ?? join(FIXTURES, "caffeine_water.pdb");
const TRAJ = process.env.TRAJ_FIXTURE ?? join(FIXTURES, "caffeine_water_vibration.xtc");

function median(arr) {
  const a = arr.filter((v) => v !== null && v !== undefined).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

async function measureOnce(context, server, lazy) {
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
  try {
    await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page
      .waitForFunction(() => window.__meganeRendererReady === true, null, { timeout: 30000 })
      .catch(() => {});
    await waitForCanvasNonEmpty(page, "canvas", { timeout: 30000, interval: 100 });

    // 1. Load the structure so loadXtc knows the atom count. Wait for the loader
    //    node's snapshot to appear (applyResult has set baseSnapshotRef by then).
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
    await page.waitForTimeout(500); // let the legacy load path settle (baseSnapshotRef)

    // 2. Force lazy on/off and baseline the file-trajectory channel.
    await page.evaluate((isLazy) => {
      window.__MEGANE_LAZY_XTC__ = isLazy;
      const s = window.__megane_test_pipeline_store.getState();
      window.__baseFp = s.fileProvider;
      window.__baseFf = s.fileFrames;
      performance.clearMeasures();
    }, lazy);

    // 3. Load the trajectory and time until the file-trajectory channel goes live.
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

    const info = await page.evaluate(() => {
      const s = window.__megane_test_pipeline_store.getState();
      return { hasProvider: !!s.fileProvider, nFrames: s.fileProvider?.meta?.nFrames ?? null };
    });
    const perf = await collectPerf(page);
    const parseSumMs = perf.measures
      .filter((m) => m.name.startsWith("megane:parse:"))
      .reduce((s, m) => s + m.duration, 0);

    await page.evaluate(() => window.__megane_test_pipeline_store?.getState?.().reset?.());
    return { wallMs, parseSumMs, hasProvider: info.hasProvider, nFrames: info.nFrames };
  } finally {
    await page.close().catch(() => {});
  }
}

let server = null;
let browser = null;
try {
  console.log("[trajectory] starting Vite dev server...");
  server = await startViteServer();
  const chromium = getChromium();
  browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    window.__MEGANE_TEST__ = true;
  });
  await setupPerfHooks(context);

  const out = {};
  for (const mode of ["eager", "lazy"]) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(context, server, mode === "lazy"));
    out[mode] = {
      wallMs: median(runs.map((r) => r.wallMs)),
      parseSumMs: median(runs.map((r) => r.parseSumMs)),
      hasProvider: runs[runs.length - 1].hasProvider,
      nFrames: runs[runs.length - 1].nFrames,
    };
  }
  const speedup =
    out.eager.wallMs && out.lazy.wallMs ? (out.eager.wallMs / out.lazy.wallMs).toFixed(1) : "?";
  console.log(
    `\n[trajectory] ${TRAJ.split("/").pop()}` +
      `\n  eager: wall=${out.eager.wallMs}ms  parseSum=${out.eager.parseSumMs?.toFixed(0)}ms` +
      `\n  lazy : wall=${out.lazy.wallMs}ms  parseSum=${out.lazy.parseSumMs?.toFixed(0)}ms  provider=${out.lazy.hasProvider} nFrames=${out.lazy.nFrames}` +
      `\n  => first-paint ${out.eager.wallMs - out.lazy.wallMs}ms faster (${speedup}x)`,
  );
  console.log(`\n[trajectory] JSON: ${JSON.stringify(out)}`);
} catch (err) {
  console.error("[trajectory] fatal:", err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
}
