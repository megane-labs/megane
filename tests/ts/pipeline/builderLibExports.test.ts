/**
 * The npm library entry (`megane-viewer/lib`, `src/lib.ts`) must re-export
 * every builder node class, so a node added to the builder is also usable
 * from the package. `Viewport` is exported as `ViewportNode` to avoid
 * clashing with the React `Viewport` component.
 *
 * Reads the entry as text: importing it would pull in the whole React viewer
 * (and its worker `?raw` imports) just to check a re-export list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILDER_NODE_CLASSES } from "@/pipeline/builder";

const LIB_SOURCE = readFileSync(resolve(__dirname, "../../../src/lib.ts"), "utf8");

function builderReExports(): Set<string> {
  const block = /export\s*\{([^}]*)\}\s*from\s*"\.\/pipeline\/builder";/.exec(LIB_SOURCE);
  if (!block) throw new Error("src/lib.ts has no value re-export from ./pipeline/builder");
  return new Set(
    block[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+as\s+/)[0]),
  );
}

describe("megane-viewer/lib builder exports", () => {
  it("re-exports Pipeline and every builder node class", () => {
    const exported = builderReExports();
    expect(exported).toContain("Pipeline");
    for (const [type, Cls] of Object.entries(BUILDER_NODE_CLASSES)) {
      expect(exported, `${type} (${Cls.name}) is not exported from src/lib.ts`).toContain(Cls.name);
    }
    expect(LIB_SOURCE).toMatch(/Viewport as ViewportNode/);
  });
});
