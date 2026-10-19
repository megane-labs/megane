/**
 * Promotional-video director for the megane app.
 *
 * Records one continuous webm that follows this storyboard (see the user's
 * "台本"); the camera is the `#root` CSS transform, so every move between
 * regions is a smooth tween — there are no hard cuts:
 *
 *   1. Show the whole screen.
 *   2. Scroll + zoom down to the Chat input box (bottom-right).
 *   3. Type the prompt and click "Generate".
 *   4. Pan up to the top-right response area and dwell ~20s while the LLM
 *      reply streams in and the pipeline is applied (water → line repr).
 *   5. Pan over to the molecule and frame the whole structure (water now drawn
 *      as lines, caffeine left in its normal style).
 *   6. Scroll + zoom to the top-right (pipeline panel header).
 *   7. Click the Editor tab to reveal the generated pipeline graph.
 *   8. Slowly scroll down through the pipeline graph.
 *
 * The pipeline (steps 6-8) is shown with the SAME #root screen-zoom camera as
 * the rest of the video. ReactFlow measures node-handle positions with
 * getBoundingClientRect and can't account for an ancestor CSS transform, so the
 * generated graph's handles — registered while #root is scaled by the chat zoom
 * — end up with corrupted offsets and the edges balloon off their handles. The
 * fix is to re-measure the handles ONCE at identity (toggling the ReactFlow
 * container's display) before zooming in; after that a pure #root scale just
 * magnifies the whole graph uniformly, so the edges stay attached under the
 * screen zoom.
 *
 * Generation is a real, paid LLM call, so it only runs when you provide a key
 * or point at a site that ships its own proxy:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/promo-video.mjs   # local BYOK
 *   node scripts/promo-video.mjs --url https://<demo-site>/     # site proxy
 *   node scripts/promo-video.mjs --no-generate                  # type only
 *
 * Options:
 *   --out <path>            Output webm (default: demo/out/megane-promo-<ts>.webm)
 *   --url <url>             Record an already-running instance (its built-in LLM
 *                           proxy makes Generate work with no API key)
 *   --prompt <text>         Override the Chat prompt
 *   --width / --height <px> Viewport size (default 1920x1080)
 *   --dpr <n>               deviceScaleFactor (default 2 — crisp CSS-zoom)
 *   --response-wait <ms>    Dwell on the response frame (default 20000)
 *   --no-generate           Type the prompt but don't submit
 *   --clean                 Remove demo/out before running
 *
 * Requires WASM to be built first; this script builds it automatically if the
 * pkg directory is missing (AGENTS.md CRITICAL RULE #3).
 */

import { spawn, execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { join, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { getChromium } from "../tests/e2e/utils/playwright.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "demo", "out");

const chromium = getChromium();

// ---- CLI parsing ----
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getFlag = (f, d) => {
  const i = args.indexOf(f);
  return i === -1 || i + 1 >= args.length ? d : args[i + 1];
};

const TIMESTAMP = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);
const PORT = 15573 + Math.floor(Math.random() * 100);

// ---- Config ----
const WIDTH = parseInt(getFlag("--width", "1920"), 10);
const HEIGHT = parseInt(getFlag("--height", "1080"), 10);
const DPR = parseFloat(getFlag("--dpr", "2"));
// Default zoom-tween duration. Long enough to read as a deliberate camera move.
const TRANSITION_MS = parseInt(getFlag("--transition", "1100"), 10);
const PROMPT = getFlag(
  "--prompt",
  "Render the water molecules as a line representation, but leave the caffeine in its normal style.",
);
const RESPONSE_WAIT_MS = parseInt(getFlag("--response-wait", "20000"), 10);
// Number of reveal steps for the prompt "typewriter". The viewer renders the
// heavy 3D scene at only a few fps, so every awaited frame costs ~0.5s — a
// smooth per-character effect is impossible and would take ~50s. We instead
// reveal the prompt in a few chunks (~0.5s each). Lower = faster (1 = instant).
const TYPE_STEPS = Math.max(1, parseInt(getFlag("--type-steps", "6"), 10));
// Linear time spent scrolling down through the pipeline graph.
const PIPELINE_SCROLL_MS = parseInt(getFlag("--pipeline-scroll", "5200"), 10);
const NO_GENERATE = hasFlag("--no-generate");
const CLEAN = hasFlag("--clean");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const URL = getFlag("--url", "");
const URL_MODE = URL.length > 0;
const RUN_GENERATE = !NO_GENERATE && (Boolean(API_KEY) || URL_MODE);

const outArg = getFlag("--out", join(OUT_DIR, `megane-promo-${TIMESTAMP}.webm`));
const OUT_PATH = isAbsolute(outArg) ? outArg : join(ROOT, outArg);

const SEL = {
  // The AI assistant is docked in the Editor tab, under the graph.
  chatTab: '[data-testid="pipeline-editor-tab-editor"]',
  editorTab: '[data-testid="pipeline-editor-tab-editor"]',
  promptBox: '[data-testid="pipeline-chat-input"]',
  generateBtn: 'button:has-text("Generate")',
  chatMessages: '[data-testid="pipeline-chat-messages"]',
  // A reply that changed the pipeline offers Undo once it has been applied.
  appliedNotice: '[data-testid="pipeline-chat-undo"]',
  panelPipeline: '[data-testid="panel-pipeline"]',
  viewer: '[data-testid="viewer-root"]',
  reactFlow: ".react-flow",
};

// ---- Setup helpers ----

function ensureWasm() {
  if (existsSync(join(ROOT, "crates", "megane-wasm", "pkg"))) return;
  console.log("WASM package not found. Building...");
  execSync("npm run build:wasm", { cwd: ROOT, stdio: "inherit", timeout: 180000 });
}

function startViteServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npx", ["vite", "--port", String(PORT), "--host", "127.0.0.1"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "development" },
    });
    const timeout = setTimeout(() => reject(new Error("Vite did not start in time")), 30000);
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

