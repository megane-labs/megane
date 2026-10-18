import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import { prodDefine, srcAlias, syncParseAlias } from "./vite.shared";

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: [
      // npm library bundle: use the synchronous main-thread parse path so the
      // published bundle stays self-contained without an embedded Web Worker.
      syncParseAlias(),
      srcAlias(),
    ],
  },
  define: prodDefine,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, "src/lib.ts"),
      formats: ["es"],
      fileName: () => "lib.js",
    },
    rollupOptions: {
      // Match subpaths too (react/jsx-runtime, react-dom/client,
      // three/examples/jsm/*): exact-string externals leaked
      // react/jsx-runtime into the bundle, baking in the building React's
      // element symbol (react.transitional.element on React 19) and crashing
      // React 18 hosts with "Objects are not valid as a React child".
      external: [/^react($|\/)/, /^react-dom($|\/)/, /^three($|\/)/],
    },
    minify: true,
    sourcemap: false,
  },
});
