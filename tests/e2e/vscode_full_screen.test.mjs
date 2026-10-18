/**
 * Full-screen E2E test for the megane VS Code extension.
 *
 * Builds the VSIX from the local source tree, installs it into code-server,
 * opens each supported file format, and captures the entire VS Code screen
 * (workbench + editor + activity bar + side bar + status bar + custom-editor
 * webview) at multiple stages of the user workflow.
 *
 * For each captured frame we either:
 *   - Save it as a new baseline (--update mode), OR
 *   - Compare it against the existing baseline with pixelmatch and fail if
 *     the diff exceeds MAX_DIFF_PERCENT.
 *
 * Coverage:
 *   - PDB (water_wrapped.pdb)
 *   - GRO (water.gro)
 *   - XYZ (perovskite_srtio3.xyz)
 *   - MOL (methane.mol)
 *   - SDF (ethanol.sdf)
 *   - megane pipeline JSON (water.megane.json + water_wrapped.pdb)
 *
 * Stages captured per format:
 *   1. workbench-loaded   — VS Code UI ready, before any file is opened
 *   2. file-opened        — Custom editor visible, before WebGL render settles
 *   3. viewer-rendered    — After waiting for the megane viewer to render
 *
 * Usage:
 *   node tests/e2e/vscode_full_screen.test.mjs [--update] [--keep] [--format <id>]
 *
 * Flags:
 *   --update           Re-generate baseline screenshots
 *   --keep             Keep code-server running on exit (debug)
 *   --format <id>      Only run the format with the given id
 *   --vsix <path>      Use a pre-built VSIX instead of rebuilding
 *
 * Requirements:
 *   - code-server in PATH
 *   - Playwright (resolved by tests/e2e/utils/playwright.mjs: project
 *     node_modules first, then the global install)
 *   - WASM and webview already built (npm run build:wasm + vscode-megane build)
 *   - pixelmatch + pngjs in node_modules
 */

import { spawn, execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getChromium } from "./utils/playwright.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures");
const SNAPSHOTS_DIR = join(__dirname, "snapshots", "vscode");
const DIFF_DIR = join(__dirname, "diffs", "vscode");
const SCREENSHOT_DIR = join(__dirname, "screenshots", "vscode");

// Resolve Playwright via the shared helper (project node_modules first, then
// the global install) instead of duplicating the createRequire block.
const chromium = getChromium();

// Resolve pixelmatch + pngjs from project node_modules
const { default: pixelmatch } = await import(
  join(REPO_ROOT, "node_modules", "pixelmatch", "index.js")
);
const { PNG } = await import(join(REPO_ROOT, "node_modules", "pngjs", "lib", "png.js"));

// ─── Config ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const UPDATE_MODE = args.includes("--update");
const KEEP_SERVER = args.includes("--keep");
const FORMAT_FILTER = (() => {
  const i = args.indexOf("--format");
  return i >= 0 ? args[i + 1] : null;
})();
const VSIX_OVERRIDE = (() => {
  const i = args.indexOf("--vsix");
  return i >= 0 ? args[i + 1] : null;
})();

const PORT = 38000 + Math.floor(Math.random() * 1000);
const VIEWPORT = { width: 1280, height: 800 };

// pixelmatch sensitivity
const PIXEL_THRESHOLD = 0.2;
// Per-frame max diff percent. WebGL output is non-deterministic so we are
// generous on stages where the canvas is rendered.
const MAX_DIFF_PERCENT = {
  "workbench-loaded": 1.0,
  "file-opened": 5.0,
  "viewer-rendered": 8.0,
};

