/**
 * Settings repeated across megane's Vite configs (the app, docs demo, anywidget
 * bundles, npm library, and the two VSCode webview bundles), kept in one place
 * so the bundles cannot drift apart. Like vite.ketcher.ts and vite.rdkit.ts,
 * it lives at the repo root; the VSCode configs import it as `../vite.shared`.
 *
 * Every path is resolved against the repo root, so a config's own location
 * (repo root or `vscode-megane/`) does not matter.
 */
import path from "path";
import { fileURLToPath } from "url";
import wasm from "vite-plugin-wasm";
import type { Alias, Plugin, PluginOption, UserConfig } from "vite";

/** Absolute path of the repository root (the directory holding this file). */
export const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** `resolve.alias` entry: `@/…` → `src/…` (mirrors `paths` in tsconfig.json). */
export function srcAlias(): Alias {
  return { find: "@", replacement: path.resolve(repoRoot, "src") };
}

/**
 * `resolve.alias` entry for single-file bundles: replace `./parseClient` (which
 * spawns the parse Web Worker through a Vite `?worker` import) with the
 * synchronous main-thread client, so the bundle needs no embedded worker.
 * jupyterlab-megane/webpack.config.js does the same swap with webpack's
 * NormalModuleReplacementPlugin.
 */
export function syncParseAlias(): Alias {
  return {
    find: /\.\/parseClient$/,
    replacement: path.resolve(repoRoot, "src/parsers/parseClientSync.ts"),
  };
}

/**
 * `resolve.alias` entry for the VSCode viewer webview: build the parse worker
 * inline (`?worker&inline`, a blob: script inside the bundle) instead of as a
 * file beside it, because a worker in a webview cannot load scripts from the
 * extension's resource origin. Pair it with {@link inlineWasmWorker}, which
 * folds the WASM glue into the worker.
 */
export function inlineParseWorkerAlias(): Alias {
  return {
    find: /^\.\/parse\.worker\?worker$/,
    replacement: path.resolve(repoRoot, "src/parsers/parse.worker.ts") + "?worker&inline",
  };
}

/**
 * `resolve.alias` entry: build megane Builder's RDKit worker inline
 * (`?worker&inline`) instead of as a file beside the bundle — for the
 * single-file Builder widget, and for the VS Code Builder, whose workers
 * cannot rely on reaching the extension's resource origin
 * (src/utils/workerAssets.ts). `embed.ts` then hands the worker the `.wasm`
 * as a `blob:` URL the page fetched.
 */
export function inlineEmbedWorkerAlias(): Alias {
  return {
    find: /^\.\/embed\.worker\?worker$/,
    replacement: path.resolve(repoRoot, "src/builder/library/embed.worker.ts") + "?worker&inline",
  };
}

/**
 * `resolve.alias` entry for the VS Code Builder: Ketcher's default
 * `ketcher-standalone` build in place of `ketcher-standalone/dist/binaryWasm`.
 * The default build carries its Indigo worker inline, with the `.wasm` inside
 * it, so the worker fetches nothing; `binaryWasm` starts the worker from a
 * file beside the bundle and has it fetch an 11 MB `.wasm`, both from the
 * extension's resource origin (src/utils/workerAssets.ts).
 */
export function selfContainedKetcherAlias(): Alias {
  return { find: /^ketcher-standalone\/dist\/binaryWasm$/, replacement: "ketcher-standalone" };
}

/**
 * A worker started from a file beside the bundle, as Vite emits a non-inline
 * worker and as dependencies write it: `new Worker(new URL(…))`, after
 * minification also `new Worker(""+new URL(…).href)`, and in library mode
 * `new Worker("/assets/….js")`. Not a `blob:` or `data:` URL, which is how
 * an inline worker starts.
 */
export const WORKER_FROM_FILE =
  /new\s+(?:Shared)?Worker\(\s*(?:(?:""\s*\+\s*)?new\s+URL\(|["'`](?!blob:|data:))/;

/**
 * Plugin for the bundles that run where a worker file beside them cannot be
 * relied on: the VS Code webviews (a worker reaches the extension's resource
 * origin only until the webview's service worker restarts, see
 * src/utils/workerAssets.ts), the Jupyter widgets (one ES module loaded by
 * anywidget, with nothing beside it) and the npm library (a file in
 * `dist/assets/` is requested from the root of the app that installed the
 * package). Fails the build when a chunk starts a Web Worker from such a
 * file: such a worker passes a quick test and fails for a user.
 */
export function forbidWorkerFiles(): Plugin {
  return {
    name: "megane-forbid-worker-files",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "chunk" && WORKER_FROM_FILE.test(file.code)) {
          this.error(
            `${file.fileName} starts a Web Worker from a file beside the bundle, which this ` +
              "bundle's hosts cannot load reliably: build the worker inline " +
              "(`?worker&inline`) and fetch its assets on the page (src/utils/workerAssets.ts).",
          );
        }
      }
    },
  };
}

/** Turn a `{ find: replacement }` record (e.g. `ketcherAlias`) into alias entries. */
export function aliasEntries(record: Record<string, string>): Alias[] {
  return Object.entries(record).map(([find, replacement]) => ({ find, replacement }));
}

/** `define` entries for bundles that inline React & co. as production builds. */
export const prodDefine = { "process.env.NODE_ENV": JSON.stringify("production") };

/**
 * `worker` options for builds whose workers import the megane WASM module (the
 * parse worker), so the worker sub-build needs vite-plugin-wasm too. `extra`
 * appends further worker plugins; it is a factory because Vite asks for a
 * fresh plugin list for every worker it builds.
 */
export function wasmWorker(
  extra: () => PluginOption[] = () => [],
): NonNullable<UserConfig["worker"]> {
  return {
    format: "es",
    plugins: () => [wasm(), ...extra()],
  };
}

/**
 * {@link wasmWorker} for an inline worker: the WASM glue, which the parse worker
 * imports dynamically, goes into the worker itself, since a blob: worker
 * cannot resolve a chunk by relative URL.
 */
export function inlineWasmWorker(
  extra: () => PluginOption[] = () => [],
): NonNullable<UserConfig["worker"]> {
  return { ...wasmWorker(extra), rollupOptions: { output: { inlineDynamicImports: true } } };
}

/**
 * `resolve.modules` for the VSCode configs: dependencies come from both
 * `vscode-megane/node_modules` and the repo root's `node_modules`.
 */
export function vscodeModules(): string[] {
  return [
    path.resolve(repoRoot, "vscode-megane/node_modules"),
    path.resolve(repoRoot, "node_modules"),
  ];
}
