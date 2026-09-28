/**
 * Startup-time and memory profiler for the production webapp build.
 *
 * Serves one or more built app directories (default: the `npm run build:app`
 * output in python/megane/static/app) from a small gzip-capable static server,
 * opens each in a fresh headless Chromium, and records per run:
 *
 *   - visibleMs  : navigation start -> first frame drawn with the startup demo
 *                  structure loaded (`__megane_test_ready.firstFrame`)
 *   - settledMs  : navigation start -> demo trajectory loaded (totalFrames > 1)
 *   - scriptMs   : main-thread script execution time up to `visible`
 *                  (CDP Performance.getMetrics ScriptDuration)
 *   - bytes      : bytes the server sent until settled, split into JS / WASM /
 *                  CSS / other (post-compression when --gzip is on)
 *   - heapMB     : main-isolate JS heap used after a forced GC
 *   - rendererMB / gpuMB / totalMB : proportional set size (PSS) of the page's
 *                  renderer process, the GPU process, and the whole browser
 *                  process tree, read from /proc (Linux only)
 *
 * With `--file <path>`, once the startup demo has settled the file is opened
 * through the Load Structure node and the run also records how long it took to
 * show (fileLoadMs), how long the main thread was blocked meanwhile
 * (fileBlockingMs: the long-task time past 50 ms, as in Total Blocking Time)
 * and the longest single main-thread task; the memory figures are then taken
 * with that file loaded.
 *
 * Runs are interleaved across the labelled builds (A, B, A, B, ...) so drift in
 * the machine's load affects every build equally, and the medians are printed
 * as a Markdown table ready to paste into a PR description.
 *
 * Usage:
 *   node scripts/profile-startup.mjs                         # current build
 *   node scripts/profile-startup.mjs base=/tmp/base head=python/megane/static/app
 *   node scripts/profile-startup.mjs --runs 7 --throttle 4g --cpu 4 ...
 *
 * Options:
 *   --runs N        runs per build (default 5)
 *   --throttle P    network profile: none (default), 4g, 3g
 *   --cpu N         CPU throttling rate (default 1 = none)
 *   --no-gzip       serve uncompressed (default gzips text + wasm, like a CDN)
 *   --path P        page path to open (default "/?test=1")
 *   --file F        after startup, open F via the Load Structure node
 *   --settle MS     idle time before the memory is read (default 1500); the
 *                   parse worker is released after 10 s idle, so use ~12000 to
 *                   see steady-state memory
 *   --dpr N         device pixel ratio (default 1). Headless Chromium renders
 *                   WebGL in software (SwiftShader), so every frame costs CPU;
 *                   a ratio like 0.25 shrinks the drawing buffer (the layout is
 *                   unchanged) so the render loop cannot dominate load timings
 */

import { createServer } from "http";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { extname, join, normalize, resolve } from "path";
import { gzipSync } from "zlib";
import { REPO_ROOT, getChromium } from "../tests/e2e/utils/playwright.mjs";

// ---- CLI ----

const argv = process.argv.slice(2);
const opts = {
  runs: 5,
  throttle: "none",
  cpu: 1,
  gzip: true,
  path: "/?test=1",
  file: null,
  dpr: 1,
  settle: 1500,
};
const builds = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--runs") opts.runs = Number(argv[++i]);
  else if (a === "--throttle") opts.throttle = argv[++i];
  else if (a === "--cpu") opts.cpu = Number(argv[++i]);
  else if (a === "--no-gzip") opts.gzip = false;
  else if (a === "--path") opts.path = argv[++i];
  else if (a === "--file") opts.file = resolve(argv[++i]);
  else if (a === "--dpr") opts.dpr = Number(argv[++i]);
  else if (a === "--settle") opts.settle = Number(argv[++i]);
  else if (a.includes("=")) {
    const [label, dir] = a.split("=");
    builds.push({ label, dir: resolve(dir) });
  } else builds.push({ label: a, dir: resolve(a) });
}
if (builds.length === 0) {
  builds.push({ label: "current", dir: join(REPO_ROOT, "python", "megane", "static", "app") });
}
for (const b of builds) {
  if (!existsSync(join(b.dir, "index.html"))) {
    console.error(`No index.html in ${b.dir} (run \`npm run build:app\` first).`);
    process.exit(1);
  }
}