const FORMATS = [
  {
    id: "pdb",
    fixtures: ["water_wrapped.pdb"],
    open: "water_wrapped.pdb",
    label: "PDB",
    expectsCanvas: true,
  },
  {
    id: "gro",
    fixtures: ["water.gro"],
    open: "water.gro",
    label: "GRO",
    expectsCanvas: true,
  },
  {
    id: "xyz",
    fixtures: ["perovskite_srtio3.xyz"],
    open: "perovskite_srtio3.xyz",
    label: "XYZ",
    expectsCanvas: true,
  },
  {
    id: "mol",
    fixtures: ["methane.mol"],
    open: "methane.mol",
    label: "MOL",
    expectsCanvas: true,
  },
  {
    id: "sdf",
    fixtures: ["ethanol.sdf"],
    open: "ethanol.sdf",
    label: "SDF",
    expectsCanvas: true,
  },
  {
    // Pipeline viewer activates the custom editor but does not render a 3D
    // canvas until the user clicks "Render". We verify the pipeline editor
    // shell loaded via baseline image diff only.
    id: "pipeline",
    fixtures: ["water.megane.json", "water_wrapped.pdb"],
    open: "water.megane.json",
    label: "Pipeline (.megane.json)",
    expectsCanvas: false,
  },
];

// ─── Result tracking ─────────────────────────────────────────────────────

const results = [];

function recordPass(name) {
  results.push({ name, status: "PASS" });
  console.log(`PASS: ${name}`);
}

function recordFail(name, detail) {
  results.push({ name, status: "FAIL", detail });
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

// ─── VSIX preparation ────────────────────────────────────────────────────

function buildVsix() {
  if (VSIX_OVERRIDE) {
    if (!existsSync(VSIX_OVERRIDE)) {
      throw new Error(`VSIX override not found: ${VSIX_OVERRIDE}`);
    }
    console.log(`Using override VSIX: ${VSIX_OVERRIDE}`);
    return VSIX_OVERRIDE;
  }

  const vsixPath = join(tmpdir(), `vscode-megane-e2e-${process.pid}.vsix`);
  if (existsSync(vsixPath)) rmSync(vsixPath);

  const extDir = join(REPO_ROOT, "vscode-megane");
  console.log("Building VSCode extension webview + sources...");
  execFileSync("npm", ["run", "build"], { cwd: extDir, stdio: "inherit" });

  console.log("Packaging VSIX with vsce...");
  execFileSync("npx", ["vsce", "package", "--out", vsixPath], {
    cwd: extDir,
    stdio: "inherit",
  });

  console.log(`VSIX built: ${vsixPath}`);
  return vsixPath;
}

function installVsix(vsixPath, userDataDir, extensionsDir) {
  console.log(`Installing extension into isolated code-server profile...`);
  execFileSync(
    "code-server",
    [
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      "--install-extension",
      vsixPath,
    ],
    { stdio: "inherit" },
  );
}

// ─── Workspace and code-server lifecycle ─────────────────────────────────

function setupWorkspace(formats) {
  const workspace = mkdtempSync(join(tmpdir(), "megane-vscode-e2e-"));
  // Copy every fixture referenced by the formats we will run.
  const needed = new Set();
  for (const fmt of formats) {
    for (const f of fmt.fixtures) needed.add(f);
  }
  for (const name of needed) {
    cpSync(join(FIXTURES_DIR, name), join(workspace, name));
  }
  console.log(`Workspace: ${workspace} (${needed.size} fixture(s))`);
  return workspace;
}

function startCodeServer(workspace, userDataDir, extensionsDir) {
  return new Promise((resolveStart, rejectStart) => {
    const proc = spawn(
      "code-server",
      [
        "--auth",
        "none",
        "--bind-addr",
        `127.0.0.1:${PORT}`,
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--disable-telemetry",
        "--disable-update-check",
        "--disable-workspace-trust",
        workspace,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: process.env.HOME ?? "/root" },
      },
    );

    const timer = setTimeout(
      () => rejectStart(new Error("code-server did not start within 30s")),
      30000,
    );

    const onLine = (data) => {
      const line = data.toString();
      process.stdout.write(`[code-server] ${line}`);
      if (line.includes("HTTP server listening") || line.includes(`127.0.0.1:${PORT}`)) {
        clearTimeout(timer);
        resolveStart(proc);
      }
    };

    proc.stdout.on("data", onLine);
    proc.stderr.on("data", onLine);
    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectStart(err);
    });
  });
}

// ─── Snapshot comparison ─────────────────────────────────────────────────

