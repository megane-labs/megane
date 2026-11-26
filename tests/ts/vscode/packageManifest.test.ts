import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../../vscode-megane/package.json"), "utf8"),
) as {
  description: string;
  contributes: {
    customEditors: Array<{
      viewType: string;
      selector: Array<{ filenamePattern: string }>;
    }>;
  };
};

describe("vscode-megane package.json", () => {
  it("registers the structure viewer custom editor with the expected file types", () => {
    const editor = manifest.contributes.customEditors.find(
      (e) => e.viewType === "megane.structureViewer",
    );
    expect(editor).toBeDefined();
    const patterns = editor!.selector.map((s) => s.filenamePattern).sort();
    expect(patterns).toEqual(
      [
        "*.cif",
        "*.data",
        "*.dcd",
        "*.dump",
        "*.gro",
        "*.lammps",
        "*.lammpstrj",
        "*.mmcif",
        "*.mol",
        "*.mol2",
        "*.nc",
        "*.pdb",
        "*.prmtop",
        "*.sdf",
        "*.traj",
        "*.trj",
        "*.vasp",
        "*.xtc",
        "*.xyz",
        "*.jxyz",
        "*.extxyz",
        "*.molden",
        "*.xsf",
        "*.axsf",
        // Volumetric grids open the megane editor, which then explains that a
        // grid needs a structure to overlay.
        "*.cube",
        "*.cub",
        "*.dx",
        // JCAMP-DX spectra. `*.dx` is intentionally absent — it collides with
        // OpenDX volumetric grids and only content sniffing separates them.
        "*.jdx",
        "*.jcamp",
        "*.c3xml",
        // Odyssey. Both layouts are claimed; the parser sniffs which is which.
        "*.xodydata",
        "*.odydata",
        "*.cml",
        "*.magres",
        "*.gamess",
        "*.phonon",
        // VASP's standard filenames carry no extension, so the selector needs
        // basename globs alongside the `*.vasp` extension pattern.
        "POSCAR*",
        "CONTCAR*",
        "XDATCAR*",
        // LAMMPS names data files and dumps by a leading keyword
        // (`data.peptide`, `dump.melt`); a `data.json` the glob also catches is
        // handed back to the text editor (`handOffForeignPrefixFile`).
        "data.*",
        "dump.*",
        // Numbered data files (`sample.data.001`). Only a digit after the
        // `.data.`, so source files such as `seed.data.ts` keep their editor.
        "?*.data.[0-9]*",
      ].sort(),
    );
  });

  it("its LAMMPS name selectors catch every LAMMPS-style name in the shared table", () => {
    const editor = manifest.contributes.customEditors.find(
      (e) => e.viewType === "megane.structureViewer",
    )!;
    // VS Code matches a selector without a "/" against the lower-cased
    // basename; these selectors use only `?`, `*` and `[0-9]`.
    const globToRegExp = (glob: string) =>
      new RegExp(
        `^${glob
          .toLowerCase()
          .replace(/[.+^${}()|\\]/g, "\\$&")
          .replace(/\?/g, "[^/]")
          .replace(/\*/g, "[^/]*")}$`,
      );
    const lammpsSelectors = ["data.*", "dump.*", "?*.data.[0-9]*"];
    for (const s of lammpsSelectors) {
      expect(editor.selector.map((sel) => sel.filenamePattern)).toContain(s);
    }
    const claimed = (name: string) =>
      lammpsSelectors.some((s) => globToRegExp(s).test(name.split(/[\\/]/).pop()!.toLowerCase()));
    const cases = (
      JSON.parse(
        readFileSync(resolve(__dirname, "../../fixtures/lammps_prefix_names.json"), "utf8"),
      ) as { cases: Array<{ name: string; ext: string | null }> }
    ).cases;
    for (const { name, ext } of cases) {
      if (ext !== null) expect(claimed(name), name).toBe(true);
    }
    // Other programs' files with `.data.` in the name keep their editor.
    for (const name of ["seed.data.ts", "user.data.json", "sample.data.final", ".data.001"]) {
      expect(claimed(name), name).toBe(false);
    }
  });

  it("mentions XCrySDen XSF in the marketplace description", () => {
    expect(manifest.description).toContain("XCrySDen XSF");
  });

  it("mentions CML in the marketplace description", () => {
    expect(manifest.description).toContain("CML");
  });
  it("mentions the volumetric grids in the marketplace description", () => {
    expect(manifest.description).toContain("Gaussian CUBE");
    expect(manifest.description).toContain("OpenDX");
  });

  it("mentions LAMMPS's data.* / dump.* file names in the marketplace description", () => {
    expect(manifest.description).toContain("data.* / dump.*");
    expect(manifest.description).toContain("*.data.<n>");
  });

  it("mentions VASP in the marketplace description", () => {
    expect(manifest.description).toContain("VASP");
  });

  it("mentions the Jmol .jxyz alias in the marketplace description", () => {
    expect(manifest.description).toContain(".jxyz");
  });

  it("mentions the extended XYZ .extxyz alias in the marketplace description", () => {
    expect(manifest.description).toContain(".extxyz");
  });

  it("mentions Molden in the marketplace description", () => {
    expect(manifest.description).toContain("Molden");
  });

  it("mentions JCAMP-DX in the marketplace description", () => {
    expect(manifest.description).toContain("JCAMP-DX");
  });
  it("mentions Chem3D XML in the marketplace description", () => {
    expect(manifest.description).toContain("Chem3D XML");
  });

  it("mentions magres in the marketplace description", () => {
    expect(manifest.description).toContain("CASTEP magres");
  });
  it("mentions GAMESS in the marketplace description", () => {
    expect(manifest.description).toContain("GAMESS output");
  });
  it("mentions CASTEP phonon in the marketplace description", () => {
    expect(manifest.description).toContain("CASTEP phonon");
  });
});