// Chrome DevTools presets (bytes/s and ms).
const NETWORK_PROFILES = {
  none: null,
  "4g": { latency: 20, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: 1.5e6 / 8 },
  "3g": { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: 750e3 / 8 },
};
if (!(opts.throttle in NETWORK_PROFILES)) {
  console.error(`Unknown --throttle ${opts.throttle}; use none, 4g or 3g.`);
  process.exit(1);
}

// ---- Static server ----

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".wasm", ".svg"]);

function category(ext) {
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".wasm") return "wasm";
  if (ext === ".css") return "css";
  return "other";
}

/** Serve `dir`; `counter` accumulates the bytes actually written per category. */
function startStaticServer(dir, counter) {
  const gzCache = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(dir, rel));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const ext = extname(file);
    const headers = { "Content-Type": MIME[ext] ?? "application/octet-stream" };
    headers["Cache-Control"] = "no-store";
    const cat = category(ext);
    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    if (opts.gzip && acceptsGzip && COMPRESSIBLE.has(ext)) {
      let body = gzCache.get(file);
      if (!body) {
        body = gzipSync(readFileSync(file), { level: 6 });
        gzCache.set(file, body);
      }
      headers["Content-Encoding"] = "gzip";
      headers["Content-Length"] = body.length;
      res.writeHead(200, headers).end(body);
      counter[cat] += body.length;
      return;
    }
    const size = statSync(file).size;
    headers["Content-Length"] = size;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
    counter[cat] += size;
  });
  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

// ---- /proc process-tree memory (Linux) ----

function readProcTree(rootPid) {
  const parent = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // Field 4 (ppid) follows the parenthesised command name, which may hold spaces.
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent.set(Number(name), Number(after[1]));
    } catch {
      /* process exited */
    }
  }
  const tree = [rootPid];
  for (let i = 0; i < tree.length; i++) {
    for (const [pid, ppid] of parent) if (ppid === tree[i]) tree.push(pid);
  }
  return tree;
}

function pssKb(pid) {
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function processType(pid) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const m = /--type=([a-z-]+)/.exec(cmd);
    if (!m) return "browser";
    if (m[1] === "renderer" && cmd.includes("--extension-process")) return "extension";
    return m[1];
  } catch {
    return "gone";
  }
}

/**
 * PSS in MB of the renderer, the GPU process and the whole browser tree.
 * Playwright spawns Chromium as a child of this Node process (and this script
 * starts no other children), so every descendant is part of the browser.
 */
function processMemory() {
  const out = { rendererMB: 0, gpuMB: 0, totalMB: 0 };
  if (!existsSync("/proc/self/smaps_rollup")) return null;
  for (const pid of readProcTree(process.pid)) {
    if (pid === process.pid) continue;
    const kb = pssKb(pid);
    const type = processType(pid);
    out.totalMB += kb / 1024;
    // With one page open there is exactly one renderer.
    if (type === "renderer") out.rendererMB += kb / 1024;
    else if (type === "gpu-process") out.gpuMB += kb / 1024;
  }
  return out;
}

// ---- One measured page load ----