function compareToBaseline(label, actualBuf) {
  const baselinePath = join(SNAPSHOTS_DIR, `${label}.png`);
  const actualPath = join(SCREENSHOT_DIR, `${label}.png`);
  const diffPath = join(DIFF_DIR, `${label}.diff.png`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  writeFileSync(actualPath, actualBuf);

  if (UPDATE_MODE) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    writeFileSync(baselinePath, actualBuf);
    console.log(`  baseline updated: ${baselinePath}`);
    return { ok: true, updated: true };
  }

  if (!existsSync(baselinePath)) {
    return {
      ok: false,
      reason: `baseline missing (${baselinePath}); run with --update`,
    };
  }

  const actual = PNG.sync.read(actualBuf);
  const baseline = PNG.sync.read(readFileSync(baselinePath));

  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      ok: false,
      reason: `size mismatch: actual ${actual.width}x${actual.height} vs baseline ${baseline.width}x${baseline.height}`,
    };
  }

  const diff = new PNG({ width: actual.width, height: actual.height });
  const diffPixels = pixelmatch(
    actual.data,
    baseline.data,
    diff.data,
    actual.width,
    actual.height,
    { threshold: PIXEL_THRESHOLD },
  );
  const totalPixels = actual.width * actual.height;
  const pct = (diffPixels / totalPixels) * 100;

  // Determine threshold by stage suffix
  const stage = label.split("--").pop();
  const allowed = MAX_DIFF_PERCENT[stage] ?? 5.0;

  if (pct > allowed) {
    mkdirSync(DIFF_DIR, { recursive: true });
    writeFileSync(diffPath, PNG.sync.write(diff));
    return {
      ok: false,
      reason: `${pct.toFixed(3)}% diff exceeds ${allowed}% (diff: ${diffPath})`,
      diffPct: pct,
    };
  }

  return { ok: true, diffPct: pct };
}

// ─── Page interaction helpers ────────────────────────────────────────────

async function dismissOverlays(page) {
  // Workspace trust prompt (if it survived --disable-workspace-trust)
  try {
    const btn = page.getByRole("button", { name: /trust the authors|yes, i trust/i });
    await btn.waitFor({ timeout: 1500 });
    await btn.click();
    await page.waitForTimeout(500);
  } catch {
    // not present
  }
  // Close getting-started or release notes tabs if any
  try {
    const closeBtns = page.locator(".tab.active .codicon-close").first();
    if (await closeBtns.isVisible({ timeout: 500 })) {
      // do not close — we want to capture the natural workbench state
    }
  } catch {
    // ignore
  }
}

async function openFileViaQuickOpen(page, fileName) {
  await page.keyboard.press("Control+P");
  await page.waitForTimeout(400);
  await page.keyboard.type(fileName, { delay: 20 });
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
}

