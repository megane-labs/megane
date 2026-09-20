/**
 * Loader for the RDKit embedding module built by scripts/build.sh.
 *
 * The wasm module speaks strings (input, JSON options, JSON result); this file
 * turns that into a typed call and raises the module's error field as a real
 * Error. Run it in a Web Worker in the browser: a large molecule can take
 * hundreds of milliseconds and the call is synchronous.
 */
import createRDKitEmbedModule from "./dist/rdkit-embed.mjs";

/** Deterministic by default so the same sketch embeds to the same geometry. */
const DEFAULT_OPTIONS = { randomSeed: 42 };

/**
 * @param {object} [moduleOptions] Emscripten module options, e.g.
 *   `{ locateFile: (path) => url }` to tell the glue where the .wasm lives.
 */
export async function loadRDKitEmbed(moduleOptions = {}) {
  const module = await createRDKitEmbedModule(moduleOptions);
  return {
    /** RDKit release string, e.g. "2026.03.6". */
    version: () => module.version(),
    /** Route RDKit's own log output to the console (off by default). */
    setVerbose: (verbose) => module.setVerbose(Boolean(verbose)),
    /**
     * Embed a SMILES or MDL mol block in 3D.
     * @param {string} input
     * @param {object} [options] see index.d.ts (EmbedOptions)
     * @returns {object} EmbedResult
     */
    embed(input, options = {}) {
      const merged = { ...DEFAULT_OPTIONS, ...options };
      const result = JSON.parse(module.embed(String(input), JSON.stringify(merged)));
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
  };
}
