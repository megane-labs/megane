/** The inlined React Flow stylesheet stays the package's own. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { REACT_FLOW_CSS } from "@/components/graph/reactFlowCss";

describe("REACT_FLOW_CSS", () => {
  it("matches @xyflow/react/dist/style.css (refresh the copy after upgrading @xyflow/react)", () => {
    const css = readFileSync(
      join(process.cwd(), "node_modules/@xyflow/react/dist/style.css"),
      "utf8",
    );
    expect(REACT_FLOW_CSS).toBe(css);
  });
});
