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
  fmt,
  runStatusColor,
  runStatusDot,
  runStatusLabel,
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
    expect(blockTitle(smiles, null)).toBe("Molecule: CCO");
    expect(blockTitle({ ...smiles, smiles: "" }, null)).toBe("Molecule");
    expect(blockTitle({ ...smiles, name: "EtOH" }, null)).toBe("Molecule: EtOH");
    expect(blockTitle(lib, null, [LIB_WATER])).toBe("Molecule: water");
    expect(blockTitle(lib, null, [])).toBe("Molecule");
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
      hollow: false,
      ariaLabel: "Done, with warnings: 3 atoms · warnings",
    });
    // Stale is not a warning: a hollow grey ring, labelled as out of date.
    const stale = runStatusDot({ ...done, status: "stale" })!;
    expect(stale.color).not.toBe("#f59e0b");
    expect(stale.hollow).toBe(true);
    expect(stale.ariaLabel).toContain("Out of date");
  });
});

describe("built-in blocks", () => {
  const crystal: FlowParams = {
    type: "crystal",
    structure: "rocksalt",
    elements: ["Na", "", ""],
    a: 5.64,
    covera: 1.6,
    cubic: true,
  };
  const polymer: FlowParams = { type: "polymer", repeatUnit: "*CC*", length: 20, name: "PE" };
  const supercell: FlowParams = { type: "supercell", repeat: [2, 3, 4] };
  const slab: FlowParams = {
    type: "slab",
    miller: [1, 1, 0],
    layers: 1,
    vacuum: 10,
    repeat: [2, 2],
  };
  const adsorb: FlowParams = { type: "adsorb", height: 2.5, grid: [3, 3] };

  it("draws the blocks that start a structure as data loads, the rest as modifiers", () => {
    expect(blockCategory(crystal)).toBe("data_load");
    expect(blockCategory(polymer)).toBe("data_load");
    expect(blockCategory(supercell)).toBe("modify");
    expect(blockCategory(slab)).toBe("modify");
    expect(blockCategory(adsorb)).toBe("modify");
  });

  it("titles each block and sums up its settings", () => {
    expect([crystal, polymer, supercell, slab, adsorb].map((p) => blockTitle(p, null))).toEqual([
      "Bulk crystal",
      "Polymer chain",
      "Supercell",
      "Slab",
      "Place on surface",
    ]);
    expect(blockSettings(crystal, [])).toBe("Na? Rocksalt (AB), a = 5.64 Å");
    expect(blockSettings(polymer, [])).toBe("PE × 20");
    expect(blockSettings({ ...polymer, name: "" }, [])).toBe("*CC* × 20");
    expect(blockSettings(supercell, [])).toBe("2 × 3 × 4");
    expect(blockSettings(slab, [])).toBe("(1 1 0) · 1 layer · 2 × 2");
    expect(blockSettings({ ...slab, layers: 3 }, [])).toBe("(1 1 0) · 3 layers · 2 × 2");
    expect(blockSettings(adsorb, [])).toBe("3 × 3 at 2.5 Å");
  });

  it("never prints NaN for a setting left blank in an older file", () => {
    expect(fmt(NaN)).toBe("?");
    expect(fmt(Infinity)).toBe("?");
    expect(fmt(2.5)).toBe("2.5");
    const blanks = [
      { ...crystal, a: NaN },
      { ...polymer, length: NaN },
      { ...supercell, repeat: [NaN, 1, 1] },
      { ...slab, miller: [NaN, 0, 1], layers: NaN, repeat: [1, NaN] },
      { ...adsorb, height: NaN, grid: [NaN, 1] },
    ] as FlowParams[];
    for (const p of blanks) {
      expect(blockSettings(p, [])).not.toContain("NaN");
      expect(blockSettings(p, [])).toContain("?");
    }
  });

  it("labels every run state for screen readers", () => {
    expect(
      (["idle", "stale", "running", "done", "error"] as const).map((status) =>
        runStatusLabel({ ...IDLE_RUN, status }),
      ),
    ).toEqual([
      "Not run yet",
      "Out of date: changed since the last run",
      "Running",
      "Done",
      "Failed",
    ]);
  });

  it("names a polymer by its name, the others by their title", () => {
    expect(blockName(polymer, null, [])).toBe("PE");
    expect(blockName({ ...polymer, name: "" }, null, [])).toBe("Polymer chain");
    expect(blockName(slab, null, [])).toBe("Slab");
  });

  it("says a modifier has not run yet, but not a block that starts a structure", () => {
    expect(blockSummary(slab, IDLE_RUN, [])).toContain("Not run yet");
    expect(blockSummary(crystal, IDLE_RUN, [])).not.toContain("Not run yet");
  });
});
