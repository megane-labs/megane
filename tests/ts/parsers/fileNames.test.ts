import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STRUCTURE_ACCEPT,
  STRUCTURE_EXTS,
  TRAJECTORY_ACCEPT,
  TRAJECTORY_EXTS,
  VASP_EXT,
  LAMMPS_DATA_EXT,
  LAMMPS_DUMP_EXT,
  basename,
  isVaspBareName,
  lammpsPrefixExt,
  matchesStructureName,
  matchesTrajectoryName,
  structureExtFromFileName,
  trajectoryKindFromFileName,
} from "@/parsers/fileNames";

/** The one case table every implementation of the LAMMPS prefix rule is tested against. */
const LAMMPS_CASES = (
  JSON.parse(
    readFileSync(resolve(__dirname, "../../fixtures/lammps_prefix_names.json"), "utf8"),
  ) as { cases: Array<{ name: string; ext: string | null }> }
).cases;

describe("lammpsPrefixExt", () => {
  it.each(LAMMPS_CASES.map((c) => [c.name, c.ext] as const))("maps %s to %s", (name, ext) => {
    expect(lammpsPrefixExt(name)).toBe(ext);
  });

  it("resolves to extensions the structure dispatch accepts", () => {
    expect(STRUCTURE_EXTS).toContain(LAMMPS_DATA_EXT);
    expect(STRUCTURE_EXTS).toContain(LAMMPS_DUMP_EXT);
  });
});

describe("LAMMPS prefix names in the dispatch helpers", () => {
  it("structureExtFromFileName resolves data.* / dump.* to .data / .dump", () => {
    expect(structureExtFromFileName("runs/data.peptide")).toBe(".data");
    expect(structureExtFromFileName("DUMP.melt")).toBe(".dump");
    expect(structureExtFromFileName("dump.1000.atom")).toBe(".dump");
    // The extension still wins when Megane reads it.
    expect(structureExtFromFileName("dump.xyz")).toBe(".xyz");
    expect(structureExtFromFileName("data.pdb")).toBe(".pdb");
  });

  it("matchesStructureName accepts them only when their extension is accepted", () => {
    expect(matchesStructureName("data.peptide", STRUCTURE_EXTS)).toBe(true);
    expect(matchesStructureName("dump.melt", STRUCTURE_EXTS)).toBe(true);
    expect(matchesStructureName("data.peptide", [".pdb", ".dump"])).toBe(false);
    expect(matchesStructureName("dump.melt", [".pdb", ".dump"])).toBe(true);
    expect(matchesStructureName("mydata.peptide", STRUCTURE_EXTS)).toBe(false);
  });

  it("trajectoryKindFromFileName reads dump.* as a LAMMPS dump, but not data.*", () => {
    expect(trajectoryKindFromFileName("dump.melt")).toBe("lammpstrj");
    expect(trajectoryKindFromFileName("out/Dump.NVT")).toBe("lammpstrj");
    expect(trajectoryKindFromFileName("dump.xtc")).toBe("xtc");
    expect(trajectoryKindFromFileName("data.peptide")).toBeNull();
  });

  it("matchesTrajectoryName is the trajectory drag-drop guard", () => {
    expect(matchesTrajectoryName("dump.melt")).toBe(true);
    expect(matchesTrajectoryName("run.XTC")).toBe(true);
    expect(matchesTrajectoryName("data.peptide")).toBe(false);
    expect(matchesTrajectoryName("1crn.pdb")).toBe(false);
  });
});

describe("isVaspBareName", () => {
  it.each(["POSCAR", "CONTCAR", "XDATCAR", "poscar", "contcar", "xdatcar"])(
    "recognises the bare VASP filename %s",
    (name) => {
      expect(isVaspBareName(name)).toBe(true);
    },
  );

  it.each(["POSCAR.bak", "CONTCAR_relaxed", "XDATCAR-run2", "poscar.old"])(
    "recognises the suffixed VASP filename %s",
    (name) => {
      expect(isVaspBareName(name)).toBe(true);
    },
  );

  it("strips directory components before matching", () => {
    expect(isVaspBareName("runs/relax/POSCAR")).toBe(true);
    expect(isVaspBareName("C:\\runs\\CONTCAR")).toBe(true);
  });

  it.each(["MyPOSCAR", "POSCARLIKE", "structure.pdb", "poscarish.xyz", ""])(
    "does not claim %s",
    (name) => {
      expect(isVaspBareName(name)).toBe(false);
    },
  );

  it("does not report a plain .vasp file (the extension path handles it)", () => {
    expect(isVaspBareName("MgO.vasp")).toBe(false);
  });
});

