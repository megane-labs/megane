/**
 * E2E rendering test for the megane VS Code extension.
 *
 * Downloads the VSIX from the VS Code Marketplace, installs it into
 * code-server, opens a PDB file, and verifies that:
 *   1. The megane custom editor activates (canvas element created)
 *   2. No critical JS errors occur
 *   3. The canvas contains non-white pixels (atoms rendered)
 *
 * Usage:
 *   node tests/e2e/test_vscode_render.mjs <version>
 *   node tests/e2e/test_vscode_render.mjs 0.4.0
 *
 * Requires:
 *   - code-server (installed via `npm install -g code-server` if missing)
 *   - playwright (resolved by tests/e2e/utils/playwright.mjs)
 *   - Internet access to download VSIX from VS Code Marketplace
 */

import { spawn, execSync, execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { createWriteStream } from "fs";
import { get as httpsGet } from "https";
import { gunzipSync } from "zlib";
import { getChromium } from "./utils/playwright.mjs";

const chromium = getChromium();

const VERSION = process.argv[2];
if (!VERSION) {
  console.error("Usage: node test_vscode_render.mjs <version>");
  console.error("Example: node test_vscode_render.mjs 0.4.0");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  console.error(`Invalid version format: ${VERSION}. Expected semver (e.g. 0.4.0)`);
  process.exit(1);
}

const PUBLISHER = "hodakamori";
const EXTENSION_NAME = "vscode-megane";
const MARKETPLACE_URL = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${PUBLISHER}/vsextensions/${EXTENSION_NAME}/${VERSION}/vspackage`;
const VSIX_PATH = `/tmp/vscode-megane-${VERSION}.vsix`;
const WORKSPACE_DIR = `/tmp/megane-ws-${VERSION}`;
const USER_DATA_DIR = `/tmp/megane-render-verify-${VERSION}/user-data`;
const EXTENSIONS_DIR = `/tmp/megane-render-verify-${VERSION}/extensions`;
const PORT = 38000 + Math.floor(Math.random() * 1000);
const CWD = process.cwd();

// Minimal 3-atom water molecule PDB for testing
const TEST_PDB = `ATOM      1  O   HOH A   1       0.000   0.000   0.117  1.00  0.00           O
ATOM      2  H1  HOH A   1       0.757   0.000  -0.469  1.00  0.00           H
ATOM      3  H2  HOH A   1      -0.757   0.000  -0.469  1.00  0.00           H
END
`;

// ---- Helpers ----

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`PASS: ${message}`);
}

function ensureCodeServer() {
  try {
    execFileSync("which", ["code-server"], { stdio: "ignore" });
    console.log("code-server is available");
  } catch {
    console.log("code-server not found, installing via npm...");
    execSync("npm install -g code-server", { stdio: "inherit" });
    console.log("code-server installed");
  }
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]); // "PK"

/**
 * Normalize a downloaded VSIX to a plain zip on disk.
 *
 * The Marketplace `vspackage` endpoint serves the package gzip-encoded, and
 * `https.get` does not honour `Content-Encoding` for us — piping the response
 * straight to a file leaves gzip bytes behind. code-server then rejects the
 * install with a yauzl `Extract` error that looks like a broken release when
 * the published VSIX is perfectly fine.
 */
function ensureUncompressedVsix(destPath) {
  let buf = readFileSync(destPath);
  if (buf.subarray(0, 2).equals(GZIP_MAGIC)) {
    buf = gunzipSync(buf);
    writeFileSync(destPath, buf);
    console.log("VSIX arrived gzip-encoded; decompressed in place");
  }
  if (!buf.subarray(0, 2).equals(ZIP_MAGIC)) {
    throw new Error(
      `${destPath} is not a zip archive (leading bytes ${buf.subarray(0, 2).toString("hex")}). ` +
        `The Marketplace download likely returned an error page.`,
    );
  }
}

async function downloadVsixAsync(url, destPath) {
  if (existsSync(destPath)) {
    console.log(`VSIX already exists at ${destPath}, skipping download`);
    ensureUncompressedVsix(destPath);
    return;
  }

  console.log(`Downloading VSIX from Marketplace...`);

  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);

    function doGet(requestUrl) {
      const lib = requestUrl.startsWith("https://") ? httpsGet : null;
      if (!lib) {
        reject(new Error("Only HTTPS URLs are supported"));
        return;
      }
      lib(requestUrl, { headers: { "User-Agent": "megane-release-verify/1.0" } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          doGet(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(
            new Error(`Failed to download VSIX: HTTP ${response.statusCode} from ${requestUrl}`),
          );
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log(`VSIX downloaded to ${destPath}`);
          try {
            ensureUncompressedVsix(destPath);
          } catch (err) {
            reject(err);
            return;
          }
          resolve();
        });
        file.on("error", reject);
      }).on("error", reject);
    }

    doGet(url);
  });
}

/**
 * Write the same deterministic settings `lib/hosts/code-server.ts` uses.
 *
 * Without `workbench.startupEditor: "none"` code-server opens its Welcome
 * walkthrough, which keeps editor focus and hides the megane webview behind
 * a `.webview` iframe belonging to the walkthrough — the file never opens and
 * the failure looks like a broken extension. `editorAssociations` pins `.pdb`
 * to the megane custom editor so the double-click cannot land in the text
 * editor instead.
 */
function writeUserSettings() {
  const settingsDir = join(USER_DATA_DIR, "User");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(
    join(settingsDir, "settings.json"),
    JSON.stringify(
      {
        "workbench.startupEditor": "none",
        "workbench.editorAssociations": { "*.pdb": "megane.structureViewer" },
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        "security.workspace.trust.enabled": false,
        "extensions.autoCheckUpdates": false,
        "window.commandCenter": false,
      },
      null,
      2,
    ),
  );
}

function installExtension(vsixPath) {
  console.log(`Installing extension from ${vsixPath}...`);
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  execFileSync(
    "code-server",
    [
      "--user-data-dir",
      USER_DATA_DIR,
      "--extensions-dir",
      EXTENSIONS_DIR,
      "--install-extension",
      vsixPath,
    ],
    { stdio: "inherit" },
  );
  console.log("Extension installed");
}

function setupWorkspace() {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  const pdbPath = join(WORKSPACE_DIR, "test.pdb");
  writeFileSync(pdbPath, TEST_PDB);
  console.log(`Workspace created at ${WORKSPACE_DIR}`);
  console.log(`Test PDB written to ${pdbPath}`);
  return pdbPath;
}

async function startCodeServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "code-server",
      [
        "--auth",
        "none",
        "--port",
        String(PORT),
        "--user-data-dir",
        USER_DATA_DIR,
        "--extensions-dir",
        EXTENSIONS_DIR,
        "--disable-telemetry",
        "--disable-update-check",
        WORKSPACE_DIR,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: "/root", MEGANE_E2E_MODE: "1" },
      },
    );

    const timer = setTimeout(
      () => reject(new Error("code-server did not start within 30s")),
      30000,
    );

    const handler = (data) => {
      const line = data.toString();
      process.stdout.write(`[code-server] ${line}`);
      if (line.includes("HTTP server listening") || line.includes(`localhost:${PORT}`)) {
        clearTimeout(timer);
        resolve(proc);
      }
    };

    proc.stdout.on("data", handler);
    proc.stderr.on("data", handler);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Resolve the frame that actually owns the megane renderer.
 *
 * Mirrors `getWebviewFrame` in lib/hosts/code-server.ts: the webview shell
 * varies between code-server releases, so match on markers only the megane
 * bundle sets rather than on a selector path.
 */
async function waitForMeganeFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const url = frame.url();
      seen.add(url);
      if (url.includes("webWorkerExtensionHostIframe")) continue;
      try {
        const isMegane = await frame.evaluate(() => {
          if (document.querySelector('[data-testid="megane-viewer"]')) return true;
          if (document.querySelector('[data-testid="viewer-root"]')) return true;
          return !!window.__MEGANE_CONTEXT__;
        });
        if (isMegane) return frame;
      } catch {
        // Frame mid-navigation or detached; retry on the next sweep.
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `megane webview frame did not appear within ${timeoutMs}ms. Frames seen: ${JSON.stringify(
      Array.from(seen),
      null,
      2,
    )}`,
  );
}

// ---- Main ----

let server = null;
let browser = null;

try {
  console.log(`\n=== megane VS Code Extension Rendering Test (v${VERSION}) ===\n`);

  // Step 1: Ensure code-server is available
  ensureCodeServer();

  // Step 2: Download VSIX from Marketplace
  await downloadVsixAsync(MARKETPLACE_URL, VSIX_PATH);

  // Step 3: Install extension into code-server
  writeUserSettings();
  installExtension(VSIX_PATH);

  // Step 4: Set up workspace with test PDB
  setupWorkspace();

  // Step 5: Start code-server
  server = await startCodeServer();
  console.log(`code-server running on port ${PORT}`);

  // Allow code-server to fully initialize
  await new Promise((r) => setTimeout(r, 3000));

  // Step 6: Launch Playwright
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  const jsErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") jsErrors.push(msg.text());
  });
  page.on("pageerror", (err) => jsErrors.push(err.message));

  // Step 7: Open code-server and navigate to the workspace
  const workspaceUrl = `http://localhost:${PORT}/?folder=${encodeURIComponent(WORKSPACE_DIR)}`;
  console.log(`Navigating to: ${workspaceUrl}`);
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for code-server UI to load (workbench)
  await page.waitForSelector(".monaco-workbench", { timeout: 30000 });
  console.log("code-server workbench loaded");

  // Wait a bit for extensions to activate
  await page.waitForTimeout(3000);

  // Step 8: Open test.pdb via the file explorer
  console.log("Opening test.pdb...");

  // Dismiss any modal dialogs (e.g., workspace trust)
  try {
    const trustButton = page.getByRole("button", { name: /trust the authors/i });
    await trustButton.waitFor({ timeout: 3000 });
    await trustButton.click();
    console.log("Dismissed workspace trust dialog");
    await page.waitForTimeout(1000);
  } catch {
    console.log("No trust dialog found, continuing");
  }

  // Open from the explorer tree. Ctrl+P is deliberately not used as a
  // fallback: on code-server's web build the welcome / walkthrough tab eats
  // the keystrokes, so a "success" there can leave the file unopened. Same
  // reasoning as `openVscodeFile` in lib/hosts/code-server.ts.
  const treeItem = page.getByRole("treeitem", { name: "test.pdb", exact: true });
  await treeItem.waitFor({ state: "visible", timeout: 30000 });
  await treeItem.click({ force: true });
  await treeItem.dblclick({ force: true });
  console.log("File opened via explorer tree");

  // Wait for the megane custom editor canvas to appear
  // The canvas is inside a webview iframe
  console.log("Waiting for megane custom editor to activate...");

  // code-server renders webviews in iframes; wait for the webview iframe
  let canvasFound = false;
  let canvasResult = { hasContent: false, totalPixels: 0, nonWhitePixels: 0 };

  try {
    // Don't gate on `.webview` visibility: code-server stacks several
    // iframes per webview and other contributions (walkthrough, chat panel)
    // own `.webview` nodes of their own. Scan every frame for the megane
    // renderer instead — the strategy `getWebviewFrame` uses.
    const megFrame = await waitForMeganeFrame(page, 90000);
    console.log(`megane webview frame: ${megFrame.url()}`);

    // Allow WASM to load and Three.js to render
    await page.waitForTimeout(5000);

    for (const frame of [megFrame]) {
      try {
        const canvas = await frame.$("canvas");
        if (canvas) {
          console.log(`Canvas found in frame: ${frame.url()}`);
          canvasFound = true;
          canvasResult = await frame.evaluate(() => {
            const canvas = document.querySelector("canvas");
            if (!canvas) return { hasContent: false, totalPixels: 0, nonWhitePixels: 0 };

            const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
            if (!gl) return { hasContent: false, totalPixels: 0, nonWhitePixels: 0 };

            const width = gl.drawingBufferWidth;
            const height = gl.drawingBufferHeight;
            const pixels = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

            let nonWhite = 0;
            const total = width * height;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) {
                nonWhite++;
              }
            }
            return {
              hasContent: nonWhite > total * 0.001,
              totalPixels: total,
              nonWhitePixels: nonWhite,
            };
          });
          break;
        }
      } catch {
        // Frame may not be accessible (cross-origin); continue
      }
    }
  } catch (err) {
    console.log(`Warning: ${err.message}`);
  }

  // Take screenshot regardless of outcome
  const screenshotPath = join(CWD, "tests", "e2e", "screenshot_vscode_render.png");
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);

  // ---- Assertions ----

  assert(canvasFound, "megane custom editor canvas is created in webview");

  console.log(
    `  Canvas: ${canvasResult.nonWhitePixels}/${canvasResult.totalPixels} non-white pixels`,
  );
  assert(
    canvasResult.hasContent,
    `Canvas contains rendered atoms (${canvasResult.nonWhitePixels} non-white pixels)`,
  );

  // Classify against a path-stripped copy of each message. Host stack traces
  // embed the checkout path (…/megane/.code-server/…), so a bare "megane"
  // substring test otherwise flags unrelated code-server noise — e.g.
  // `vscode.git` failing to activate on the npm-built code-server — as a
  // megane regression. Other extensions' activation failures are host
  // problems either way, so they are excluded outright.
  const criticalErrors = jsErrors.filter((raw) => {
    const e = raw.replace(/\/\S+/g, "<path>");
    if (/Activating extension '(?!megane|hodakamori\.)/.test(e)) return false;
    return (
      (e.includes("Cannot read propert") ||
        e.includes("acquireVsCodeApi") ||
        e.includes("megane")) &&
      !e.includes("Shader Error") &&
      !e.includes("WebGLProgram") &&
      !e.includes("open-vsx.org") &&
      !e.includes("CORS policy")
    );
  });
  assert(
    criticalErrors.length === 0,
    `No critical JS errors (found ${criticalErrors.length}: ${JSON.stringify(criticalErrors)})`,
  );

  console.log("\n=== VS Code Extension Rendering Test: PASSED ===");
} catch (err) {
  console.error("\nVS Code extension rendering test FAILED:", err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill();
    server.stdout?.destroy();
    server.stderr?.destroy();
    server.unref();
    setTimeout(() => {
      try {
        server.kill("SIGKILL");
      } catch {}
    }, 3000).unref();
  }
}
