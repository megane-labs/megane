/**
 * code-server host emulator for E2E specs.
 *
 * Spawns code-server (a browser-hosted VSCode) with a fixed --user-data-dir,
 * --auth=none, and a per-project workspace, then exposes helpers to drive
 * the resulting Playwright `Page` into opening a file in the megane custom
 * editor or running the Jupyter extension's notebook output.
 *
 * Prereqs: `scripts/install-code-server.sh` must have already installed the
 * binary, the ms-toolsai.jupyter extension, and the megane VSIX. The spec
 * sets MEGANE_E2E_MODE=1 in the spawned env so the extension's webview
 * preamble flips `window.__MEGANE_TEST__ = true` before the bundle loads.
 *
 * The webview iframe traversal is wrapped in `getWebviewFrame()` because
 * code-server's webview shell varies between releases.
 */

import { spawn, ChildProcess } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Frame, Page } from "playwright/test";

import { waitForReady } from "../setup";

/**
 * Write a code-server User/settings.json under `userDataDir` that disables
 * everything that gets in the way of deterministic E2E:
 *   - workbench.startupEditor = "none"  (no welcome / walkthrough tab)
 *   - workbench.editorAssociations  (.pdb / .gro / etc → megane custom editor)
 *   - update.mode / telemetry.telemetryLevel = off
 */
function writeUserSettings(userDataDir: string): void {
  const settingsDir = join(userDataDir, "User");
  mkdirSync(settingsDir, { recursive: true });
  // Resolve a Python interpreter for ms-toolsai.jupyter so that
  // `Notebook: Run All` can dispatch to a kernel without prompting.
  // Prefer the project venv if it exists.
  const venvPython = process.env.MEGANE_E2E_PYTHON ?? "/home/user/megane/.venv/bin/python";
  const settings = {
    "workbench.startupEditor": "none",
    "workbench.editorAssociations": {
      "*.pdb": "megane.structureViewer",
      "*.gro": "megane.structureViewer",
      "*.xyz": "megane.structureViewer",
      "*.mol": "megane.structureViewer",
      "*.sdf": "megane.structureViewer",
      "*.megane.json": "megane.pipelineViewer",
    },
    "update.mode": "none",
    "telemetry.telemetryLevel": "off",
    "security.workspace.trust.enabled": false,
    "extensions.autoCheckUpdates": false,
    "window.commandCenter": false,
    "python.defaultInterpreterPath": venvPython,
    "jupyter.askForKernelRestart": false,
    "jupyter.disableJupyterAutoStart": false,
  };
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2));
}

export interface CodeServerHandle {
  proc: ChildProcess;
  port: number;
  workspace: string;
  userDataDir: string;
}

export interface StartCodeServerOpts {
  port: number;
  workspace: string;
  userDataDir?: string;
  bin?: string;
  e2eMode?: boolean;
  timeoutMs?: number;
}

