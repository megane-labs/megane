/** The words, icons and colours a Flow block is shown with. */
import { describe, it, expect } from "vitest";
import {
  STRUCTURE_COLOR,
  blockCategory,
  blockColor,
  blockIcon,
  blockName,
  blockSettings,
  blockSummary,
  blockTitle,
  runStatusColor,
  runStatusDot,
  runStatusText,
} from "@/builder/flow/describe";
import { initialToolParams } from "@/builder/flow/ports";
import { IDLE_RUN, type FlowParams } from "@/builder/flow/types";
import { DATA_TYPE_COLORS, NODE_CATEGORY_COLORS } from "@/pipeline/types";
import { LIB_WATER, tools, waterData } from "./helpers";

const smiles: FlowParams = {
  type: "molecule",
  source: "smiles",
  smiles: "CCO",
  libraryId: "",
  name: "",
};
const lib: FlowParams = { ...smiles, source: "library", libraryId: LIB_WATER.id };
const tool = initialToolParams(tools.liquid_box);
const done = { ...IDLE_RUN, status: "done" as const, data: waterData() };

describe("block categories", () => {
  it("draws inputs as data loaders and tools as modifiers, wires as particle data", () => {
    expect(blockCategory(smiles)).toBe("data_load");
    expect(blockCategory({ type: "document" })).toBe("data_load");
    expect(blockCategory(tool)).toBe("modify");
    expect(blockColor(tool)).toBe(NODE_CATEGORY_COLORS.modify);
    expect(blockIcon(smiles)).toBeTruthy();
    expect(STRUCTURE_COLOR).toBe(DATA_TYPE_COLORS.particle);
  });
});

describe("blockTitle / blockSettings / blockName / blockSummary", () => {
  it("names each kind of block", () => {
    expect(blockTitle(smiles, null)).toBe("Molecule");
    expect(blockTitle({ type: "document" }, null)).toBe("Manual structure");
    expect(blockTitle(tool, tools.liquid_box)).toBe("Liquid box");
    expect(blockTitle({ ...tool, label: "Old" }, null)).toBe("Old");
    expect(blockTitle({ ...tool, label: "" }, null)).toBe("liquid_box");
  });

  it("says what each block is set to", () => {
    expect(blockSettings(smiles, [])).toBe("SMILES CCO");
    expect(blockSettings({ ...smiles, smiles: " " }, [])).toBe("No SMILES yet");
    expect(blockSettings(lib, [LIB_WATER])).toBe("water (H2O)");
    expect(blockSettings({ ...lib, name: "SOL" }, [LIB_WATER])).toBe("SOL (H2O)");
    expect(blockSettings(lib, [])).toBe("No molecule chosen");
    expect(blockSettings({ type: "document" }, [])).toBe("From Manual mode");
    expect(blockSettings(tool, [])).toBe("");
  });

  it("names a block's structure before it runs", () => {
    expect(blockName({ ...smiles, name: " EtOH " }, null, [])).toBe("EtOH");
    expect(blockName(smiles, null, [])).toBe("CCO");
    expect(blockName(lib, null, [LIB_WATER])).toBe("water");
    expect(blockName(lib, null, [])).toBe("Molecule");
    expect(blockName({ type: "document" }, null, [])).toBe("Manual structure");
    expect(blockName(tool, tools.liquid_box, [])).toBe("Liquid box");
  });

  it("puts the settings and the last run on the card's line", () => {
    expect(blockSummary(smiles, IDLE_RUN, [])).toBe("SMILES CCO");
    expect(blockSummary(smiles, done, [])).toBe("SMILES CCO · 3 atoms");
    expect(blockSummary(tool, IDLE_RUN, [])).toBe("Not run yet");
    expect(blockSummary(tool, { ...IDLE_RUN, status: "error", error: "x" }, [])).toBe("Failed");
  });
});

describe("runStatusText / runStatusColor / runStatusDot", () => {
  it("describes every state", () => {
    expect(runStatusText(IDLE_RUN)).toBe("Not run yet");
    expect(runStatusText({ ...IDLE_RUN, status: "stale" })).toContain("run again");
    expect(runStatusText({ ...IDLE_RUN, status: "running" })).toBe("Running…");
    expect(runStatusText({ ...IDLE_RUN, status: "running", message: "packing" })).toBe("packing");
    expect(runStatusText({ ...IDLE_RUN, status: "running", fraction: 0.42 })).toBe("Running… 42%");
    expect(runStatusText(done)).toBe("3 atoms");
    expect(
      runStatusText({
        ...done,
        data: { ...waterData(), snapshot: { ...waterData().snapshot, nAtoms: 1 } },
      }),
    ).toBe("1 atom");
    expect(runStatusText({ ...IDLE_RUN, status: "done", warnings: ["w"] })).toBe(
      "0 atoms · warnings",
    );
    expect(runStatusText({ ...IDLE_RUN, status: "error", error: "boom" })).toBe("boom");
    expect(runStatusText({ ...IDLE_RUN, status: "error" })).toBe("Failed");
  });

  it("colours every state, and dots every state but idle", () => {
    const colors = (["idle", "stale", "running", "done", "error"] as const).map((status) =>
      runStatusColor({ ...IDLE_RUN, status }),
    );
    expect(new Set(colors).size).toBe(5);
    expect(runStatusColor({ ...IDLE_RUN, status: "done", warnings: ["w"] })).toBe("#f59e0b");
    expect(runStatusDot(IDLE_RUN)).toBeNull();
    expect(runStatusDot({ ...done, warnings: ["tolerance"] })).toEqual({
      color: "#f59e0b",
      title: "3 atoms · warnings\ntolerance",
      testId: "builder-flow-node-status",
    });
  });
});
