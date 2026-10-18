/* eslint-disable */
// webpack counterpart of vite.rdkit.ts: megane-rdkit falls back to
// `new URL("megane-rdkit.wasm", import.meta.url)` without a `locateFile`, which
// webpack would emit as a second copy of the 3.5 MB module. megane Builder
// always passes `locateFile`, so the fallback becomes the bare file name.
module.exports = function rdkitNoDefaultWasm(source) {
  return source.replace(
    /new URL\(\s*["']megane-rdkit\.wasm["']\s*,\s*import\.meta\.url\s*\)/g,
    '"megane-rdkit.wasm"'
  );
};
