import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STRUCTURE_ACCEPT,
  STRUCTURE_EXTS,
  TRAJECTORY_ACCEPT,
  TRAJECTORY_EXTS,
  VASP_EXT,
  basename,
  isVaspBareName,
  matchesStructureName,
  structureExtFromFileName,
} from "@/parsers/fileNames";

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