async function measureOnce(build) {
  const counter = { js: 0, wasm: 0, css: 0, other: 0 };
  const server = await startStaticServer(build.dir, counter);
  const port = server.address().port;
  const chromium = getChromium();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=swiftshader", "--enable-precise-memory-info"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: opts.dpr,
    });
    // Turn on the `megane:*` perf marks (src/perf.ts) for the per-phase table,
    // and record main-thread long tasks for the --file scenario.
    await context.addInitScript(() => {
      window.__MEGANE_PERF__ = true;
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longTasks.push({ start: e.startTime, duration: e.duration });
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {
        /* longtask timing unsupported */
      }
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const net = NETWORK_PROFILES[opts.throttle];
    if (net) {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...net });
    }
    if (opts.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpu });

    await page.goto(`http://127.0.0.1:${port}${opts.path}`, { waitUntil: "commit" });
    const visibleMs = await page
      .waitForFunction(
        () =>
          window.__megane_test_ready && window.__megane_test_ready.firstFrame
            ? performance.now()
            : false,
        null,
        { polling: "raf", timeout: 120000 },
      )
      .then((h) => h.jsonValue());
    const metricsAtVisible = await cdp.send("Performance.getMetrics");
    const scriptMs =
      1000 * (metricsAtVisible.metrics.find((m) => m.name === "ScriptDuration")?.value ?? 0);

    const settledMs = await page
      .waitForFunction(
        () => {
          const s = window.__megane_test_playback_store;
          return s && s.getState().totalFrames > 1 ? performance.now() : false;
        },
        null,
        { polling: 50, timeout: 120000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);

    const file = opts.file ? await openFile(page) : null;

    // Let deferred work (idle callbacks, worker warm-up) finish, then GC so the
    // heap figure is live data rather than garbage awaiting collection.
    await page.waitForTimeout(opts.settle);
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(250);
    const metrics = await cdp.send("Performance.getMetrics");
    const heapUsed = metrics.metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
    const perf = await page.evaluate(() =>
      performance
        .getEntriesByType("measure")
        .filter((m) => m.name.startsWith("megane:"))
        // Per-file parse measures carry a Date.now() suffix; drop it so runs line up.
        .map((m) => ({ name: m.name.replace(/-\d{10,}$/, ""), duration: m.duration })),
    );
    const mem = processMemory();
    const bytes = { ...counter, total: counter.js + counter.wasm + counter.css + counter.other };
    return {
      visibleMs,
      settledMs,
      scriptMs,
      ...file,
      heapMB: heapUsed / 1024 / 1024,
      ...mem,
      bytes,
      perf,
      errors,
    };
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

/**
 * Open `opts.file` through the Load Structure node and time it: until the
 * loader node's snapshot changes (the file is on screen), plus the main-thread
 * long tasks from the upload until two seconds after it is shown.
 */
async function openFile(page) {
  await page.waitForTimeout(1000);
  const ready = await page.evaluate(() => {
    const store = window.__megane_test_pipeline_store;
    const loader = store?.getState().nodes.find((n) => n.type === "load_structure");
    if (!loader) return false;
    window.__loaderId = loader.id;
    window.__baseSnap = store.getState().nodeSnapshots[loader.id]?.snapshot ?? null;
    return true;
  });
  if (!ready) throw new Error("no load_structure node / test store on the page");
  const input = page.locator('[data-testid="load-structure-input"]').first();
  const t0 = await page.evaluate(() => performance.now());
  await input.setInputFiles(opts.file);
  const shownAt = await page
    .waitForFunction(
      () => {
        const snap =
          window.__megane_test_pipeline_store.getState().nodeSnapshots[window.__loaderId]?.snapshot;
        return snap && snap !== window.__baseSnap ? performance.now() : false;
      },
      null,
      { polling: 20, timeout: 300000 },
    )
    .then((h) => h.jsonValue());
  await page.waitForTimeout(2000);
  const tasks = await page.evaluate(
    (from) => window.__longTasks.filter((t) => t.start >= from),
    t0,
  );
  return {
    fileLoadMs: shownAt - t0,
    fileBlockingMs: tasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
    fileLongestTaskMs: tasks.reduce((max, t) => Math.max(max, t.duration), 0),
  };
}

// ---- Driver ----

function median(values) {
  const a = values.filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const results = new Map(builds.map((b) => [b.label, []]));
console.log(
  `profile-startup: ${opts.runs} run(s) x ${builds.length} build(s), throttle=${opts.throttle}, ` +
    `cpu=${opts.cpu}x, gzip=${opts.gzip}, path=${opts.path}, ` +
    `dpr=${opts.dpr}, settle=${opts.settle}ms`,
);
for (let run = 0; run < opts.runs; run++) {
  for (const b of builds) {
    const r = await measureOnce(b);
    results.get(b.label).push(r);
    console.log(
      `  [${b.label}] run ${run + 1}: visible=${r.visibleMs?.toFixed(0)}ms ` +
        `settled=${r.settledMs?.toFixed(0)}ms script=${r.scriptMs.toFixed(0)}ms ` +
        `bytes=${(r.bytes.total / 1024).toFixed(0)}KB heap=${r.heapMB.toFixed(1)}MB ` +
        `renderer=${r.rendererMB?.toFixed(1)}MB gpu=${r.gpuMB?.toFixed(1)}MB ` +
        `total=${r.totalMB?.toFixed(1)}MB` +
        (opts.file
          ? ` file=${r.fileLoadMs?.toFixed(0)}ms blocking=${r.fileBlockingMs?.toFixed(0)}ms ` +
            `longest=${r.fileLongestTaskMs?.toFixed(0)}ms`
          : "") +
        (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ""),
    );
  }
}

const rows = [
  ["Time to structure visible (ms)", (r) => r.visibleMs, 0],
  ["Time to trajectory loaded (ms)", (r) => r.settledMs, 0],
  ...(opts.file
    ? [
        ["File: time until shown (ms)", (r) => r.fileLoadMs, 0],
        ["File: main-thread blocking (ms)", (r) => r.fileBlockingMs, 0],
        ["File: longest main-thread task (ms)", (r) => r.fileLongestTaskMs, 0],
      ]
    : []),
  ["Main-thread script until visible (ms)", (r) => r.scriptMs, 0],
  ["Transferred: JS (KB)", (r) => r.bytes.js / 1024, 0],
  ["Transferred: WASM (KB)", (r) => r.bytes.wasm / 1024, 0],
  ["Transferred: CSS (KB)", (r) => r.bytes.css / 1024, 0],
  ["Transferred: other (KB)", (r) => r.bytes.other / 1024, 0],
  ["Transferred: total (KB)", (r) => r.bytes.total / 1024, 0],
  ["JS heap used after GC (MB)", (r) => r.heapMB, 1],
  ["Renderer process PSS (MB)", (r) => r.rendererMB, 1],
  ["GPU process PSS (MB)", (r) => r.gpuMB, 1],
  ["Browser tree PSS (MB)", (r) => r.totalMB, 1],
];
const labels = builds.map((b) => b.label);
const lines = [];
lines.push(`| Metric (median of ${opts.runs}) | ${labels.join(" | ")} |`);
lines.push(`|---|${labels.map(() => "---:").join("|")}|`);
for (const [name, pick, digits] of rows) {
  const cells = labels.map((l) => {
    const m = median(results.get(l).map(pick));
    return m === null ? "n/a" : m.toFixed(digits);
  });
  lines.push(`| ${name} | ${cells.join(" | ")} |`);
}
console.log(`\n${lines.join("\n")}\n`);

const perfNames = new Set();
for (const l of labels)
  for (const r of results.get(l)) for (const p of r.perf) perfNames.add(p.name);
if (perfNames.size) {
  console.log(`| megane:* measure (median ms) | ${labels.join(" | ")} |`);
  console.log(`|---|${labels.map(() => "---:").join("|")}|`);
  for (const name of [...perfNames].sort()) {
    const cells = labels.map((l) => {
      const m = median(
        results
          .get(l)
          .map((r) => r.perf.filter((p) => p.name === name).reduce((s, p) => s + p.duration, 0)),
      );
      return m === null ? "n/a" : m.toFixed(1);
    });
    console.log(`| ${name} | ${cells.join(" | ")} |`);
  }
}
console.log(`\nJSON: ${JSON.stringify(Object.fromEntries(results))}`);
