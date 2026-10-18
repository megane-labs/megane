/**
 * Start Web Workers whose script lives on another origin.
 *
 * A VS Code webview runs on a `vscode-webview://` origin while its scripts are
 * served from the extension's resource origin, and `new Worker(url)` refuses a
 * cross-origin script outright. Bundled code creates its workers from such
 * URLs: megane Builder's RDKit worker and Ketcher's Indigo worker are both
 * `new Worker(new URL("…", import.meta.url), { type: "module" })`.
 *
 * `installCrossOriginWorker` replaces `Worker` with a subclass that, for a
 * cross-origin URL, starts the worker from a same-origin `blob:` script that
 * imports the real one (`import "<url>"` for a module worker,
 * `importScripts("<url>")` for a classic one). The imported module keeps its
 * real `import.meta.url`, so the worker still finds its `.wasm` beside it.
 * Same-origin, `blob:` and `data:` URLs are passed through untouched.
 */

type WorkerCtor = new (url: string | URL, options?: WorkerOptions) => Worker;

const INSTALLED = Symbol.for("megane.crossOriginWorker");

/**
 * The URL to start a worker from: `url` itself when the page may load it
 * directly, else a `blob:` URL of a bootstrap script that imports it.
 */
export function workerBootstrapUrl(
  url: string | URL,
  options: WorkerOptions | undefined,
  pageUrl: string,
  createObjectURL: (blob: Blob) => string = (b) => URL.createObjectURL(b),
): string | URL {
  let resolved: URL;
  try {
    resolved = new URL(String(url), pageUrl);
  } catch {
    return url;
  }
  if (resolved.protocol === "blob:" || resolved.protocol === "data:") return url;
  let pageOrigin: string | null = null;
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    pageOrigin = null;
  }
  if (pageOrigin !== null && pageOrigin !== "null" && resolved.origin === pageOrigin) return url;
  const href = JSON.stringify(resolved.href);
  const source = options?.type === "module" ? `import ${href};\n` : `importScripts(${href});\n`;
  return createObjectURL(new Blob([source], { type: "text/javascript" }));
}

/**
 * Replace `target.Worker` with the cross-origin-capable subclass. Idempotent;
 * a no-op where there is no `Worker`.
 */
export function installCrossOriginWorker(
  target: { Worker?: unknown; location?: { href: string } } = globalThis as never,
): void {
  const Native = target.Worker as (WorkerCtor & { [INSTALLED]?: true }) | undefined;
  if (!Native || Native[INSTALLED]) return;
  class CrossOriginWorker extends Native {
    static readonly [INSTALLED] = true as const;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(workerBootstrapUrl(url, options, target.location?.href ?? "about:blank"), options);
    }
  }
  target.Worker = CrossOriginWorker;
}
