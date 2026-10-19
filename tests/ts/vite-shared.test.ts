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
  prodDefine,
  repoRoot,
  srcAlias,
  syncParseAlias,
  vscodeModules,
  wasmWorker,
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

  it("vscode-megane/vite.webview.config parses in a wasm worker resolved beside the bundle", () => {
    const list = aliases(vscodeWebviewConfig);
    expect(list).toEqual([src]);
    expect(vscodeWebviewConfig.base).toBe("./");
    expect(vscodeWebviewConfig.worker?.format).toBe("es");
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
});
