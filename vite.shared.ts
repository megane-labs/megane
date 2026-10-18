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
import type { Alias, PluginOption, UserConfig } from "vite";

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
 * `resolve.modules` for the VSCode configs: dependencies come from both
 * `vscode-megane/node_modules` and the repo root's `node_modules`.
 */
export function vscodeModules(): string[] {
  return [
    path.resolve(repoRoot, "vscode-megane/node_modules"),
    path.resolve(repoRoot, "node_modules"),
  ];
}
