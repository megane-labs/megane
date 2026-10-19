---
name: preview
description: Capture screenshots and videos of the megane viewer for visual review. Use when asked to take screenshots, capture previews, or verify visual output.
---

# Screenshot & Preview Capture

## IMPORTANT: These scripts use Playwright, NOT Puppeteer

All scripts resolve Playwright through the shared `tests/e2e/utils/playwright.mjs`
helper (`getChromium()`), which prefers the project's own `node_modules` and
falls back to the global install at `/opt/node22/lib/node_modules/`.

## Dev Preview (screenshots + video for visual review)

### Screenshots only
```
node scripts/dev-preview.mjs --screenshot
```
or: `make preview-screenshot`

### Video with interaction (rotates molecule)
```
node scripts/dev-preview.mjs --video --interact
```
or: `make preview-video`

### Both screenshots and video
```
node scripts/dev-preview.mjs --interact
```
or: `make preview`

Output goes to `dev-preview/` directory.

### Options
- `--desktop-only` / `--mobile-only` — limit viewports
- `--duration <ms>` — video duration (default 5000)
- `--clean` — remove previous captures first

## Hero Screenshot (for docs/README)
```
node scripts/capture-screenshots.mjs
```
Captures a high-quality 1280x720 DPR=2 screenshot of the full app UI (3D
viewport, pipeline editor, timeline) with the default caffeine_water scene.
Output: `docs/public/screenshots/hero.png`.
Requires WASM to be built first (`npm run build:wasm`).

## Scripted Zoom Demo Video (storyboard-as-code)

Produces a single continuous **full-frame** webm that walks the live app through
a scripted flow: **show the app → type a prompt → (live AI generate) → rotate the
molecule → switch to the Editor tab to reveal the generated pipeline.** It is
recorded un-zoomed on purpose (zoom/pan/crop in post): a #root CSS zoom while the
pipeline mounts makes ReactFlow mis-measure node handles and the pipeline edges
detach from the nodes, so the recorder stays at the full view to keep them
attached. (The director still supports zoom verbs/`alignTop`/scroll for other
storyboards, but the default storyboard does not use them.)

```
npm run demo:video                                   # no key → prompt typed, generate skipped
ANTHROPIC_API_KEY=sk-ant-... npm run demo:video      # live AI generation (local BYOK)
npm run demo:video -- --no-generate                  # force skip the AI call

# Record the deployed demo site (its built-in LLM proxy runs generation, no key):
npm run demo:video -- --url https://<demo-site>/megane/app/
```

- **Storyboard ("台本"):** `scripts/demo-script.mjs` — a declarative `scenes`
  array (id / zoom / action / hold). Edit it to change the demo; no need to
  touch the engine.
- **Director (engine):** `scripts/demo-video.mjs` — starts Vite, records a webm
  via Playwright `recordVideo`, and zooms by tweening a CSS `transform` on
  `#root`. Verbs: `typePrompt` (type only), `submitPrompt` (submit via Enter,
  then the scene's hold dwells ~30s while the reply streams), `rotate`,
  `showPipeline` (click the Editor tab to reveal the graph).
- **Zoom control:** scene `zoom` is `"full"`, `"keep"`, or
  `{ sel, scale?, pad?, anchorX?, anchorY?, alignTop?, topMargin? }`. The default
  storyboard uses `"full"` everywhere (full-frame recording); the zoom options
  remain available for custom storyboards.
- **Output:** `demo/out/megane-demo-<timestamp>.webm` (gitignored).
- **Options:** `--out <path>`, `--prompt "<text>"`, `--width/--height`, `--dpr`,
  `--no-generate`, `--generate-timeout <ms>`, `--clean`.
- **Run locally:** the script resolves Playwright via the shared
  `tests/e2e/utils/playwright.mjs` helper (prefers the project's own
  `node_modules`), so on a local checkout you only need `npm ci` plus
  `npx playwright install chromium` for the browser. The easiest path is to
  record the live demo site (no WASM build, no API key):
  `npm run demo:video -- --url https://megane.tech-office-mori.com/`.
  To record a local build instead, omit `--url` (it builds WASM and starts Vite);
  live generation there needs `ANTHROPIC_API_KEY` since the local build has no
  LLM proxy.
- **Notes:** `deviceScaleFactor: 2` keeps CSS-zoomed pixels reasonably crisp.
  The pipeline panel defaults to the **Editor** tab, with the AI prompt bar
  (`[data-testid="pipeline-chat-input"]`) docked under the graph. Live generation needs `ANTHROPIC_API_KEY` + network; without
  them the run still completes (prompt typed, generation skipped).

## Promo Video (camera-zoom variant)

`npm run demo:promo` (`scripts/promo-video.mjs`) records a promotional cut of
the same chat → generate → pipeline flow, but with the `#root` screen-zoom
camera kept on throughout (it re-measures ReactFlow handles once at identity so
the zoomed pipeline edges stay attached). Its storyboard is hard-coded in the
script header rather than in `demo-script.mjs`. Options: `--out`, `--url`,
`--prompt`, `--width/--height`, `--dpr`, `--response-wait <ms>`,
`--no-generate`, `--clean`; output goes to `demo/out/megane-promo-<ts>.webm`.

## Prerequisites

- WASM must be built for dev-preview.mjs (it auto-builds if missing)
- capture-screenshots.mjs needs WASM already built (it does not auto-build)
- Both scripts auto-start and auto-stop a Vite dev server

## Cleaning Up
```
make preview-clean
```
Removes the `dev-preview/` directory.
