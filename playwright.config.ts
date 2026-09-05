/**
 * Playwright configuration for megane cross-platform E2E.
 *
 * Projects:
 *   - webapp           — Vite dev server (initial render + interaction matrix)
 *   - widget-jupyterlab — anywidget under JupyterLab
 *   - widget-vscode    — anywidget under code-server (Jupyter extension)
 *   - jupyterlab-doc   — JupyterLab DocWidget direct-open path
 *   - vscode           — VSCode custom editor under code-server
 *   - contract         — minimal Viewport contract baseline + Parity
 *
 * Notes:
 *   - retries: 0 — flake is not papered over with retries; failures must
 *     surface and be addressed at the source (mask UI noise, fix race).
 *   - fullyParallel: 'webapp' and 'contract' only. Host-emulator projects
 *     (code-server, JupyterLab) run with workers: 1 to keep ports stable.
 */

import { defineConfig } from "playwright/test";

const PORT_WEBAPP = Number(process.env.MEGANE_E2E_PORT_WEBAPP ?? 15173);

/** Hosts the Phase 2 cross-host matrix targets. */
const PHASE2_HOSTS = [
  "webapp",
  "jupyterlab-doc",
  "vscode",
  "widget-jupyterlab",
  "widget-vscode",
] as const;
type Phase2Host = (typeof PHASE2_HOSTS)[number];

/** Per-host Playwright timeout (ms). VSCode is slowest; webapp is fastest. */
const HOST_TIMEOUT_MS: Record<Phase2Host, number> = {
  webapp: 60_000,
  "jupyterlab-doc": 180_000,
  vscode: 240_000,
  "widget-jupyterlab": 180_000,
  "widget-vscode": 240_000,
};

/** Build matrix entries `<feature>__<host>` for a given feature spec. */
function phase2Matrix(feature: string, testMatch: RegExp) {
  return PHASE2_HOSTS.map((host) => ({
    name: `${feature}__${host}`,
    testMatch,
    timeout: HOST_TIMEOUT_MS[host],
    metadata: { meganeHost: host },
    use: host === "webapp" ? { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` } : {},
  }));
}

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["junit", { outputFile: "playwright-report/junit.xml" }], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    launchOptions: {
      args: [
        // GitHub Actions ubuntu-latest runners only allocate 64MB to
        // /dev/shm, which headless Chromium can exhaust when loading
        // our ~300KB WASM bundle alongside Three.js textures. The
        // resulting silent renderer crash leaves __megane_test_ready
        // never set, which is what was causing the webapp / contract
        // specs to time out on waitForReady in CI.
        "--disable-dev-shm-usage",
      ],
    },
  },

  projects: [
    {
      name: "webapp",
      testMatch: /webapp\.spec\.ts$/,
      use: {
        baseURL: `http://127.0.0.1:${PORT_WEBAPP}`,
      },
    },
    {
      // Two <MeganeViewer>s on one page, each in its own <MeganeProvider>
      // (issue #672). Served from the multi-instance.html Vite entry.
      name: "multi-instance",
      testMatch: /multi-instance\.spec\.ts$/,
      use: {
        baseURL: `http://127.0.0.1:${PORT_WEBAPP}`,
      },
    },
    {
      name: "contract",
      testMatch: /contract\.spec\.ts$/,
      use: {
        baseURL: `http://127.0.0.1:${PORT_WEBAPP}`,
      },
    },
    {
      name: "widget-jupyterlab",
      testMatch: /widget-jupyterlab\.spec\.ts$/,
      timeout: 180_000,
    },
    {
      name: "widget-examples",
      testMatch: /widget-examples\.spec\.ts$/,
      timeout: 240_000,
    },
    {
      name: "widget-vscode",
      testMatch: /widget-vscode\.spec\.ts$/,
      timeout: 240_000,
    },
    {
      name: "jupyterlab-doc",
      testMatch: /jupyterlab-doc\.spec\.ts$/,
      timeout: 180_000,
    },
    {
      name: "vscode",
      testMatch: /(^|\/)vscode\.spec\.ts$/,
      timeout: 240_000,
    },

    // ── Feature specs ─────────────────────────────────────────────────
    // These run against the same prebuilt webapp as `webapp` / `contract`,
    // unless they boot their own JupyterLab/code-server host.
    {
      name: "format-loading",
      testMatch: /format-loading\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "playback",
      testMatch: /playback\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "heterogeneous-traj",
      testMatch: /heterogeneous-traj\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "trajectory-bonds-vdw-leak",
      testMatch: /trajectory-bonds-vdw-leak\.spec\.ts$/,
      timeout: 120_000,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "sidebar",
      testMatch: /sidebar\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "licorice",
      testMatch: /licorice\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "illustrative",
      testMatch: /illustrative\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "water-line",
      testMatch: /water-line\.spec\.ts$/,
      timeout: 120_000,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "widget-api",
      testMatch: /widget-api\.spec\.ts$/,
      timeout: 240_000,
    },
    {
      name: "pipeline-editor",
      testMatch: /pipeline-editor\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "inspector",
      testMatch: /inspector\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "pipeline-file",
      testMatch: /pipeline-file\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "render-modal",
      testMatch: /render-modal\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      // Renders bench/llm's reference pipelines from serialized JSON and
      // compares them against water-line's committed baselines. Webapp only.
      name: "bench-golden",
      testMatch: /bench-golden\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "resname-filter-opacity",
      testMatch: /resname-filter-opacity\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "atom-bond-junction",
      testMatch: /atom-bond-junction\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },
    {
      name: "templates",
      testMatch: /templates\.spec\.ts$/,
      use: { baseURL: `http://127.0.0.1:${PORT_WEBAPP}` },
    },

    // ── Phase 2 cross-host matrix ────────────────────────────────────
    // Each Phase 2 spec runs against all 5 hosts via metadata.meganeHost.
    // Specs read the host from test.info().project.metadata.meganeHost
    // (or fall back to MEGANE_HOST env var for single-project filtered runs).
    ...phase2Matrix("modify-node", /modify-node\.spec\.ts$/),
    ...phase2Matrix("camera", /camera\.spec\.ts$/),
    ...phase2Matrix("measurement", /measurement\.spec\.ts$/),
    ...phase2Matrix("subsystem-rendering", /subsystem-rendering\.spec\.ts$/),
    ...phase2Matrix("trajectory-bonds", /trajectory-bonds\.spec\.ts$/),
  ],

  webServer: process.env.MEGANE_E2E_NO_WEBSERVER
    ? undefined
    : {
        // Tiny Node static server over the prebuilt webapp. We deliberately
        // do NOT use `vite` (dev mode) here because in CI the on-demand
        // module / WASM transformation aborts the process within seconds
        // for reasons we can't diagnose from outside the runner. The
        // bundled output in `python/megane/static/app/` is fully static —
        // serving it via Node's built-in http module is rock-stable.
        command: `node tests/e2e/lib/serve-static.mjs python/megane/static/app ${PORT_WEBAPP} 127.0.0.1`,
        port: PORT_WEBAPP,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