export function startCodeServer(opts: StartCodeServerOpts): Promise<CodeServerHandle> {
  return new Promise((resolve, reject) => {
    mkdirSync(opts.workspace, { recursive: true });
    // Default to the same `--user-data-dir` that
    // `scripts/install-code-server.sh` writes to (or
    // `MEGANE_CODE_SERVER_DIR` if set), so the megane VSIX + Jupyter
    // extension installed by the script are visible to the spawned
    // process. Per-port directories were causing the spec to come up
    // with no extensions, which in turn meant `.pdb` had no custom editor
    // registered.
    const userDataDir =
      opts.userDataDir ?? process.env.MEGANE_CODE_SERVER_DIR ?? "/tmp/megane-code-server";
    mkdirSync(userDataDir, { recursive: true });
    writeUserSettings(userDataDir);
    const bin = opts.bin ?? process.env.MEGANE_CODE_SERVER_BIN ?? "code-server";

    const proc = spawn(
      bin,
      [
        "--auth",
        "none",
        "--bind-addr",
        `127.0.0.1:${opts.port}`,
        "--user-data-dir",
        userDataDir,
        "--disable-telemetry",
        "--disable-update-check",
        opts.workspace,
      ],
      {
        env: {
          ...process.env,
          MEGANE_E2E_MODE: opts.e2eMode === false ? "0" : "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved)
        reject(new Error(`code-server did not start in ${opts.timeoutMs ?? 90_000}ms`));
    }, opts.timeoutMs ?? 90_000);

    const onData = (data: Buffer) => {
      const line = data.toString();
      if (
        !resolved &&
        (line.includes(`HTTP server listening`) ||
          line.includes(`http://127.0.0.1:${opts.port}`) ||
          line.includes(`http://localhost:${opts.port}`))
      ) {
        resolved = true;
        clearTimeout(timer);
        // code-server needs a beat after the listen log before /healthz is up.
        setTimeout(
          () => resolve({ proc, port: opts.port, workspace: opts.workspace, userDataDir }),
          2000,
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

export function stopCodeServer(handle: CodeServerHandle | null): void {
  if (handle && handle.proc && !handle.proc.killed) {
    handle.proc.kill("SIGTERM");
  }
}

/**
 * Resolve the megane webview frame inside a code-server Page.
 *
 * code-server stacks several iframes per webview: an outer worker
 * extension host iframe, the public-facing webview shell, and the inner
 * `active-frame` that finally owns the extension's HTML. The exact
 * structure shifts between releases, so instead of relying on selector
 * paths we walk every frame on the Page and pick the one that already
 * carries either `__MEGANE_TEST__` or the megane viewer DOM. This is the
 * same strategy used by the legacy `vscode_full_screen.test.mjs`.
 *
 * Returns a real `Frame` (not a `FrameLocator`) so the test helpers can
 * call `evaluate` / `waitForFunction` on this scope.
 */
export async function getWebviewFrame(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<Frame> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const seenUrls = new Set<string>();
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const url = frame.url();
      seenUrls.add(url);
      // Skip the VSCode worker extension host iframe — addInitScript
      // installs `__MEGANE_TEST__=true` on every frame including this
      // one, but it is not a megane renderer and matching it traps the
      // helper on the wrong scope.
      if (url.includes("webWorkerExtensionHostIframe")) continue;
      try {
        const looksLikeMegane = await frame.evaluate(() => {
          // Only the megane bundle sets these markers, regardless of
          // host. Don't match on `__MEGANE_TEST__` alone — many host
          // iframes inherit it from the test runner's `addInitScript`.
          if (document.querySelector('[data-testid="megane-viewer"]')) return true;
          if (document.querySelector('[data-testid="viewer-root"]')) return true;
          const w = window as { __MEGANE_CONTEXT__?: unknown };
          if (w.__MEGANE_CONTEXT__) return true;
          return false;
        });
        if (looksLikeMegane) return frame;
      } catch {
        // Frame is in mid-navigation or detached; ignore and retry.
      }
    }
    await page.waitForTimeout(250);
  }
  // eslint-disable-next-line no-console
  console.error(
    "getWebviewFrame: timed out scanning frames. Saw URLs:",
    JSON.stringify(Array.from(seenUrls), null, 2),
  );
  throw new Error("getWebviewFrame: megane webview frame did not appear in time");
}

export interface OpenVscodeFileOpts {
  port: number;
  /** Path relative to the workspace root, with forward slashes. */
  file: string;
  waitTimeoutMs?: number;
}

/**
 * Navigate to code-server, ensure the workspace is open, and request that
 * the file be opened in the megane custom editor (the default for .pdb /
 * .gro / .xyz / .mol / .sdf / .megane.json given the contributes block in
 * vscode-megane/package.json).
 */
/** Custom editor view type registered by vscode-megane/package.json. */
const MEGANE_CUSTOM_EDITOR_VIEW_TYPE = "megane.structureViewer";

export async function openVscodeFile(page: Page, opts: OpenVscodeFileOpts): Promise<Frame> {
  const url = `http://127.0.0.1:${opts.port}/?folder=${encodeURIComponent("/workspace")}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".monaco-workbench", { timeout: 30_000 });
  // Allow the workbench to settle (file watcher + extensions) before we
  // try to interact with the explorer; otherwise the tree row may be in
  // the DOM but not yet wired up to the keybinding service.
  await page.waitForTimeout(3_000);

  // Open the file from the explorer tree. We deliberately use this over
  // `?payload=openFile` because the URL-based open path bypasses the
  // `customEditors.priority=default` resolution on code-server's web
  // build, while a normal explorer double-click honours it.
  const tree = page.getByRole("treeitem", { name: opts.file, exact: true });
  await tree.waitFor({ state: "visible", timeout: 30_000 });
  await tree.click({ force: true });
  await tree.dblclick({ force: true });

  const wv = await getWebviewFrame(page, { timeoutMs: opts.waitTimeoutMs ?? 60_000 });
  await waitForReady(wv, { needsData: true, timeout: opts.waitTimeoutMs ?? 60_000 });
  return wv;
}

export interface OpenVscodeNotebookOpts extends OpenVscodeFileOpts {
  /** Notebook filename (relative to workspace). */
  notebook: string;
  /** Workspace folder to open (default `/workspace`). */
  folder?: string;
}

/**
 * Open a notebook in code-server, run all cells via the command palette,
 * and return the output cell's webview frame containing the megane
 * widget. Used by widget-vscode.spec.ts.
 */
export async function openVscodeNotebook(page: Page, opts: OpenVscodeNotebookOpts): Promise<Frame> {
  const url = `http://127.0.0.1:${opts.port}/?folder=${encodeURIComponent(opts.folder ?? "/workspace")}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".monaco-workbench", { timeout: 30_000 });
  await page.waitForTimeout(3_000);

  // Open the notebook via the explorer tree — same reasoning as
  // `openVscodeFile`: Ctrl+P-driven file open is unreliable in
  // code-server's web build because the welcome / walkthrough tab eats
  // the focus until the user explicitly closes it.
  const tree = page.getByRole("treeitem", { name: opts.notebook, exact: true });
  await tree.waitFor({ state: "visible", timeout: 30_000 });
  await tree.click({ force: true });
  await tree.dblclick({ force: true });

  await page.waitForSelector(".notebook-editor", { timeout: 60_000 });
  await page.waitForTimeout(2_000);

  // Trigger Run All via the palette. ms-toolsai.jupyter then prompts for
  // a kernel if none is selected; the helper below handles that pop-up
  // and waits for kernel-ready before returning.
  await page.keyboard.press("F1");
  await page.waitForSelector(".quick-input-widget", { timeout: 10_000 });
  await page.keyboard.type("Notebook: Run All", { delay: 20 });
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");

  await handleKernelPickerIfPresent(page);

  const wv = await getWebviewFrame(page, { timeoutMs: opts.waitTimeoutMs ?? 120_000 });
  await waitForReady(wv, { needsData: true, timeout: opts.waitTimeoutMs ?? 120_000 });
  return wv;
}

async function handleKernelPickerIfPresent(page: Page): Promise<void> {
  // Step 1: source picker. We click the "Python Environments..." option
  // directly because pressing Enter on a freshly-spawned QuickInput is
  // racy in code-server's web build (the keypress sometimes lands on the
  // editor instead of the dialog while it is animating in).
  try {
    const source = page.locator(".quick-input-list .monaco-list-row", {
      hasText: "Python Environments",
    });
    await source.first().waitFor({ state: "visible", timeout: 30_000 });
    await source.first().click();
  } catch {
    // No kernel picker — kernel was already selected.
    return;
  }
  // Step 2: environment picker. The recommended env (project venv if
  // python.defaultInterpreterPath is set) is highlighted; click whichever
  // row matches our venv path, falling back to the first option.
  try {
    const envList = page.locator(".quick-input-list .monaco-list-row");
    await envList.first().waitFor({ state: "visible", timeout: 30_000 });
    const venvRow = envList.filter({ hasText: ".venv" }).first();
    if (await venvRow.count()) {
      await venvRow.click();
    } else {
      await envList.first().click();
    }
  } catch {
    // No second prompt — already picked.
  }
  // Give jupyter a beat to spin the kernel up before the cells run.
  await page.waitForTimeout(2_000);
}

async function pickPythonKernel(page: Page): Promise<void> {
  await page.keyboard.press("F1");
  try {
    await page.waitForSelector(".quick-input-widget", { timeout: 10_000 });
  } catch {
    return;
  }
  await page.keyboard.type("Notebook: Select Notebook Kernel", { delay: 20 });
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");

  // Step 1: kernel-source picker. Wait for the placeholder text to flip
  // to "Type to choose a kernel source" before we start typing, so we
  // don't race the previous (command-palette) widget being repurposed.
  await waitForQuickInputPlaceholder(page, /kernel source/i, 15_000).catch(() => {});
  await page.waitForTimeout(500);
  // "Python Environments..." is the highlighted default; just confirm.
  await page.keyboard.press("Enter");

  // Step 2: environment picker. Same idea — wait for placeholder text to
  // change before pressing Enter, otherwise the keypress lands on a
  // stale dialog and the kernel never resolves.
  await waitForQuickInputPlaceholder(page, /select a python|interpreter|kernel/i, 20_000).catch(
    () => {},
  );
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_500);
}

async function waitForQuickInputPlaceholder(
  page: Page,
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (pat: string) => {
      const re = new RegExp(pat, "i");
      const inputs = Array.from(
        document.querySelectorAll<HTMLInputElement>(".quick-input-widget input"),
      );
      return inputs.some((el) => re.test(el.placeholder ?? ""));
    },
    pattern.source,
    { timeout: timeoutMs },
  );
}
