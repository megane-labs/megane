// @vitest-environment node
/**
 * Guards the settings shared by megane's Vite configs (vite.shared.ts) and
 * that every config which used to repeat them still picks them up.
 */
import path from "path";
import { describe, expect, it } from "vitest";
import type { Alias, Plugin, PluginOption } from "vite";
import {
  aliasEntries,
  forbidWorkerFiles,
  inlineEmbedWorkerAlias,
  inlineParseWorkerAlias,
  inlineWasmWorker,
  prodDefine,
  repoRoot,
  selfContainedKetcherAlias,
  srcAlias,
  syncParseAlias,
  vscodeModules,
  wasmWorker,
  WORKER_FROM_FILE,
} from "../../vite.shared";
import appConfig from "../../vite.config";
import docsDemoConfig from "../../vite.docs-demo.config";
import widgetConfig from "../../vite.widget.config";
import libConfig from "../../vite.lib.config";
import builderWidgetConfig from "../../vite.builder-widget.config";
import vscodeWebviewConfig from "../../vscode-megane/vite.webview.config";
import vscodeBuilderConfig from "../../vscode-megane/vite.builder.config";

const ROOT = path.resolve(__dirname, "../..");

function aliases(config: { resolve?: { alias?: unknown } }): Alias[] {
  const alias = config.resolve?.alias;
  expect(Array.isArray(alias)).toBe(true);
  return alias as Alias[];
}

function pluginNames(plugins: PluginOption[]): string[] {
  return (plugins.flat(Infinity as 1) as Plugin[]).map((p) => p.name);
}

