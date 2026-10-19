/** The inlined React Flow stylesheet stays the package's own. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { REACT_FLOW_BASE_CSS } from "@/builder/flow/reactFlowCss";

describe("REACT_FLOW_BASE_CSS", () => {
  it("matches @xyflow/react/dist/base.css (refresh the copy after upgrading @xyflow/react)", () => {
    const css = readFileSync(
      join(process.cwd(), "node_modules/@xyflow/react/dist/base.css"),
      "utf8",
    );
    expect(REACT_FLOW_BASE_CSS).toBe(css);
  });
});
