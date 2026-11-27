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
  /** An extra Jupyter config file (`--config`), e.g. to enable a server extension. */
  configFile?: string;
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
        ...(opts.configFile ? [`--config=${opts.configFile}`] : []),
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
 * How long Run All may go without finishing a code cell before a boot is
 * abandoned. A healthy boot finishes its first cell within a few seconds.
 */
const RUN_ALL_STALL_MS = 15_000;

/** How long the notebook's kernel session may take to appear and connect. */
const KERNEL_CONNECT_MS = 30_000;

/**
 * How long the kernel may take to answer the page's own kernel_info_request
 * once the page has connected to it. A healthy kernel answers in under a
 * second; JupyterLab itself stops waiting after a few seconds and goes on.
 */
const KERNEL_INFO_REPLY_MS = 10_000;

/** How long no new connection to the kernel may open before its answers are trusted. */
const KERNEL_SETTLE_MS = 1_000;

/** Boots tried before the notebook is reported as failed. */
const MAX_BOOTS = 3;

/** One kernel-channel websocket the page opened. */
interface KernelSocket {
  kernelId: string;
  openedAt: number;
  closed: boolean;
  /** A kernel_info_reply came back on this socket. */
  answered: boolean;
}

/**
 * Record the page's kernel websockets and whether the kernel has answered
 * on each.
 *
 * JupyterLab sends a kernel_info_request on the shell channel as soon as it
 * connects to a kernel, so a kernel_info_reply on the same socket proves that
 * the page's shell channel reaches the kernel and back. Every Run All stall
 * logged here (cells left `[*]:`, kernel idle, no execute request run) came
 * from a connection whose very first shell request was never answered, while
 * its control channel and iopub still worked. The page cannot tell: it stops
 * waiting for the reply after a few seconds and queues the cells anyway.
 */
function trackKernelSockets(page: Page): KernelSocket[] {
  const sockets: KernelSocket[] = [];
  page.on("websocket", (ws) => {
    const match = ws.url().match(/\/api\/kernels\/([^/?]+)\/channels/);
    if (!match) return;
    const socket: KernelSocket = {
      kernelId: match[1],
      openedAt: Date.now(),
      closed: false,
      answered: false,
    };
    sockets.push(socket);
    const onFrame = ({ payload }: { payload: string | Buffer }) => {
      const text = typeof payload === "string" ? payload : payload.toString("latin1");
      if (/"msg_type":\s*"kernel_info_reply"/.test(text)) {
        socket.answered = true;
        // Widget comms send large frames; stop inspecting once answered.
        ws.off("framereceived", onFrame);
      }
    };
    ws.on("framereceived", onFrame);
    ws.on("close", () => {
      socket.closed = true;
    });
  });
  return sockets;
}

interface LabSession {
  id: string;
  path: string;
  kernel?: { id: string } | null;
}

async function labApi(opts: OpenLabNotebookOpts, path: string, method = "GET"): Promise<Response> {
  return fetch(`http://127.0.0.1:${opts.port}${path}`, {
    method,
    headers: { Authorization: `token ${opts.token}` },
  });
}

