/**
 * JupyterLab host emulator for E2E specs.
 *
 * Spawns `jupyter lab` in a deterministic mode (token auth, no browser, fixed
 * port) and exposes helpers for writing+opening notebooks. Both
 * `widget-jupyterlab.spec.ts` and `jupyterlab-doc.spec.ts` consume this so
 * the boot logic is not duplicated. Keep behaviour-preserving with what each
 * spec previously hand-rolled.
 */

import { spawn, ChildProcess } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Page } from "playwright/test";

import { waitForReady } from "../setup";

export interface JupyterLabHandle {
  proc: ChildProcess;
  port: number;
  token: string;
  notebookDir: string;
}

export interface StartJupyterLabOpts {
  port: number;
  token: string;
  notebookDir: string;
  /** JUPYTER_RUNTIME_DIR override; isolates parallel projects from each other. */
  runtimeDir?: string;
  /** Working directory for the spawned process; defaults to repo root inferred from cwd. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Writes user settings that keep Lab's own chrome out of the pixel baselines.
 *
 * `fetchNews` defaults to "none", which makes Lab pop a "Would you like to get
 * notified about official Jupyter news?" toast over the bottom-right of the
 * page. It lands whenever it wins the race with the first capture, so it shows
 * up as an intermittent full-page/viewer-region diff rather than an honest
 * failure. "false" declines the news feed without asking.
 *
 * Returns the directory to hand to JUPYTERLAB_SETTINGS_DIR.
 */
function writeQuietLabSettings(port: number): string {
  const dir = `/tmp/megane-jupyter-settings-${port}`;
  const pluginDir = join(dir, "@jupyterlab", "apputils-extension");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "notification.jupyterlab-settings"),
    JSON.stringify({ fetchNews: "false", checkForUpdates: false, doNotDisturbMode: true }, null, 2),
  );
  return dir;
}