describe("structureExtFromFileName", () => {
  it("maps extensionless VASP filenames onto the synthetic .vasp extension", () => {
    expect(structureExtFromFileName("POSCAR")).toBe(VASP_EXT);
    expect(structureExtFromFileName("XDATCAR")).toBe(VASP_EXT);
    expect(structureExtFromFileName("runs/CONTCAR_relaxed")).toBe(VASP_EXT);
  });

  it("keeps the ordinary extension behaviour for every other format", () => {
    expect(structureExtFromFileName("1crn.pdb")).toBe(".pdb");
    expect(structureExtFromFileName("Water.GRO")).toBe(".gro");
    expect(structureExtFromFileName("traj.multi.xyz")).toBe(".xyz");
    expect(structureExtFromFileName("MgO.vasp")).toBe(".vasp");
  });

  it("falls back when there is no extension at all", () => {
    expect(structureExtFromFileName("README")).toBe(".pdb");
    expect(structureExtFromFileName("README", ".xyz")).toBe(".xyz");
  });

  it("ignores dots in directory names", () => {
    expect(structureExtFromFileName("v1.2/POSCAR")).toBe(VASP_EXT);
    expect(structureExtFromFileName("v1.2/README")).toBe(".pdb");
  });
});

describe("matchesStructureName", () => {
  const exts = [".pdb", ".xyz", ".vasp"];

  it("matches by extension suffix", () => {
    expect(matchesStructureName("1crn.pdb", exts)).toBe(true);
    expect(matchesStructureName("MgO.VASP", exts)).toBe(true);
  });

  it("matches bare VASP filenames when .vasp is accepted", () => {
    expect(matchesStructureName("POSCAR", exts)).toBe(true);
    expect(matchesStructureName("XDATCAR-run2", exts)).toBe(true);
  });

  it("does not match bare VASP filenames when .vasp is not accepted", () => {
    expect(matchesStructureName("POSCAR", [".pdb", ".xyz"])).toBe(false);
  });

  it("rejects unrelated files", () => {
    expect(matchesStructureName("notes.txt", exts)).toBe(false);
  });
});

describe("STRUCTURE_EXTS / TRAJECTORY_EXTS", () => {
  const parseCore = readFileSync(resolve(__dirname, "../../../src/parsers/parseCore.ts"), "utf8");

  it("has no duplicates", () => {
    expect(new Set(STRUCTURE_EXTS).size).toBe(STRUCTURE_EXTS.length);
    expect(new Set(TRAJECTORY_EXTS).size).toBe(TRAJECTORY_EXTS.length);
  });

  // `getParserForExtension` falls back to the PDB reader for an extension it
  // has no case for, so an accepted extension without one would open as PDB.
  // `.traj` (binary ASE) is dispatched before the switch.
  it.each(STRUCTURE_EXTS.filter((ext) => ext !== ".pdb" && ext !== ".traj"))(
    "gives %s its own parser case",
    (ext) => {
      expect(parseCore).toContain(`case "${ext}":`);
    },
  );

  it("dispatches .traj before the extension switch", () => {
    expect(parseCore).toContain('input.ext === ".traj"');
  });

  it("renders the accept attributes from the lists", () => {
    expect(STRUCTURE_ACCEPT.split(",")).toEqual([...STRUCTURE_EXTS]);
    expect(TRAJECTORY_ACCEPT.split(",")).toEqual([...TRAJECTORY_EXTS]);
    expect(STRUCTURE_EXTS).toContain(VASP_EXT);
  });
});

describe("basename", () => {
  it.each([
    ["a/b/c.pdb", "c.pdb"],
    ["C:\\data\\x.gro", "x.gro"],
    ["plain.xyz", "plain.xyz"],
  ])("strips the directory from %s", (path, expected) => {
    expect(basename(path)).toBe(expected);
  });
});

describe("trajectoryKindFromFileName", () => {
  it.each([
    ["run.xtc", "xtc"],
    ["RUN.XTC", "xtc"],
    ["/data/sim/run.dcd", "dcd"],
    ["C:\\sim\\md.nc", "netcdf"],
    ["dump.lammpstrj", "lammpstrj"],
    ["atoms.dump", "lammpstrj"],
    ["atoms.trj", "lammpstrj"],
  ])("resolves %s to %s", (name, kind) => {
    expect(trajectoryKindFromFileName(name)).toBe(kind);
  });

  it.each(["water.pdb", "run.trr", "noext", "dir.xtc/file", ".xtc.bak"])(
    "returns null for the non-trajectory name %s",
    (name) => {
      expect(trajectoryKindFromFileName(name)).toBeNull();
    },
  );

  it("resolves every TRAJECTORY_EXTS entry", () => {
    for (const ext of TRAJECTORY_EXTS) {
      expect(trajectoryKindFromFileName(`t${ext}`)).not.toBeNull();
    }
  });
});
