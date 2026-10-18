import { describe, it, expect } from "vitest";
import {
  SPECTRUM_ONLY_EXTS,
  TRAJECTORY_ONLY_EXTS,
  TRAJECTORY_ONLY_HINT,
  classifyStandaloneFile,
  siblingTopologyName,
} from "../../../src/hosts/classifyStandaloneFile";
import { STRUCTURE_EXTS } from "../../../src/parsers/fileNames";
import { VOLUMETRIC_EXTS } from "../../../src/pipeline/executors/parseVolumetric";

describe("derived extension lists", () => {
  it("trajectory-only = TRAJECTORY_EXTS that no structure loader claims", () => {
    expect([...TRAJECTORY_ONLY_EXTS].sort()).toEqual([".dcd", ".nc", ".xtc"]);
  });

  it("keeps LAMMPS dump out (it opens standalone as a multi-frame structure)", () => {
    for (const ext of [".lammpstrj", ".dump", ".trj"]) {
      expect(TRAJECTORY_ONLY_EXTS).not.toContain(ext);
      expect(STRUCTURE_EXTS).toContain(ext);
    }
  });

  it("spectrum-only = SPECTRUM_EXTS minus the `.dx` shared with OpenDX", () => {
    expect([...SPECTRUM_ONLY_EXTS].sort()).toEqual([".jcamp", ".jdx"]);
    expect(VOLUMETRIC_EXTS).toContain(".dx");
  });
});

describe("classifyStandaloneFile", () => {
  it.each(["ir.jdx", "IR.JCAMP"])("refuses spectrum %s with the Load Spectrum hint", (name) => {
    const c = classifyStandaloneFile(name);
    expect(c.kind).toBe("spectrum");
    expect(c.loadFailureHint).toBeUndefined();
    expect(c.errorMessage).toBe(
      `${name} is a spectrum, which has no atoms or coordinates to render. ` +
        "Add a Load Spectrum node in the pipeline editor and wire it to a " +
        "Spectrum Plot node to view it.",
    );
  });

  it.each(["grid.cube", "grid.cub", "pot.dx", "DENSITY.CUBE"])(
    "refuses volumetric %s with the Load Volumetric hint",
    (name) => {
      const c = classifyStandaloneFile(name);
      expect(c.kind).toBe("volumetric");
      expect(c.errorMessage).toBe(
        `${name} is a volumetric grid, which has no atoms to render on its own. ` +
          "Open a structure file (PDB, GRO, etc.) first, then add a Load Volumetric node " +
          "in the pipeline editor and point it at this file to draw an isosurface.",
      );
    },
  );

  it.each(["run.xtc", "RUN.DCD", "traj.nc", "archive.tar.xtc"])(
    "routes %s to the trajectory loader with a topology hint",
    (name) => {
      expect(classifyStandaloneFile(name)).toEqual({
        kind: "trajectory-only",
        loadFailureHint: TRAJECTORY_ONLY_HINT,
      });
    },
  );

  it("words the topology hint exactly as both hosts always have", () => {
    expect(TRAJECTORY_ONLY_HINT).toBe(
      "Open a structure file (PDB, GRO, etc.) first, or use the pipeline editor to wire a Load Structure node.",
    );
  });

  it.each([
    "protein.pdb",
    "system.gro",
    "md.traj",
    "dump.lammpstrj",
    "lammps.dump",
    "run.trj",
    "POSCAR",
    "noextension",
    "",
    "archive.xtc.pdb",
    "unknown.foo",
  ])("opens %s as a structure", (name) => {
    expect(classifyStandaloneFile(name)).toEqual({ kind: "structure" });
  });
});

describe("siblingTopologyName", () => {
  it.each([
    ["water.gro", "water.top"],
    ["Box.GRO", "Box.top"],
    ["conf.run1.gro", "conf.run1.top"],
    ["sims/water.gro", "sims/water.top"],
  ])("%s → %s", (name, expected) => {
    expect(siblingTopologyName(name)).toBe(expected);
  });

  it.each(["1crn.pdb", "water.top", "gro", "", "water.gro.bak"])("returns null for %s", (name) => {
    expect(siblingTopologyName(name)).toBeNull();
  });
});