async function findNotebookSession(opts: OpenLabNotebookOpts): Promise<LabSession | undefined> {
  try {
    const res = await labApi(opts, "/api/sessions");
    if (!res.ok) return undefined;
    const sessions = (await res.json()) as LabSession[];
    return sessions.find((s) => s.path === opts.notebook);
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve once the notebook's kernel has answered the page on its shell
 * channel (see trackKernelSockets). Throws when no session or connection
 * appears within KERNEL_CONNECT_MS, or the kernel does not answer within
 * KERNEL_INFO_REPLY_MS of the page connecting.
 */
async function waitForKernelChannel(
  sockets: KernelSocket[],
  opts: OpenLabNotebookOpts,
): Promise<void> {
  const connectDeadline = Date.now() + KERNEL_CONNECT_MS;
  let kernelId: string | undefined;
  while (!kernelId) {
    kernelId = (await findNotebookSession(opts))?.kernel?.id;
    if (kernelId) break;
    if (Date.now() > connectDeadline) {
      throw new Error(`no kernel session for ${opts.notebook} within ${KERNEL_CONNECT_MS} ms`);
    }
    await sleep(250);
  }
  // JupyterLab opens a few short-lived connections to a new kernel next to
  // the notebook's own, and nothing on the wire says which one the notebook
  // keeps. So every open connection must have been answered: a dead notebook
  // connection holds the gate shut once the short-lived ones close.
  for (;;) {
    const mine = sockets.filter((s) => s.kernelId === kernelId);
    const live = mine.filter((s) => !s.closed);
    const waiting = live.filter((s) => !s.answered);
    // The connections open within about half a second of each other; let
    // KERNEL_SETTLE_MS pass after the last one so none is still to come.
    const settled = Date.now() - Math.max(...mine.map((s) => s.openedAt)) >= KERNEL_SETTLE_MS;
    if (live.length > 0 && waiting.length === 0 && settled) return;
    if (waiting.some((s) => Date.now() - s.openedAt > KERNEL_INFO_REPLY_MS)) {
      throw new Error(
        `kernel ${kernelId} did not answer kernel_info on the page's connection within ${KERNEL_INFO_REPLY_MS} ms`,
      );
    }
    if (live.length === 0 && Date.now() > connectDeadline) {
      throw new Error(
        `the page did not connect to kernel ${kernelId} within ${KERNEL_CONNECT_MS} ms`,
      );
    }
    await sleep(100);
  }
}

/**
 * Shut down the notebook's kernel session, so that the next page load starts
 * a fresh kernel that has run nothing. A retry that only reconnected to the
 * old kernel left the server holding the dead connection's buffered channels,
 * and once drew a cell output 209 px taller than its baseline.
 */
async function shutDownNotebookSession(opts: OpenLabNotebookOpts): Promise<void> {
  const session = await findNotebookSession(opts);
  if (!session) return;
  try {
    await labApi(opts, `/api/sessions/${session.id}`, "DELETE");
  } catch {
    // The next boot fails on its own if the server is gone.
  }
}

/**
 * Resolve once Run All has made progress: a code cell finished (its prompt
 * changed to `[n]:`) or the viewer reported ready. Throws after `timeout`.
 *
 * A safety net behind waitForKernelChannel: if a connection that answered
 * kernel_info still drops the execute requests, the boot is abandoned after
 * `timeout` instead of waiting out the ready timeout.
 */
async function waitForRunAllProgress(
  page: Page,
  promptsBefore: string[],
  timeout: number,
): Promise<void> {
  try {
    await page.waitForFunction(
      (before: string[]) => {
        if ((window as { __megane_test_ready?: unknown }).__megane_test_ready) return true;
        const prompts = document.querySelectorAll(".jp-CodeCell .jp-InputPrompt");
        return [...prompts].some((p, i) => {
          const text = p.textContent ?? "";
          return /\[\d+\]/.test(text) && text !== before[i];
        });
      },
      promptsBefore,
      { timeout, polling: 250 },
    );
  } catch {
    throw new Error(`Run All finished no cell within ${timeout} ms`);
  }
}

/**
 * Open a notebook in JupyterLab and trigger Run All Cells (unless `runAll` is false). Waits for the
 * megane renderer's testMode ready signal. Sets `__MEGANE_TEST__=true` via
 * page.addInitScript.
 *
 * Before Run All, the boot waits until the notebook's kernel has answered the
 * page on its shell channel (waitForKernelChannel). A boot that fails there,
 * stalls in Run All (waitForRunAllProgress), or whose widget never mounts is
 * retried on a fresh kernel: the session is shut down and the page reloaded.
 * Up to MAX_BOOTS boots are tried; all but the last give up early.
 */
export async function openLabNotebook(page: Page, opts: OpenLabNotebookOpts): Promise<void> {
  await page.addInitScript(() => {
    (globalThis as { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__ = true;
  });
  // `reset` query forces JupyterLab to discard saved layout from a previous run.
  const url = `http://127.0.0.1:${opts.port}/lab/tree/${opts.notebook}?token=${opts.token}&test=1&reset`;
  const runAll = opts.runAll ?? true;
  const sockets = trackKernelSockets(page);

  const bootOnce = async (waitTimeoutMs: number, stallMs?: number): Promise<void> => {
    await page.waitForSelector("#jp-main-dock-panel", { timeout: 30_000 });

    if (runAll) {
      await waitForKernelChannel(sockets, opts);
      const promptsBefore = await page
        .locator(".jp-CodeCell .jp-InputPrompt")
        .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
      // Run All via the menu bar.
      await page.locator(".lm-MenuBar-itemLabel", { hasText: /^Run$/ }).first().click();
      await page
        .locator(".lm-Menu-itemLabel", { hasText: /Run All Cells/ })
        .first()
        .click();
      if (stallMs !== undefined) await waitForRunAllProgress(page, promptsBefore, stallMs);
    }

    await waitForReady(page, {
      needsData: opts.waitForData ?? true,
      timeout: waitTimeoutMs,
    });
  };

  const totalTimeout = opts.waitTimeoutMs ?? 90_000;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  for (let boot = 1; ; boot++) {
    const last = boot === MAX_BOOTS;
    try {
      await bootOnce(
        last ? totalTimeout : Math.max(30_000, Math.floor(totalTimeout / 2)),
        last ? undefined : RUN_ALL_STALL_MS,
      );
      return;
    } catch (e) {
      if (last) throw e;
      console.warn(
        `openLabNotebook: boot ${boot} of ${opts.notebook} failed (${(e as Error).message.split("\n")[0]}); retrying on a fresh kernel`,
      );
      await page.goto("about:blank");
      await shutDownNotebookSession(opts);
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
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