export function startJupyterLab(opts: StartJupyterLabOpts): Promise<JupyterLabHandle> {
  return new Promise((resolve, reject) => {
    mkdirSync(opts.notebookDir, { recursive: true });
    const settingsDir = writeQuietLabSettings(opts.port);
    const proc = spawn(
      "jupyter",
      [
        "lab",
        "--no-browser",
        "--allow-root",
        `--port=${opts.port}`,
        `--IdentityProvider.token=${opts.token}`,
        "--PasswordIdentityProvider.hashed_password=",
        "--ServerApp.allow_origin=*",
        `--notebook-dir=${opts.notebookDir}`,
      ],
      {
        cwd: opts.cwd ?? process.cwd(),
        env: {
          ...process.env,
          JUPYTER_RUNTIME_DIR: opts.runtimeDir ?? `/tmp/megane-jupyter-runtime-${opts.port}`,
          JUPYTERLAB_SETTINGS_DIR: settingsDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) reject(new Error(`JupyterLab did not start in ${opts.timeoutMs ?? 60_000}ms`));
    }, opts.timeoutMs ?? 60_000);

    const onData = (data: Buffer) => {
      const line = data.toString();
      if (
        !resolved &&
        (line.includes(`http://127.0.0.1:${opts.port}`) ||
          line.includes(`http://localhost:${opts.port}`) ||
          line.includes("Jupyter Server"))
      ) {
        resolved = true;
        clearTimeout(timer);
        // Lab needs a moment after the URL banner before /lab is reachable.
        setTimeout(
          () =>
            resolve({ proc, port: opts.port, token: opts.token, notebookDir: opts.notebookDir }),
          1500,
        );
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

export function stopJupyterLab(handle: JupyterLabHandle | null): void {
  if (handle && handle.proc && !handle.proc.killed) {
    handle.proc.kill("SIGTERM");
  }
}

export interface NotebookSpec {
  cells: Array<{
    cell_type: "code" | "markdown";
    source: string[];
    metadata?: Record<string, unknown>;
    outputs?: unknown[];
    execution_count?: number | null;
  }>;
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

const DEFAULT_NOTEBOOK_METADATA = {
  kernelspec: {
    display_name: "Python 3 (ipykernel)",
    language: "python",
    name: "python3",
  },
};

export function writeNotebook(notebookDir: string, name: string, body: NotebookSpec): string {
  const file = join(notebookDir, `${name}.ipynb`);
  const full = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: DEFAULT_NOTEBOOK_METADATA,
    ...body,
    cells: body.cells.map((c) => ({
      metadata: {},
      outputs: [],
      execution_count: null,
      ...c,
    })),
  };
  writeFileSync(file, JSON.stringify(full, null, 2));
  return file;
}

export interface OpenLabNotebookOpts {
  port: number;
  token: string;
  notebook: string;
  /** Wait gates passed through to waitForReady. */
  waitForData?: boolean;
  waitTimeoutMs?: number;
  /**
   * Trigger Run All Cells (default). Pass false to render only the outputs
   * and widget state saved in the notebook, as its recipient first sees it.
   */
  runAll?: boolean;
}

/**
 * Open a notebook in JupyterLab and trigger Run All Cells (unless `runAll` is false). Waits for the
 * megane renderer's testMode ready signal. Sets `__MEGANE_TEST__=true` via
 * page.addInitScript.
 *
 * The boot is retried once: on a cold or busy runner the Run All menu click
 * can race the kernel start, in which case the first cell silently fails and
 * the widget output never mounts (`__megane_test_ready` stays null). A page
 * reload with a fresh Run All recovers that state, so a single transient
 * race no longer fails the whole spec (the widget-api CI flake).
 */
export async function openLabNotebook(page: Page, opts: OpenLabNotebookOpts): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  // `reset` query forces JupyterLab to discard saved layout from a previous run.
  const url = `http://127.0.0.1:${opts.port}/lab/tree/${opts.notebook}?token=${opts.token}&test=1&reset`;

  const bootOnce = async (waitTimeoutMs: number): Promise<void> => {
    await page.waitForSelector("#jp-main-dock-panel", { timeout: 30_000 });

    // Wait for the kernel to settle before triggering Run All. The toolbar
    // kernel name appearing is the coarse gate; the execution indicator
    // reporting "idle" is the precise one (best-effort — the selector is
    // JupyterLab-version-dependent, so a miss only skips the extra wait).
    await page
      .locator(".jp-Toolbar")
      .filter({ hasText: "Python 3" })
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
    await page
      .locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]')
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});

    if (opts.runAll ?? true) {
      // Run All via the menu bar.
      await page.locator(".lm-MenuBar-itemLabel", { hasText: /^Run$/ }).first().click();
      await page
        .locator(".lm-Menu-itemLabel", { hasText: /Run All Cells/ })
        .first()
        .click();
    }

    await waitForReady(page, {
      needsData: opts.waitForData ?? true,
      timeout: waitTimeoutMs,
    });
  };

  const totalTimeout = opts.waitTimeoutMs ?? 90_000;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  try {
    await bootOnce(Math.max(30_000, Math.floor(totalTimeout / 2)));
  } catch {
    // One retry from a clean page: reload discards the wedged notebook
    // session and Run All executes against a settled kernel.
    await page.reload({ waitUntil: "domcontentloaded" });
    await bootOnce(totalTimeout);
  }
}

/**
 * Open a file directly via the JupyterLab DocWidget path (i.e. not via a
 * notebook). Used by `jupyterlab-doc.spec.ts` and the cross-host feature
 * specs that target the DocWidget.
 */
export async function openLabFile(
  page: Page,
  opts: { port: number; token: string; file: string; waitTimeoutMs?: number },
): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  const url = `http://127.0.0.1:${opts.port}/lab/tree/${opts.file}?token=${opts.token}&test=1&reset`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#jp-main-dock-panel", { timeout: 30_000 });
  await waitForReady(page, { needsData: true, timeout: opts.waitTimeoutMs ?? 60_000 });
}