async function waitForApp(page, appUrl) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForSelector(SEL.panelPipeline, { state: "visible", timeout: 15000 });
  // ReactFlow mounts hidden on the Editor tab — wait for it attached, not visible.
  await page.waitForSelector(SEL.reactFlow, { state: "attached", timeout: 15000 });
  await page.waitForTimeout(3500); // let the first render + trajectory settle
}

// ---- Camera (the #root CSS transform) ----
// screen = translate(tx,ty) ∘ scale(s) over local coords, origin top-left.
let current = { tx: 0, ty: 0, s: 1 };

async function applyTransform(page, t) {
  current = t;
  await page.evaluate(
    ({ tx, ty, s }) => {
      const root = document.getElementById("root");
      if (root) root.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    },
    t,
  );
}

async function setTransition(page, ms, easing = "cubic-bezier(0.4, 0, 0.2, 1)") {
  await page.evaluate(
    ({ ms, easing }) => {
      const root = document.getElementById("root");
      if (root) root.style.transition = `transform ${ms}ms ${easing}`;
    },
    { ms, easing },
  );
}

/** Recover an element's untransformed (local) rect from its on-screen box. */
function toLocalRect(box) {
  return {
    lx: (box.x - current.tx) / current.s,
    ly: (box.y - current.ty) / current.s,
    lw: box.width / current.s,
    lh: box.height / current.s,
  };
}