describe("vite.shared helpers", () => {
  it("resolves paths against the repo root", () => {
    expect(repoRoot).toBe(ROOT);
  });

  it("srcAlias maps @ to src/", () => {
    expect(srcAlias()).toEqual({ find: "@", replacement: path.join(ROOT, "src") });
  });

  it("syncParseAlias swaps ./parseClient for the synchronous client", () => {
    const alias = syncParseAlias();
    const find = alias.find as RegExp;
    expect(find).toBeInstanceOf(RegExp);
    expect(find.test("./parseClient")).toBe(true);
    expect(find.test("../parseClient")).toBe(true);
    expect(find.test("./parseClientSync")).toBe(false);
    expect(alias.replacement).toBe(path.join(ROOT, "src/parsers/parseClientSync.ts"));
  });

  it("inlineParseWorkerAlias builds the parse worker inline", () => {
    const alias = inlineParseWorkerAlias();
    const find = alias.find as RegExp;
    expect(find.test("./parse.worker?worker")).toBe(true);
    expect(find.test("./parse.worker?worker&inline")).toBe(false);
    expect(find.test("./embed.worker?worker")).toBe(false);
    expect(alias.replacement).toBe(
      path.join(ROOT, "src/parsers/parse.worker.ts") + "?worker&inline",
    );
  });

  it("inlineWasmWorker folds dynamic imports into the worker", () => {
    const worker = inlineWasmWorker();
    expect(worker.format).toBe("es");
    expect(pluginNames(worker.plugins!())).toEqual(["vite-plugin-wasm"]);
    expect(worker.rollupOptions?.output).toEqual({ inlineDynamicImports: true });
    expect(pluginNames(inlineWasmWorker(() => [{ name: "extra" }]).plugins!())).toEqual([
      "vite-plugin-wasm",
      "extra",
    ]);
  });

  it("inlineEmbedWorkerAlias builds the RDKit worker inline", () => {
    const alias = inlineEmbedWorkerAlias();
    const find = alias.find as RegExp;
    expect(find.test("./embed.worker?worker")).toBe(true);
    expect(find.test("./embed.worker?worker&inline")).toBe(false);
    expect(find.test("./parse.worker?worker")).toBe(false);
    expect(alias.replacement).toBe(
      path.join(ROOT, "src/builder/library/embed.worker.ts") + "?worker&inline",
    );
  });

  it("selfContainedKetcherAlias swaps Ketcher's binaryWasm build for the default one", () => {
    const alias = selfContainedKetcherAlias();
    const find = alias.find as RegExp;
    expect(find.test("ketcher-standalone/dist/binaryWasm")).toBe(true);
    expect(find.test("ketcher-standalone/dist/binaryWasmNoRender")).toBe(false);
    expect(find.test("ketcher-standalone")).toBe(false);
    expect(alias.replacement).toBe("ketcher-standalone");
  });

  it("WORKER_FROM_FILE spots a worker started from a file, not from a blob:", () => {
    // Vite's non-inline `?worker` and ketcher-standalone's binaryWasm build, minified.
    expect(
      WORKER_FROM_FILE.test(
        'function f(n){return new Worker(""+new URL("assets/embed.worker-x.js",import.meta.url).href,{type:"module"})}',
      ),
    ).toBe(true);
    expect(
      WORKER_FROM_FILE.test(
        'X=new Worker(new URL(""+new URL("assets/indigoWorker-x.js",import.meta.url).href,import.meta.url),{type:"module"})',
      ),
    ).toBe(true);
    expect(WORKER_FROM_FILE.test('new SharedWorker(new URL("./w.js", import.meta.url))')).toBe(
      true,
    );
    // Vite's library mode: a path from the consuming app's site root.
    expect(
      WORKER_FROM_FILE.test('return new Worker(\n    "/assets/decode.worker-x.js",\n    { name })'),
    ).toBe(true);
    // Vite's inline worker falls back to a data: URL; a blob: literal is inline too.
    expect(
      WORKER_FROM_FILE.test(
        'new Worker("data:text/javascript;charset=utf-8,"+encodeURIComponent(s))',
      ),
    ).toBe(false);
    expect(WORKER_FROM_FILE.test("new Worker('blob:x/1')")).toBe(false);
    // Vite's inline worker, gif.js and ketcher-standalone's default build start from blob: URLs.
    expect(WORKER_FROM_FILE.test('const t=new Worker(e,{type:"module",name:n})')).toBe(false);
    expect(WORKER_FROM_FILE.test("E=new Worker(S.options.workerScript)")).toBe(false);
    expect(WORKER_FROM_FILE.test("return new Worker(url, options);")).toBe(false);
  });

  it("forbidWorkerFiles fails a build whose chunk starts a worker from a file", () => {
    const plugin = forbidWorkerFiles();
    expect(plugin.name).toBe("megane-forbid-worker-files");
    expect(plugin.apply).toBe("build");
    const generateBundle = plugin.generateBundle as (
      this: { error: (msg: string) => never },
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    const ctx = {
      error: (msg: string): never => {
        throw new Error(msg);
      },
    };
    const ok = {
      "builder.js": { type: "chunk", fileName: "builder.js", code: "new Worker(e,{})" },
      "a.wasm": { type: "asset", fileName: "a.wasm", source: "new Worker(new URL(" },
    };
    expect(() => generateBundle.call(ctx, {}, ok)).not.toThrow();
    const bad = {
      "k.js": {
        type: "chunk",
        fileName: "k.js",
        code: 'new Worker(new URL("w.js",import.meta.url))',
      },
    };
    expect(() => generateBundle.call(ctx, {}, bad)).toThrow(
      /k\.js starts a Web Worker from a file beside the bundle/,
    );
  });

  it("aliasEntries turns a record into ordered alias entries", () => {
    expect(aliasEntries({ a: "/x", b: "/y" })).toEqual([
      { find: "a", replacement: "/x" },
      { find: "b", replacement: "/y" },
    ]);
    expect(aliasEntries({})).toEqual([]);
  });

  it("prodDefine pins process.env.NODE_ENV to production", () => {
    expect(prodDefine).toEqual({ "process.env.NODE_ENV": '"production"' });
  });

  it("wasmWorker builds ES workers with vite-plugin-wasm", () => {
    const worker = wasmWorker();
    expect(worker.format).toBe("es");
    const plugins = worker.plugins!();
    expect(pluginNames(plugins)).toEqual(["vite-plugin-wasm"]);
    // A fresh plugin list for every worker build.
    expect(worker.plugins!()[0]).not.toBe(plugins[0]);
  });

  it("wasmWorker appends extra worker plugins after the wasm plugin", () => {
    const worker = wasmWorker(() => [{ name: "extra" }]);
    expect(pluginNames(worker.plugins!())).toEqual(["vite-plugin-wasm", "extra"]);
  });

  it("vscodeModules lists vscode-megane's node_modules, then the root's", () => {
    expect(vscodeModules()).toEqual([
      path.join(ROOT, "vscode-megane/node_modules"),
      path.join(ROOT, "node_modules"),
    ]);
  });
});

describe("Vite configs use the shared settings", () => {
  const src = srcAlias();
  const sync = syncParseAlias();

  it("vscode-megane/vite.webview.config parses in an inline wasm worker", () => {
    const list = aliases(vscodeWebviewConfig);
    expect(list).toEqual([inlineParseWorkerAlias(), src]);
    expect(pluginNames(vscodeWebviewConfig.plugins!)).toContain("megane-forbid-worker-files");
    expect(vscodeWebviewConfig.base).toBe("./");
    expect(vscodeWebviewConfig.worker?.format).toBe("es");
    expect(vscodeWebviewConfig.worker?.rollupOptions?.output).toEqual({
      inlineDynamicImports: true,
    });
    expect(pluginNames(vscodeWebviewConfig.worker!.plugins!())).toEqual(["vite-plugin-wasm"]);
    expect(vscodeWebviewConfig.define).toMatchObject(prodDefine);
  });

  it.each([
    ["vite.config", appConfig],
    ["vite.docs-demo.config", docsDemoConfig],
  ])("%s aliases @ and Ketcher's shims, with a wasm worker", (_name, config) => {
    const list = aliases(config);
    expect(list[0]).toEqual(src);
    expect(list.map((a) => a.find)).toContain("events");
    expect(list.some((a) => String(a.find) === String(sync.find))).toBe(false);
    expect(config.worker?.format).toBe("es");
    expect(pluginNames(config.worker!.plugins!())).toEqual(["vite-plugin-wasm"]);
  });

  it.each([
    ["vite.widget.config", widgetConfig],
    ["vite.lib.config", libConfig],
    ["vite.builder-widget.config", builderWidgetConfig],
    ["vscode-megane/vite.builder.config", vscodeBuilderConfig],
  ])("%s parses on the main thread in production mode", (_name, config) => {
    const list = aliases(config);
    expect(list[0]).toEqual(sync);
    expect(list).toContainEqual(src);
    expect(config.define).toMatchObject(prodDefine);
  });

  it.each([
    ["vscode-megane/vite.webview.config", vscodeWebviewConfig],
    ["vscode-megane/vite.builder.config", vscodeBuilderConfig],
  ])("%s resolves dependencies from both node_modules roots", (_name, config) => {
    expect(config.resolve?.modules).toEqual(vscodeModules());
  });

  it("the VSCode Builder worker keeps the RDKit transform after the wasm plugin", () => {
    expect(pluginNames(vscodeBuilderConfig.worker!.plugins!())).toEqual([
      "vite-plugin-wasm",
      "megane-rdkit-no-default-wasm",
    ]);
  });

  it("the VSCode Builder starts no worker from a file: RDKit inline, Ketcher self-contained", () => {
    const list = aliases(vscodeBuilderConfig);
    expect(list).toContainEqual(inlineEmbedWorkerAlias());
    expect(list).toContainEqual(selfContainedKetcherAlias());
    expect(vscodeBuilderConfig.worker?.rollupOptions?.output).toEqual({
      inlineDynamicImports: true,
    });
    expect(pluginNames(vscodeBuilderConfig.plugins!)).toContain("megane-forbid-worker-files");
  });

  it("the Builder widget inlines the RDKit worker too", () => {
    expect(aliases(builderWidgetConfig)).toContainEqual(inlineEmbedWorkerAlias());
  });

  it.each([
    ["vite.lib.config", libConfig],
    ["vite.widget.config", widgetConfig],
    ["vite.builder-widget.config", builderWidgetConfig],
    ["vscode-megane/vite.webview.config", vscodeWebviewConfig],
    ["vscode-megane/vite.builder.config", vscodeBuilderConfig],
  ])("%s refuses to start a worker from a file beside the bundle", (_name, config) => {
    expect(pluginNames(config.plugins!)).toContain("megane-forbid-worker-files");
  });
});
