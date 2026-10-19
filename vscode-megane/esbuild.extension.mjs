// Bundle the extension host into out/.
//
// The extension ships without node_modules (.vscodeignore), so everything it
// needs at runtime is bundled here; `vscode` is provided by the editor. The
// MCP SDK behind the Builder's tool servers is a second bundle,
// out/sdkClient.js, which extension.js loads on the first tool-server
// connection (the `./sdkClient` import stays a runtime `require`), so
// activating the extension does not parse it. The target is the Node.js of
// the oldest VS Code in `engines`, so every supported editor loads
// extension.js; connecting to a tool server needs Node.js 20 (VS Code 1.90,
// see `nodeVersionProblem`).
import { build, context } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node16",
  external: ["vscode", "./sdkClient"],
  // `import("./sdkClient")` becomes `require("./sdkClient")`, resolved beside
  // extension.js; a native import() from CommonJS would need the extension.
  supported: { "dynamic-import": false },
  sourcemap: true,
  logLevel: "info",
};
const bundles = [
  { ...shared, entryPoints: ["src/extension.ts"], outfile: "out/extension.js" },
  { ...shared, entryPoints: ["src/sdkClient.ts"], outfile: "out/sdkClient.js" },
];

if (process.argv.includes("--watch")) {
  for (const options of bundles) await (await context(options)).watch();
} else {
  await Promise.all(bundles.map((options) => build(options)));
}
