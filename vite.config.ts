import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import path from "path";
import { ketcherAlias, ketcherDefine, ketcherRaphaelRequire } from "./vite.ketcher";

/**
 * The npm package a module belongs to, read from its *outermost*
 * `node_modules` segment, or null for app code. A copy nested under another
 * package belongs to that package: `node_modules/miew/node_modules/three/...`
 * is miew's (Ketcher's 3D preview), not the viewer's three.js.
 */
export function packageOf(id: string): string | null {
  const marker = "/node_modules/";
  const at = id.indexOf(marker);
  if (at < 0) return null;
  const [first, second] = id.slice(at + marker.length).split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
}

/**
 * Split the large, stable third-party libraries into their own chunks so the
 * app shell does not ship as a single ~1.8 MB bundle. These deps change far
 * less often than app code, so separating them lets the browser cache them
 * across app releases and parallelize the fetch.
 *
 * Matching on the outermost package matters: every entry modulepreloads these
 * chunks, so a nested dependency matched by substring (miew's three@0.153,
 * pulled in only by the lazily loaded Ketcher sketcher) would be downloaded and
 * evaluated by every viewer visitor as a second three.js.
 */
export function vendorChunk(id: string): string | undefined {
  const pkg = packageOf(id);
  if (pkg === null) return undefined;
  if (pkg === "three") return "vendor-three";
  if (pkg.startsWith("@xyflow/")) return "vendor-reactflow";
  if (pkg.startsWith("@dagrejs/")) return "vendor-dagre";
  if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "vendor-react";
  return undefined;
}

export default defineConfig({
  plugins: [react(), wasm(), ketcherRaphaelRequire()],
  // The parse worker (src/parsers/parse.worker.ts) imports the WASM module, so
  // its sub-build needs vite-plugin-wasm too.
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  assetsInclude: ["**/*.xtc"],
  // Ketcher (megane Builder's sketcher) needs a few Node shims; see vite.ketcher.ts.
  define: ketcherDefine,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      ...ketcherAlias,
    },
  },
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/ws": {
        target: "ws://localhost:8765",
        ws: true,
      },
      "/api": {
        target: "http://localhost:8765",
      },
    },
  },
  build: {
    outDir: "python/megane/static/app",
    rollupOptions: {
      // Three entries: the viewer itself, megane Builder (the structure
      // editor, a separate app at /builder.html), and the two-viewer harness
      // that backs the `multi-instance` Playwright project (issue #672).
      // Naming `input` at all means the implicit index.html default no longer
      // applies, so all must be listed.
      input: {
        main: path.resolve(__dirname, "index.html"),
        builder: path.resolve(__dirname, "builder.html"),
        multiInstance: path.resolve(__dirname, "multi-instance.html"),
      },
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
});
