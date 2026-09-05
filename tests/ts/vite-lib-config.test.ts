// @vitest-environment node
/**
 * Guards the npm library bundle's external boundary (vite.lib.config.ts).
 *
 * The externals must match *subpaths*, not just exact package names: with
 * exact strings, `react/jsx-runtime` (emitted by the automatic JSX transform)
 * was bundled, baking the building React's element symbol
 * (`react.transitional.element` on React 19) into `dist/lib.js` — React 18
 * hosts then crashed with "Objects are not valid as a React child".
 *
 * The anywidget bundle (vite.widget.config.ts) is the opposite: it must stay
 * fully self-contained (no externals), because anywidget loads it as a single
 * ESM file with no bare-import resolution.
 */
import { describe, expect, it } from "vitest";
import libConfig from "../../vite.lib.config";
import widgetConfig from "../../vite.widget.config";

function getExternal(config: typeof libConfig): (string | RegExp)[] {
  const external = config.build?.rollupOptions?.external;
  expect(Array.isArray(external)).toBe(true);
  return external as (string | RegExp)[];
}

function isExternal(patterns: (string | RegExp)[], id: string): boolean {
  return patterns.some((p) => (typeof p === "string" ? p === id : p.test(id)));
}

describe("vite.lib.config externals", () => {
  const external = getExternal(libConfig);

  it.each([
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom",
    "react-dom/client",
    "three",
    "three/examples/jsm/controls/TrackballControls.js",
    "three/examples/jsm/lines/LineMaterial.js",
  ])("externalizes %s", (id) => {
    expect(isExternal(external, id)).toBe(true);
  });

  it.each([
    // Similarly-prefixed packages must stay bundled/resolved normally.
    "react-router",
    "three-stdlib",
    "@xyflow/react",
    "zustand",
    "gif.js",
  ])("does not externalize %s", (id) => {
    expect(isExternal(external, id)).toBe(false);
  });
});

describe("vite.widget.config self-containment", () => {
  it("declares no externals — the anywidget bundle must be self-contained", () => {
    expect(widgetConfig.build?.rollupOptions?.external).toBeUndefined();
  });
});
