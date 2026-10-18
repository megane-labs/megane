/**
 * Build setting for bundles that ship megane Builder's RDKit worker
 * (`src/builder/library/embed.worker.ts`).
 *
 * megane-rdkit falls back to `new URL("megane-rdkit.wasm", import.meta.url)`
 * when it is given no `locateFile`, and Vite turns that into a second copy of
 * the 3.5 MB module inside the worker build (inlined as a data URL in library
 * mode). The Builder always passes `locateFile` (`embed.ts` resolves the URL
 * on the main thread), so the fallback is replaced by the bare file name.
 */
import type { Plugin } from "vite";

export function rdkitNoDefaultWasm(): Plugin {
  return {
    name: "megane-rdkit-no-default-wasm",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("megane-rdkit") || !code.includes("megane-rdkit.wasm")) return null;
      return {
        code: code.replace(
          /new URL\(\s*["']megane-rdkit\.wasm["']\s*,\s*import\.meta\.url\s*\)/g,
          '"megane-rdkit.wasm"',
        ),
        map: null,
      };
    },
  };
}