async function waitForCanvasInWebview(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const canvas = await frame.$("canvas");
        if (canvas) {
          const rendered = await frame.evaluate(() => {
            const c = document.querySelector("canvas");
            if (!c) return false;
            const gl = c.getContext("webgl2") || c.getContext("webgl");
            if (!gl) return false;
            const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
            if (w < 16 || h < 16) return false;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let nonBg = 0;
            for (let i = 0; i < px.length; i += 4) {
              // background is white-ish; count any pixel that is not near-white
              if (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245) nonBg++;
            }
            return nonBg > w * h * 0.001;
          });
          if (rendered) return true;
        }
      } catch {
        // frame likely not ready yet
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// ─── Per-format flow ─────────────────────────────────────────────────────

async function runFormat(page, fmt, jsErrors) {
  console.log(`\n--- ${fmt.label} (${fmt.id}) ---`);

  // Stage 1: workbench-loaded
  await page.waitForTimeout(800);
  await dismissOverlays(page);
  await page.waitForTimeout(400);
  let buf = await page.screenshot({ fullPage: false });
  let r = compareToBaseline(`${fmt.id}--workbench-loaded`, buf);
  r.ok
    ? recordPass(`${fmt.id} workbench-loaded`)
    : recordFail(`${fmt.id} workbench-loaded`, r.reason);

  // Stage 2: open the file
  jsErrors.length = 0;
  await openFileViaQuickOpen(page, fmt.open);
  // give the editor a moment to mount the webview shell
  await page.waitForTimeout(2500);
  buf = await page.screenshot({ fullPage: false });
  r = compareToBaseline(`${fmt.id}--file-opened`, buf);
  r.ok ? recordPass(`${fmt.id} file-opened`) : recordFail(`${fmt.id} file-opened`, r.reason);

  // Stage 3: wait for the megane viewer to render
  let rendered = true;
  if (fmt.expectsCanvas) {
    rendered = await waitForCanvasInWebview(page, 25000);
  } else {
    // Pipeline viewer: just give the webview shell time to mount
    await page.waitForTimeout(4000);
  }
  // small settle period after first frame
  await page.waitForTimeout(1500);
  buf = await page.screenshot({ fullPage: false });
  r = compareToBaseline(`${fmt.id}--viewer-rendered`, buf);
  if (fmt.expectsCanvas && !rendered) {
    recordFail(`${fmt.id} viewer-rendered (canvas)`, "no rendered canvas detected");
  } else {
    r.ok
      ? recordPass(`${fmt.id} viewer-rendered`)
      : recordFail(`${fmt.id} viewer-rendered`, r.reason);
  }

  // Critical JS errors check (filtered like the existing render test)
  const critical = jsErrors.filter(
    (e) =>
      (e.includes("Cannot read propert") ||
        e.includes("acquireVsCodeApi") ||
        e.toLowerCase().includes("megane")) &&
      !e.includes("Shader Error") &&
      !e.includes("WebGLProgram") &&
      !e.includes("open-vsx.org") &&
      !e.includes("CORS policy"),
  );
  if (critical.length === 0) {
    recordPass(`${fmt.id} no-critical-js-errors`);
  } else {
    recordFail(`${fmt.id} no-critical-js-errors`, JSON.stringify(critical));
  }

  // Close the active editor so the next format starts from a clean state
  await page.keyboard.press("Control+W");
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+W");
  await page.waitForTimeout(500);
}

// ─── Main ────────────────────────────────────────────────────────────────

let server = null;
let browser = null;
const tmpDirsToClean = [];

try {
  console.log(
    `\n=== megane VS Code Extension Full-Screen E2E ${UPDATE_MODE ? "[UPDATE]" : ""} ===`,
  );

  const formats = FORMAT_FILTER ? FORMATS.filter((f) => f.id === FORMAT_FILTER) : FORMATS;
  if (formats.length === 0) {
    throw new Error(`No formats matched filter: ${FORMAT_FILTER}`);
  }

  const vsixPath = buildVsix();

  const userDataDir = mkdtempSync(join(tmpdir(), "megane-cs-userdata-"));
  const extensionsDir = mkdtempSync(join(tmpdir(), "megane-cs-extensions-"));
  tmpDirsToClean.push(userDataDir, extensionsDir);

  installVsix(vsixPath, userDataDir, extensionsDir);

  const workspace = setupWorkspace(formats);
  tmpDirsToClean.push(workspace);

  server = await startCodeServer(workspace, userDataDir, extensionsDir);
  console.log(`code-server running at http://127.0.0.1:${PORT}`);
  await new Promise((r) => setTimeout(r, 3000));

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  const jsErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") jsErrors.push(msg.text());
  });
  page.on("pageerror", (err) => jsErrors.push(err.message));

  const url = `http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(workspace)}`;
  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 30000 });
  console.log("workbench loaded");

  // Allow extensions / editor to settle once before we start per-format runs.
  await page.waitForTimeout(4000);

  for (const fmt of formats) {
    try {
      await runFormat(page, fmt, jsErrors);
    } catch (err) {
      recordFail(`${fmt.id} (uncaught)`, err.message);
    }
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    const icon = r.status === "PASS" ? "[ok]" : "[xx]";
    console.log(`${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) {
    console.error(`\nE2E test FAILED (${failed} failure(s))`);
  } else {
    console.log("\nE2E test PASSED");
  }
} catch (err) {
  console.error(`\nE2E test crashed: ${err.stack ?? err.message ?? err}`);
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
  if (server && !KEEP_SERVER) {
    try {
      server.kill();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        server.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 3000).unref();
  }
  if (!KEEP_SERVER) {
    for (const d of tmpDirsToClean) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