/** Union of several on-screen boxes (skips nulls). */
function unionBoxes(boxes) {
  const valid = boxes.filter(Boolean);
  if (valid.length === 0) return null;
  const x0 = Math.min(...valid.map((b) => b.x));
  const y0 = Math.min(...valid.map((b) => b.y));
  const x1 = Math.max(...valid.map((b) => b.x + b.width));
  const y1 = Math.max(...valid.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

async function boxOf(page, sel) {
  return page.locator(sel).first().boundingBox();
}

/**
 * Tween the camera so a local rect is framed.
 *   scale   explicit zoom factor; otherwise fit the padded rect to the viewport
 *   anchorX/anchorY  which point of the rect maps to the viewport centre (0..1)
 *   alignTop pin the rect's top near the top of the screen instead of centring Y
 */
async function frameLocalRect(page, rect, opts = {}, ms = TRANSITION_MS) {
  const { pad = 0, scale, anchorX = 0.5, anchorY = 0.5, alignTop = false, topMargin = 48 } = opts;
  const lx = rect.lx - pad;
  const ly = rect.ly - pad;
  const lw = rect.lw + 2 * pad;
  const lh = rect.lh + 2 * pad;
  const s = scale ?? Math.min(WIDTH / lw, HEIGHT / lh);
  const tx = WIDTH / 2 - (lx + lw * anchorX) * s;
  const ty = alignTop ? topMargin - ly * s : HEIGHT / 2 - (ly + lh * anchorY) * s;
  await setTransition(page, ms);
  await applyTransform(page, { tx, ty, s });
  await page.waitForTimeout(ms);
}

async function zoomFull(page, ms = TRANSITION_MS) {
  await setTransition(page, ms);
  await applyTransform(page, { tx: 0, ty: 0, s: 1 });
  await page.waitForTimeout(ms);
}

async function zoomToSel(page, sel, opts = {}, ms = TRANSITION_MS) {
  const box = await boxOf(page, sel);
  if (!box) {
    console.warn(`  zoom target not found: ${sel} (skipping)`);
    return;
  }
  await frameLocalRect(page, toLocalRect(box), opts, ms);
}

async function zoomToUnion(page, sels, opts = {}, ms = TRANSITION_MS) {
  const boxes = await Promise.all(sels.map((s) => boxOf(page, s)));
  const u = unionBoxes(boxes);
  if (!u) {
    console.warn(`  zoom targets not found: ${sels.join(", ")} (skipping)`);
    return;
  }
  await frameLocalRect(page, toLocalRect(u), opts, ms);
}

/** Pan the camera (keep scale) to an explicit target transform over `ms`. */
async function panTo(page, target, ms = TRANSITION_MS, easing = "linear") {
  await setTransition(page, ms, easing);
  await applyTransform(page, { ...current, ...target });
  await page.waitForTimeout(ms);
}

/**
 * Scroll the screen-zoom camera down through an element (e.g. the pipeline
 * graph): keep the current scale and pan vertically until the element's bottom
 * reaches the bottom of the viewport. Pure #root pan, so ReactFlow never
 * re-measures and the edges stay attached.
 */
async function screenScrollDown(page, sel, ms) {
  const box = await boxOf(page, sel);
  if (!box) return;
  const { ly, lh } = toLocalRect(box);
  const s = current.s;
  const tyBottom = HEIGHT - (ly + lh) * s;
  if (tyBottom < current.ty - 4) await panTo(page, { ty: tyBottom }, ms, "linear");
  else console.log("  graph already fits; no scroll needed");
}

// ---- Chat actions ----

async function typePrompt(page) {
  await page.locator(SEL.promptBox).first().waitFor({ state: "visible", timeout: 10000 });
  // The reveal runs entirely in-page (one evaluate). We drive React's controlled
  // textarea via its native value setter + an `input` event so React keeps the
  // value and the Generate button enables. The viewer's render loop hogs the main
  // thread (~a few fps), so each awaited frame costs ~0.5s and the cost is
  // dominated by the number of `input` events, NOT any sleep — hence we reveal in
  // a small fixed number of chunks rather than per character. It's position-
  // independent, so it stays correct while the camera is zoomed into the input.
  await page.evaluate(
    async ({ sel, text, steps }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      const raf = () => new Promise((r) => requestAnimationFrame(r));
      for (let k = 1; k <= steps; k++) {
        const len = Math.round((text.length * k) / steps);
        setter.call(el, text.slice(0, len));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (k < steps) await raf(); // one render per chunk paces the visible reveal
      }
    },
    { sel: SEL.promptBox, text: PROMPT, steps: TYPE_STEPS },
  );
}

async function clickGenerate(page) {
  if (!RUN_GENERATE) {
    console.log("  generation off (no key / no site LLM / --no-generate); prompt left in box");
    return;
  }
  // The Generate button is on-screen in the zoomed-in input frame; Playwright
  // resolves the click point through the CSS transform, so a normal click works.
  await page
    .locator(SEL.generateBtn)
    .first()
    .click({ timeout: 8000 })
    .catch(async (e) => {
      console.warn("  Generate click failed, falling back to Enter:", e.message);
      await page.evaluate((sel) => document.querySelector(sel)?.focus(), SEL.promptBox);
      await page.keyboard.press("Enter");
    });
}

/** Wait until the streamed reply has been applied (or the timeout elapses). */
async function waitForApplied(page, ms) {
  if (!RUN_GENERATE) {
    await page.waitForTimeout(ms);
    return;
  }
  const applied = page
    .locator(SEL.appliedNotice)
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
  // Dwell the full window regardless, so the response stays readable on screen.
  const [ok] = await Promise.all([applied, page.waitForTimeout(ms)]);
  console.log(ok ? "  pipeline applied" : "  applied notice not seen (dwell elapsed)");
}

// ---- BYOK key setup (local runs only; --url uses the site's own proxy) ----
async function setupApiKey(page) {
  if (NO_GENERATE || !API_KEY || URL_MODE) return;
  try {
    await page.locator(SEL.chatTab).first().click();
    await page.waitForTimeout(300);
    await page.locator('button[title="AI Settings"]').first().click();
    await page.waitForTimeout(300);
    await page.locator('input[type="password"]').first().fill(API_KEY);
    await page.locator('button[title="AI Settings"]').first().click();
    await page.waitForTimeout(300);
    console.log("  API key injected via Chat config panel");
  } catch (e) {
    console.warn("  API key setup failed (will fall back to no-generate):", e.message);
  }
}

// ---- Pipeline handle re-measure ----
// ReactFlow measures node-handle positions with getBoundingClientRect and has no
// knowledge of an ancestor CSS transform. The LLM-generated graph's handles get
// registered while #root is CSS-scaled by the chat zoom, so their stored offsets
// are wrong and the edges balloon off their handles. Re-measuring once at
// identity fixes the offsets; afterwards a pure #root scale just magnifies the
// whole graph uniformly (no re-measure), so the edges stay attached even under
// the screen zoom.

/**
 * Force ReactFlow to re-measure every node handle by toggling the container's
 * display off and on (a real layout teardown/rebuild). Call it at #root identity
 * (the editor may still be hidden behind another tab) so the handles are measured
 * unscaled.
 */
async function forceReactFlowRemeasure(page) {
  await page.evaluate((sel) => {
    const rf = document.querySelector(sel);
    if (rf) {
      rf.style.display = "none";
      void rf.offsetWidth;
    }
  }, SEL.reactFlow);
  await page.waitForTimeout(200);
  await page.evaluate((sel) => {
    const rf = document.querySelector(sel);
    if (rf) {
      rf.style.display = "";
      void rf.offsetWidth;
    }
  }, SEL.reactFlow);
  await page.waitForTimeout(550);
}

/**
 * Click a DOM element directly (bypassing Playwright's actionability checks) —
 * robust when the target sits under the #root screen-zoom transform.
 */
async function domClick(page, sel) {
  await page.evaluate((s) => document.querySelector(s)?.click(), sel);
}

// ---- Main ----
let server = null;
let browser = null;
let context = null;

try {
  if (CLEAN && existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const genLabel = NO_GENERATE
    ? "off (--no-generate)"
    : API_KEY
      ? "live (ANTHROPIC_API_KEY)"
      : URL_MODE
        ? "live (site LLM via --url)"
        : "off (no key — pass ANTHROPIC_API_KEY or --url for the real effect)";
  console.log(`Output: ${OUT_PATH}`);
  console.log(`Viewport: ${WIDTH}x${HEIGHT} @${DPR}x`);
  console.log(`Prompt: ${PROMPT}`);
  console.log(`Generate: ${genLabel}`);

  let appUrl;
  if (URL_MODE) {
    appUrl = URL;
    console.log(`\nTarget: ${appUrl} (no local server)`);
  } else {
    ensureWasm();
    console.log("\nStarting Vite dev server...");
    server = await startViteServer();
    appUrl = `http://127.0.0.1:${PORT}/`;
    console.log(`Vite running on port ${PORT}`);
  }

  browser = await chromium.launch({ headless: true });

  // Warm-up pass in a throwaway (non-recorded) context. Vite dev compiles the
  // app + WASM lazily on first request, which can take a minute — recording
  // that would prepend a long static frame to the video. Pre-compiling here so
  // the recorded load is fast keeps the output tight (skipped in --url mode,
  // where the target is already built/served).
  if (!URL_MODE) {
    console.log("Warming up the dev server (pre-compile)...");
    const warm = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const wp = await warm.newPage();
      await wp.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await wp.waitForSelector("canvas", { timeout: 60000 }).catch(() => {});
      await wp.waitForTimeout(2000);
    } catch (e) {
      console.warn("  warm-up incomplete (continuing):", e.message);
    } finally {
      await warm.close();
    }
  }

  const tmpDir = join(OUT_DIR, `tmp-${TIMESTAMP}`);
  mkdirSync(tmpDir, { recursive: true });

  context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: DPR,
    recordVideo: { dir: tmpDir, size: { width: WIDTH, height: HEIGHT } },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("megane-tour-prefs", JSON.stringify({ dontShowAgain: true }));
      sessionStorage.setItem("megane-pipeline-ui", JSON.stringify({ mode: "editor" }));
    } catch {
      /* noop */
    }
    // The chat auto-scrolls to the newest message on every streamed chunk via
    // scrollIntoView; with a verbose reply that drags the response out of our
    // fixed top-aligned frame mid-generation. Neutralise it so the response
    // stays put (only the chat uses scrollIntoView; ReactFlow pans via its own
    // transform, not scrollIntoView).
    window.Element.prototype.scrollIntoView = function () {};
  });

  const page = await context.newPage();
  await waitForApp(page, appUrl);

  // Make #root zoomable with a smooth tween anchored at the top-left.
  await page.evaluate((ms) => {
    const root = document.getElementById("root");
    if (root) {
      root.style.transformOrigin = "0 0";
      root.style.transition = `transform ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;
      root.style.willChange = "transform";
    }
  }, TRANSITION_MS);

  await setupApiKey(page);
  // Ensure we're on the Editor tab, where the assistant is docked, before recording the moves.
  await page.locator(SEL.chatTab).first().click().catch(() => {});
  await page.waitForTimeout(500);

  // ── 1. Whole screen ───────────────────────────────────────────────────────
  console.log("Scene 1: overview");
  await zoomFull(page, 600);
  await page.waitForTimeout(2500);

  // ── 2. Scroll + zoom to the Chat input (bottom-right) ──────────────────────
  console.log("Scene 2: zoom to chat input");
  // Frame the input box together with the Generate button so the click target
  // stays comfortably on screen.
  await zoomToUnion(page, [SEL.promptBox, SEL.generateBtn], { pad: 24, anchorY: 0.5 });
  // Remember this magnification so the response scene (4) frames the chat at the
  // exact same zoom level as the input — the camera only slides up, never rescales.
  const inputScale = current.s;
  await page.waitForTimeout(700);

  // ── 3. Type the prompt and click Generate ──────────────────────────────────
  console.log("Scene 3: type prompt + Generate");
  await typePrompt(page);
  await page.waitForTimeout(600);
  await clickGenerate(page);
  await page.waitForTimeout(900);

  // ── 4. Pan up to the response area; dwell while the reply streams in ────────
  // Keep the input's magnification (`inputScale`) and only slide the camera up to
  // the messages area, so the zoom level matches scene 2/3 exactly.
  console.log(`Scene 4: response area, dwell ${RESPONSE_WAIT_MS}ms`);
  await zoomToSel(page, SEL.chatMessages, {
    pad: 18,
    alignTop: true,
    topMargin: 64,
    scale: inputScale,
  });
  await waitForApplied(page, RESPONSE_WAIT_MS);

  // ── 5. Frame the whole molecule (water now drawn as lines) ──────────────────
  console.log("Scene 5: molecule overview");
  await zoomToSel(page, SEL.viewer, { pad: 8 });
  await page.waitForTimeout(4000);

  // ── 6. Screen-zoom into the top of the right sidebar (pipeline panel) ───────
  // A true camera zoom (the #root CSS scale, same as the chat zoom) into the top
  // of the sidebar — NOT a resize of the sidebar itself. ReactFlow's edges break
  // if it re-measures handles under a CSS scale, and the generated graph's
  // handles were registered under the chat zoom, so first — at identity, with the
  // editor still hidden — we force a handle re-measure to fix them. After that a
  // pure #root scale just magnifies the whole graph uniformly, leaving the edges
  // attached.
  console.log("Scene 6: screen-zoom into the sidebar");
  const haveFlow = (await boxOf(page, SEL.reactFlow)) !== null;
  await zoomFull(page);
  await forceReactFlowRemeasure(page); // at identity, editor hidden → fixes handles
  await zoomToSel(page, SEL.panelPipeline, { pad: 12, alignTop: true, topMargin: 48, scale: 2.0 });
  await page.waitForTimeout(1800);

  // ── 7. Click the Editor tab → pipeline appears within the same screen-zoom ──
  // Switch tab under the screen zoom. fitView (mode-change effect) only moves
  // ReactFlow's internal viewport, not the handle offsets, so the edges stay
  // attached at the magnification set in scene 6.
  console.log("Scene 7: show pipeline");
  await domClick(page, SEL.editorTab);
  await page.waitForTimeout(1800);

  if (haveFlow) {
    // ── 8. Scroll down through the pipeline (camera pan, screen-zoom kept) ────
    console.log("Scene 8: scroll through pipeline");
    await screenScrollDown(page, SEL.reactFlow, PIPELINE_SCROLL_MS);
    await page.waitForTimeout(2500);
  } else {
    console.warn("  react-flow not found; skipping pipeline scroll");
    await page.waitForTimeout(2500);
  }

  // Finalize the recording.
  await page.close();
  await context.close();
  context = null;

  const file = readdirSync(tmpDir).find((f) => f.endsWith(".webm"));
  if (!file) throw new Error(`No webm produced in ${tmpDir}`);
  renameSync(join(tmpDir, file), OUT_PATH);
  rmSync(tmpDir, { recursive: true });

  console.log(`\nDone. Promo video saved: ${OUT_PATH}`);
} catch (err) {
  console.error("Promo video failed:", err.message);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (server) server.kill();
}
