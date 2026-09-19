/**
 * Build settings megane Builder's sketcher needs, shared by every Vite config
 * that bundles `builder.html` (the app build and the docs demo).
 *
 * Ketcher (`ketcher-react` + `ketcher-standalone`) is written for webpack
 * with Node polyfills: `ketcher-core` imports Node's `events`, one of its ESM
 * files keeps a CommonJS `require('raphael')`, and `ketcher-react` reads
 * `global` at module init. Each is patched here at build time so the
 * lazily loaded sketcher chunk actually starts in the browser.
 */
import path from "path";
import { fileURLToPath } from "url";
import type { Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Rewrite ketcher-core's bare `require('raphael')` into a static import. */
export function ketcherRaphaelRequire(): Plugin {
  return {
    name: "megane-ketcher-raphael-require",
    transform(code, id) {
      if (!id.includes("ketcher-core") || !code.includes("require('raphael')")) return null;
      return {
        code:
          `import __meganeRaphael from "raphael";\n` +
          code.replace("require('raphael')", "__meganeRaphael"),
        map: null,
      };
    },
  };
}

/** `resolve.alias` entries: Node's `events` → the browser shim package. */
export const ketcherAlias = {
  events: path.resolve(here, "node_modules/events/events.js"),
};

/** `define` entries: Node's `global`. */
export const ketcherDefine = { global: "globalThis" };
