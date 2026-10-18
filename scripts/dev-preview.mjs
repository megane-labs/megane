/**
 * Dev Preview - Screenshot & Video capture for mobile development.
 *
 * When developing on mobile Claude Code without a dev server display,
 * this script captures screenshots and short videos of the running app
 * so you can push them to GitHub for visual review.
 *
 * Usage:
 *   node scripts/dev-preview.mjs [options]
 *
 * Options:
 *   --screenshot      Capture screenshots only (default: both)
 *   --video           Capture video only (default: both)
 *   --duration <ms>   Video recording duration in ms (default: 5000)
 *   --desktop-only    Skip mobile viewport captures
 *   --mobile-only     Skip desktop viewport captures
 *   --interact        Enable mouse interaction during video (rotate molecule)
 *   --clean           Remove previous captures before running
 *
 * Output:
 *   dev-preview/
 *     screenshots/
 *       desktop-<timestamp>.png
 *       mobile-<timestamp>.png
 *     videos/
 *       desktop-<timestamp>.webm
 *       mobile-<timestamp>.webm
 */

import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getChromium, startViteServer } from "../tests/e2e/utils/playwright.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(ROOT, "dev-preview");
const SCREENSHOTS_DIR = join(OUTPUT_DIR, "screenshots");
const VIDEOS_DIR = join(OUTPUT_DIR, "videos");

// Resolve Playwright via the shared helper (project node_modules first, then
// the global install) instead of duplicating the createRequire block.
const chromium = getChromium();

// ---- CLI argument parsing ----
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function getFlagValue(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

const SCREENSHOT_ONLY = hasFlag("--screenshot");
const VIDEO_ONLY = hasFlag("--video");
const CAPTURE_SCREENSHOTS = !VIDEO_ONLY;
const CAPTURE_VIDEOS = !SCREENSHOT_ONLY;
const VIDEO_DURATION = parseInt(getFlagValue("--duration", "5000"), 10);
const DESKTOP_ONLY = hasFlag("--desktop-only");
const MOBILE_ONLY = hasFlag("--mobile-only");
const INTERACT = hasFlag("--interact");
const CLEAN = hasFlag("--clean");

const TIMESTAMP = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);

const PORT = 15373 + Math.floor(Math.random() * 100);

const VIEWPORTS = [];
if (!MOBILE_ONLY) {
  VIEWPORTS.push({ name: "desktop", width: 1280, height: 720, dpr: 2 });
}
if (!DESKTOP_ONLY) {
  VIEWPORTS.push({ name: "mobile", width: 375, height: 812, dpr: 2 });
}

// ---- Helpers ----

function ensureDirs() {
  if (CLEAN && existsSync(OUTPUT_DIR)) {
    rmSync(OUTPUT_DIR, { recursive: true });
    console.log("Cleaned previous captures.");
  }
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  mkdirSync(VIDEOS_DIR, { recursive: true });
}

function ensureWasm() {
  const wasmPkg = join(ROOT, "crates", "megane-wasm", "pkg");
  if (existsSync(wasmPkg)) {
    console.log("WASM package found.");
    return;
  }
  console.log("WASM package not found. Building...");
  execSync("npm run build:wasm", { cwd: ROOT, stdio: "inherit", timeout: 180000 });
  console.log("WASM build succeeded.");
}

async function waitForApp(page) {
  await page.goto(`http://127.0.0.1:${PORT}`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.waitForSelector("canvas", { timeout: 15000 });
  // Wait for rendering to settle
  await page.waitForTimeout(3000);
}

async function simulateInteraction(page, viewport) {
  // Simulate mouse drag to rotate the molecule
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const dragDistance = Math.min(viewport.width, viewport.height) * 0.2;

  // Slow rotation drag
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI;
    const x = cx + dragDistance * Math.cos(angle);
    const y = cy + dragDistance * Math.sin(angle) * 0.3;
    await page.mouse.move(x, y);
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function captureScreenshot(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
  });
  const page = await context.newPage();

  await waitForApp(page);

  const filename = `${viewport.name}-${TIMESTAMP}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  const screenshot = await page.screenshot({ type: "png" });
  writeFileSync(filepath, screenshot);
  console.log(`  Screenshot saved: ${filepath}`);

  await context.close();
  return filename;
}

async function captureVideo(browser, viewport, durationMs) {
  const videoDir = join(VIDEOS_DIR, `tmp-${viewport.name}-${TIMESTAMP}`);
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    recordVideo: {
      dir: videoDir,
      size: { width: viewport.width, height: viewport.height },
    },
  });
  const page = await context.newPage();

  await waitForApp(page);

  if (INTERACT) {
    // Do some interaction for the video
    await simulateInteraction(page, viewport);
    const remaining = durationMs - 2500;
    if (remaining > 0) {
      await page.waitForTimeout(remaining);
    }
  } else {
    // Just wait, showing the app in its current state
    await page.waitForTimeout(durationMs);
  }

  // Close page and context to finalize video
  await page.close();
  await context.close();

  // Find the recorded video file and move it
  const files = readdirSync(videoDir);
  const videoFile = files.find((f) => f.endsWith(".webm"));
  if (videoFile) {
    const finalName = `${viewport.name}-${TIMESTAMP}.webm`;
    const src = join(videoDir, videoFile);
    const dest = join(VIDEOS_DIR, finalName);
    const { renameSync } = await import("fs");
    renameSync(src, dest);
    rmSync(videoDir, { recursive: true });
    console.log(`  Video saved: ${dest}`);
    return finalName;
  } else {
    console.log(`  Warning: No video file found in ${videoDir}`);
    rmSync(videoDir, { recursive: true });
    return null;
  }
}

// ---- Main ----

let server = null;
let browser = null;

try {
  ensureDirs();
  ensureWasm();

  console.log(`Viewports: ${VIEWPORTS.map((v) => `${v.name} (${v.width}x${v.height})`).join(", ")}`);
  if (CAPTURE_SCREENSHOTS) console.log("Screenshots: enabled");
  if (CAPTURE_VIDEOS) console.log(`Videos: enabled (${VIDEO_DURATION}ms${INTERACT ? " + interaction" : ""})`);

  console.log("\nStarting Vite dev server...");
  server = await startViteServer({ port: PORT });
  console.log(`Vite dev server running on port ${PORT}`);

  browser = await chromium.launch({ headless: true });

  const screenshotResults = [];
  const videoResults = [];

  for (const viewport of VIEWPORTS) {
    console.log(`\n--- ${viewport.name} (${viewport.width}x${viewport.height}) ---`);

    if (CAPTURE_SCREENSHOTS) {
      const filename = await captureScreenshot(browser, viewport);
      screenshotResults.push({ name: viewport.name, filename });
    }

    if (CAPTURE_VIDEOS) {
      const filename = await captureVideo(browser, viewport, VIDEO_DURATION);
      if (filename) {
        videoResults.push({ name: viewport.name, filename });
      }
    }
  }

  console.log("\nDev preview capture complete!");
  console.log(`Output: ${OUTPUT_DIR}`);
  console.log("Push to GitHub with: git add dev-preview && git commit -m 'dev preview' && git push");
} catch (err) {
  console.error("Dev preview capture failed:", err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
