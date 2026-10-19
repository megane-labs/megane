/** The words and colours a Flow block is shown with. */
import { describe, it, expect } from "vitest";
import { blockSubtitle, blockTitle, runStatusColor, runStatusText } from "@/builder/flow/describe";
import { initialToolParams } from "@/builder/flow/ports";
import { IDLE_RUN, type FlowParams } from "@/builder/flow/types";
import { LIB_WATER, tools, waterData } from "./helpers";

const smiles: FlowParams = {
  type: "molecule",
  source: "smiles",
  smiles: "CCO",
  libraryId: "",
  name: "",
};
const lib: FlowParams = { ...smiles, source: "library", libraryId: LIB_WATER.id };

describe("blockTitle / blockSubtitle", () => {
  it("names each kind of block", () => {
    const tool = initialToolParams(tools.liquid_box);
    expect(blockTitle(smiles, null)).toBe("Molecule");
    expect(blockTitle({ type: "document" }, null)).toBe("Manual structure");
    expect(blockTitle(tool, tools.liquid_box)).toBe("Liquid box");
    expect(blockTitle({ ...tool, label: "Old" }, null)).toBe("Old");
    expect(blockTitle({ ...tool, label: "" }, null)).toBe("liquid_box");
  });

  it("says what each block is set to", () => {
    expect(blockSubtitle(smiles, [])).toBe("SMILES CCO");
    expect(blockSubtitle({ ...smiles, smiles: " " }, [])).toBe("No SMILES yet");
    expect(blockSubtitle(lib, [LIB_WATER])).toBe("water (H2O)");
    expect(blockSubtitle({ ...lib, name: "SOL" }, [LIB_WATER])).toBe("SOL (H2O)");
    expect(blockSubtitle(lib, [])).toBe("No molecule chosen");
    expect(blockSubtitle({ type: "document" }, [])).toContain("Manual mode");
    expect(blockSubtitle(initialToolParams(tools.solvate), [])).toBe("Tool server");
  });
});

describe("runStatusText / runStatusColor", () => {
  it("describes every state", () => {
    expect(runStatusText(IDLE_RUN)).toBe("Not run yet");
    expect(runStatusText({ ...IDLE_RUN, status: "stale" })).toContain("run again");
    expect(runStatusText({ ...IDLE_RUN, status: "running" })).toBe("Running…");
    expect(runStatusText({ ...IDLE_RUN, status: "running", message: "packing" })).toBe("packing");
    expect(runStatusText({ ...IDLE_RUN, status: "running", fraction: 0.42 })).toBe("Running… 42%");
    expect(runStatusText({ ...IDLE_RUN, status: "done", data: waterData() })).toBe("3 atoms");
    expect(
      runStatusText({
        ...IDLE_RUN,
        status: "done",
        data: { ...waterData(), snapshot: { ...waterData().snapshot, nAtoms: 1 } },
      }),
    ).toBe("1 atom");
    expect(runStatusText({ ...IDLE_RUN, status: "done", warnings: ["w"] })).toBe(
      "0 atoms · warnings",
    );
    expect(runStatusText({ ...IDLE_RUN, status: "error", error: "boom" })).toBe("boom");
    expect(runStatusText({ ...IDLE_RUN, status: "error" })).toBe("Failed");
  });

  it("colours every state", () => {
    const colors = (["idle", "stale", "running", "done", "error"] as const).map((status) =>
      runStatusColor({ ...IDLE_RUN, status }),
    );
    expect(new Set(colors).size).toBe(5);
    expect(runStatusColor({ ...IDLE_RUN, status: "done", warnings: ["w"] })).toBe("#f59e0b");
  });
});
