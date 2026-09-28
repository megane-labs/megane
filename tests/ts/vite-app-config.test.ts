// @vitest-environment node
/**
 * Guards the webapp's vendor chunking (vite.config.ts `manualChunks`).
 *
 * Every entry (viewer, megane Builder) modulepreloads the vendor chunks, so a
 * module wrongly matched into one is downloaded and evaluated on every page
 * load. The matcher used to test `id.includes("/node_modules/three/")`, which
 * also caught `node_modules/miew/node_modules/three/` — a second, older
 * three.js that only Ketcher's lazily loaded 3D preview (miew) imports. It
 * doubled vendor-three and made every viewer print "Multiple instances of
 * Three.js being imported".
 */
import { describe, expect, it } from "vitest";
import appConfig, { packageOf, vendorChunk } from "../../vite.config";

const NM = "/repo/node_modules";

describe("packageOf", () => {
  it.each([
    [`${NM}/three/build/three.module.js`, "three"],
    [`${NM}/three/examples/jsm/lines/LineMaterial.js`, "three"],
    [`${NM}/@xyflow/react/dist/esm/index.js`, "@xyflow/react"],
    [`${NM}/miew/node_modules/three/build/three.module.js`, "miew"],
    [`${NM}/@xyflow/react/node_modules/zustand/esm/vanilla.mjs`, "@xyflow/react"],
    [`\0${NM}/react/index.js?commonjs-es-import`, "react"],
  ])("%s belongs to %s", (id, pkg) => {
    expect(packageOf(id)).toBe(pkg);
  });

  it("returns null for app code and virtual modules", () => {
    expect(packageOf("/repo/src/renderer/MoleculeRenderer.ts")).toBeNull();
    expect(packageOf("\0commonjsHelpers.js")).toBeNull();
  });
});

describe("vendorChunk", () => {
  it.each([
    [`${NM}/three/build/three.core.js`, "vendor-three"],
    [`${NM}/three/examples/jsm/controls/TrackballControls.js`, "vendor-three"],
    [`${NM}/@xyflow/system/dist/esm/index.js`, "vendor-reactflow"],
    [`${NM}/@xyflow/react/node_modules/zustand/esm/vanilla.mjs`, "vendor-reactflow"],
    [`${NM}/@dagrejs/dagre/dist/dagre.esm.js`, "vendor-dagre"],
    [`${NM}/react/cjs/react.production.js`, "vendor-react"],
    [`${NM}/react-dom/cjs/react-dom-client.production.js`, "vendor-react"],
    [`${NM}/scheduler/cjs/scheduler.production.js`, "vendor-react"],
  ])("puts %s in %s", (id, chunk) => {
    expect(vendorChunk(id)).toBe(chunk);
  });

  it.each([
    // A nested copy stays with the package that depends on it.
    `${NM}/miew/node_modules/three/build/three.module.js`,
    // Similarly named packages are not vendor chunk members.
    `${NM}/three-stdlib/index.js`,
    `${NM}/react-router/dist/index.js`,
    `${NM}/zustand/esm/index.mjs`,
    "/repo/src/index.tsx",
  ])("leaves %s to Rollup", (id) => {
    expect(vendorChunk(id)).toBeUndefined();
  });

  it("is the manualChunks function the app build uses", () => {
    const output = appConfig.build?.rollupOptions?.output;
    expect(Array.isArray(output)).toBe(false);
    expect((output as { manualChunks?: unknown }).manualChunks).toBe(vendorChunk);
  });
});
