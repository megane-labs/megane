import { describe, it, expect } from "vitest";
import { summarizeNodeParams } from "@/pipeline/nodeSummary";
import { defaultParams, NODE_TYPE_LABELS } from "@/pipeline/types";
import type { PipelineNodeParams, PipelineNodeType } from "@/pipeline/types";

function params<T extends PipelineNodeType>(
  type: T,
  overrides: Record<string, unknown> = {},
): PipelineNodeParams {
  return { ...defaultParams(type), ...overrides } as PipelineNodeParams;
}

describe("summarizeNodeParams", () => {
  it("returns a non-empty one-liner for every node type's defaults", () => {
    for (const type of Object.keys(NODE_TYPE_LABELS) as PipelineNodeType[]) {
      const summary = summarizeNodeParams(params(type));
      expect(summary, type).toBeTypeOf("string");
      expect(summary.length, type).toBeGreaterThan(0);
      expect(summary, type).not.toContain("\n");
    }
  });

  it("names the loaded file, or says none is loaded", () => {
    expect(summarizeNodeParams(params("load_structure"))).toBe("No file");
    expect(summarizeNodeParams(params("load_structure", { fileName: "1ubq.pdb" }))).toBe(
      "1ubq.pdb",
    );
    expect(
      summarizeNodeParams(
        params("load_structure", { fileName: "a.pdb", edits: [{ op: "x" }, { op: "y" }] }),
      ),
    ).toBe("a.pdb · 2 edits");
    expect(summarizeNodeParams(params("load_trajectory"))).toBe("No trajectory");
    expect(summarizeNodeParams(params("load_trajectory", { source: "structure" }))).toBe(
      "Frames from structure",
    );
    expect(summarizeNodeParams(params("load_volumetric", { fileName: "esp.cube" }))).toBe(
      "esp.cube",
    );
  });

  it("shows filter queries, defaulting to all atoms", () => {
    expect(summarizeNodeParams(params("filter", { query: "" }))).toBe("All atoms");
    expect(summarizeNodeParams(params("filter", { query: 'element == "O"' }))).toBe(
      'element == "O"',
    );
    expect(
      summarizeNodeParams(params("filter", { query: "", bond_query: "both element == C" })),
    ).toBe("All atoms · bonds: both element == C");
  });

  it("formats numeric parameters compactly", () => {
    expect(summarizeNodeParams(params("modify", { scale: 1, opacity: 0.5 }))).toBe(
      "Scale 1 · Opacity 50%",
    );
    expect(summarizeNodeParams(params("modify", { scale: 1.25, opacity: 0 }))).toBe(
      "Scale 1.25 · Opacity 0%",
    );
    expect(summarizeNodeParams(params("replicate", { nx: 2, ny: 3, nz: 1 }))).toBe("2 × 3 × 1");
    expect(summarizeNodeParams(params("vector_overlay", { scale: 2 }))).toBe("Scale 2");
  });

  it("describes the bond source", () => {
    expect(summarizeNodeParams(params("add_bond", { bondSource: "structure" }))).toBe(
      "From structure",
    );
    expect(
      summarizeNodeParams(params("add_bond", { bondSource: "file", bondFileName: "t.prmtop" })),
    ).toBe("From file: t.prmtop");
    expect(summarizeNodeParams(params("add_bond", { bondSource: "distance", vdwScale: 0.6 }))).toBe(
      "By distance ×0.60",
    );
    expect(
      summarizeNodeParams(params("add_bond", { bondSource: "distance", vdwScale: undefined })),
    ).toBe("By distance");
    expect(summarizeNodeParams(params("add_bond", { bondSource: "none" }))).toBe("None");
  });

  it("covers the remaining modes and toggles", () => {
    expect(summarizeNodeParams(params("viewport", { perspective: true }))).toBe("Perspective");
    expect(summarizeNodeParams(params("viewport", { perspective: false }))).toBe("Orthographic");
    expect(summarizeNodeParams(params("streaming", { connected: true }))).toBe("Connected");
    expect(summarizeNodeParams(params("streaming", { connected: false }))).toBe("Disconnected");
    expect(summarizeNodeParams(params("wrap", { mode: "unwrap" }))).toBe("unwrap");
    expect(summarizeNodeParams(params("color", { mode: "byChain" }))).toBe("byChain");
    expect(summarizeNodeParams(params("color", { mode: "uniform", uniformColor: "#ff8800" }))).toBe(
      "uniform #ff8800",
    );
    expect(summarizeNodeParams(params("label_generator", { source: "resname" }))).toBe(
      "Label by resname",
    );
    expect(
      summarizeNodeParams(params("polyhedron_generator", { opacity: 0.5, showEdges: true })),
    ).toBe("Opacity 50% · edges");
    expect(
      summarizeNodeParams(params("polyhedron_generator", { opacity: 1, showEdges: false })),
    ).toBe("Opacity 100%");
    expect(
      summarizeNodeParams(
        params("isosurface", { isoLevel: 0.03, showNegative: true, colorMode: "solid" }),
      ),
    ).toBe("Level 0.03 ± · solid");
    expect(
      summarizeNodeParams(
        params("isosurface", { isoLevel: 1, showNegative: false, colorMode: "volume" }),
      ),
    ).toBe("Level 1 · volume");
    expect(summarizeNodeParams(params("spectrum_plot", { reverseX: true }))).toBe(
      "Reversed x axis",
    );
    expect(summarizeNodeParams(params("spectrum_plot", { reverseX: false }))).toBe("Normal x axis");
    expect(
      summarizeNodeParams(
        params("drawing_boundary", { xMin: 0, xMax: 1, yMin: -0.5, yMax: 1.5, zMin: 0, zMax: 2 }),
      ),
    ).toBe("a 0–1, b -0.50–1.50, c 0–2");
  });
});
