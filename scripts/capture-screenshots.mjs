/**
 * Capture documentation screenshots for README and docs.
 *
 * Usage:
 *   node scripts/capture-screenshots.mjs
 *
 * Starts a Vite dev server, opens the full app (which auto-loads
 * caffeine_water with trajectory), and captures a high-quality screenshot
 * including the 3D viewport, pipeline editor sidebar, and timeline bar.
 *
 * Requires: WASM must be built first (`npm run build:wasm` or `npm run build`).
 */

import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getChromium } from "../tests/e2e/utils/playwright.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(ROOT, "docs", "public", "screenshots");

// Resolve Playwright via the shared helper (project node_modules first, then
// the global install) instead of duplicating the createRequire block.
const chromium = getChromium();

const PORT = 15273 + Math.floor(Math.random() * 100);

function startViteServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["vite", "--port", String(PORT), "--host", "127.0.0.1"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
    });

    const timeout = setTimeout(() => {
      reject(new Error("Vite dev server did not start in time"));
    }, 30000);

    const handler = (data) => {
      const line = data.toString();
      if (line.includes("Local:") && line.includes(String(PORT))) {
        clearTimeout(timeout);
        resolve(proc);
      }
    };

    proc.stdout.on("data", handler);
    proc.stderr.on("data", handler);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

let server = null;
let browser = null;

try {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("Starting Vite dev server...");
  server = await startViteServer();
  console.log(`Vite dev server running on port ${PORT}`);

  browser = await chromium.launch({ headless: true });

  // Hero screenshot: full app UI with 3D viewport, pipeline editor, timeline (1280x720, DPR=2)
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // Suppress the first-time user tour so the screenshot doesn't capture
    // the welcome modal overlay.
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          "megane-tour-prefs",
          JSON.stringify({ dontShowAgain: true }),
        );
        // The Pipeline panel opens on the Chat tab by default; the hero
        // screenshot needs the visual editor visible.
        sessionStorage.setItem(
          "megane-pipeline-ui",
          JSON.stringify({ mode: "editor" }),
        );
      } catch {
        /* noop */
      }
    });

    // Load the full app — auto-loads caffeine_water with trajectory,
    // rendering the complete UI (3D viewport, pipeline editor, timeline).
    await page.goto(`http://127.0.0.1:${PORT}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForSelector("canvas", { timeout: 15000 });
    await page.waitForSelector(".react-flow", { timeout: 15000 });
    console.log("Full app loaded (canvas + pipeline editor) (1280x720, DPR=2)");

    // Wait for rendering to settle
    await page.waitForTimeout(3000);

    const screenshot = await page.screenshot({ type: "png" });
    const outputPath = join(OUTPUT_DIR, "hero.png");
    writeFileSync(outputPath, screenshot);
    console.log(`Saved: ${outputPath}`);

    await context.close();
  }

  console.log("\nAll screenshots captured successfully.");
} catch (err) {
  console.error("Screenshot capture failed:", err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) server.kill();
}
