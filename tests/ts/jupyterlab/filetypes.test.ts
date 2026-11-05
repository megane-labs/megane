import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FACTORY_NAME,
  FACTORY_NAME_BINARY,
  FACTORY_NAME_PIPELINE,
  PIPELINE_FILETYPE,
  PIPELINE_FILETYPE_NAME,
  STRUCTURE_FILETYPES_BINARY,
  STRUCTURE_FILETYPES_TEXT,
  STRUCTURE_FILETYPE_NAMES_BINARY,
  STRUCTURE_FILETYPE_NAMES_TEXT,
  LAMMPS_PREFIX_FILETYPES,
  MEGANE_EXTENSIONS,
  lammpsPrefixPattern,
  withLammpsPrefixPatterns,
} from "../../../jupyterlab-megane/src/filetypes";

const LAMMPS_CASES = (
  JSON.parse(
    readFileSync(resolve(__dirname, "../../fixtures/lammps_prefix_names.json"), "utf8"),
  ) as { cases: Array<{ name: string; ext: string | null }> }
).cases;

describe("jupyterlab filetypes", () => {
  it("declares three distinct non-empty factory names", () => {
    const names = [FACTORY_NAME, FACTORY_NAME_BINARY, FACTORY_NAME_PIPELINE];
    for (const name of names) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
    expect(new Set(names).size).toBe(3);
  });

  it("aligns PIPELINE_FILETYPE_NAME with PIPELINE_FILETYPE.name", () => {
    expect(PIPELINE_FILETYPE_NAME).toBe("megane-pipeline");
    expect(PIPELINE_FILETYPE.name).toBe(PIPELINE_FILETYPE_NAME);
  });

  it("declares the pipeline filetype with .megane.json extension and JSON mime", () => {
    expect(PIPELINE_FILETYPE.extensions).toEqual([".megane.json"]);
    expect(PIPELINE_FILETYPE.mimeTypes).toEqual(["application/json"]);
    expect(PIPELINE_FILETYPE.fileFormat).toBe("text");
    expect(PIPELINE_FILETYPE.contentType).toBe("file");
  });

  it("ships 23 text filetypes (incl. LAMMPS dump, AMBER prmtop, mmCIF, VASP, CML, Molden, XSF, JCAMP-DX, Chem3D XML, Odyssey, magres, GAMESS, the volumetric grids, and CASTEP phonon)", () => {
    expect(STRUCTURE_FILETYPES_TEXT).toHaveLength(23);
  });

  it("includes the canonical PDB / GRO / XYZ / MOL / SDF / MOL2 / CIF / mmCIF / LAMMPS-data / LAMMPS-dump / AMBER-prmtop / VASP / Molden / JCAMP-DX names", () => {
    const names = STRUCTURE_FILETYPES_TEXT.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        "megane-pdb",
        "megane-gro",
        "megane-xyz",
        "megane-mol",
        "megane-sdf",
        "megane-mol2",
        "megane-cif",
        "megane-mmcif",
        "megane-lammps-data",
        "megane-lammps-dump",
        "megane-amber-prmtop",
        "megane-xsf",
        "megane-cml",
        "megane-cube",
        "megane-opendx",
        "megane-vasp",
        "megane-molden",
        "megane-jcampdx",
        "megane-c3xml",
        "megane-odydata",
        "megane-magres",
        "megane-gamess",
        "megane-phonon",
      ].sort(),
    );
  });

  it("registers both .xsf and .axsf for the XCrySDen filetype", () => {
    const xsf = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-xsf");
    expect(xsf).toBeDefined();
    expect(xsf?.extensions).toEqual([".xsf", ".axsf"]);
    expect(xsf?.fileFormat).toBe("text");
  });
  it("registers .cml for the Chemical Markup Language filetype", () => {
    const cml = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-cml");
    expect(cml).toBeDefined();
    expect(cml?.extensions).toEqual([".cml"]);
    expect(cml?.fileFormat).toBe("text");
  });

  it("registers .jdx and .jcamp for the JCAMP-DX spectrum filetype", () => {
    const jcamp = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-jcampdx");
    expect(jcamp).toBeDefined();
    expect(jcamp?.extensions).toEqual([".jdx", ".jcamp"]);
    expect(jcamp?.fileFormat).toBe("text");
    expect(jcamp?.mimeTypes).toEqual(["chemical/x-jcamp-dx"]);
    // `.dx` is intentionally absent — it collides with OpenDX volumetric grids
    // and only content sniffing can tell the two apart.
    expect(jcamp?.extensions).not.toContain(".dx");
  });
  it("registers the volumetric grid filetypes", () => {
    const cube = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-cube");
    expect(cube?.extensions).toEqual([".cube", ".cub"]);
    const dx = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-opendx");
    expect(dx?.extensions).toEqual([".dx"]);
  });

  it("registers the VASP filetype with .vasp plus a basename pattern for POSCAR/CONTCAR/XDATCAR", () => {
    const vasp = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-vasp");
    expect(vasp).toBeDefined();
    expect(vasp?.extensions).toEqual([".vasp"]);
    expect(vasp?.fileFormat).toBe("text");
    // JupyterLab matches `pattern` against the basename before falling back to
    // extensions, which is the only way an extensionless POSCAR can open.
    const re = new RegExp(vasp!.pattern!);
    expect(re.test("POSCAR")).toBe(true);
    expect(re.test("CONTCAR_relaxed")).toBe(true);
    expect(re.test("XDATCAR-run2")).toBe(true);
    expect(re.test("xdatcar")).toBe(true);
    expect(re.test("MyPOSCAR")).toBe(false);
    expect(re.test("notes.txt")).toBe(false);
  });

  it("registers .jxyz and .extxyz alongside .xyz on the XYZ filetype", () => {
    const xyz = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-xyz");
    expect(xyz).toBeDefined();
    expect(xyz?.extensions).toEqual([".xyz", ".jxyz", ".extxyz"]);
  });

  it("registers .molden for the Molden filetype", () => {
    const ft = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-molden");
    expect(ft).toBeDefined();
    expect(ft?.extensions).toEqual([".molden"]);
    expect(ft?.fileFormat).toBe("text");
  });

  it("registers .c3xml for the Chem3D XML filetype", () => {
    const ft = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-c3xml");
    expect(ft).toBeDefined();
    expect(ft?.extensions).toEqual([".c3xml"]);
    expect(ft?.fileFormat).toBe("text");
  });
  it("registers both Odyssey extensions on one filetype", () => {
    const ft = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-odydata");
    expect(ft).toBeDefined();
    expect(ft?.extensions).toEqual([".xodydata", ".odydata"]);
    expect(ft?.fileFormat).toBe("text");
  });
  it("registers .magres for the magres filetype", () => {
    const ft = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-magres");
    expect(ft).toBeDefined();
    expect(ft?.extensions).toEqual([".magres"]);
    expect(ft?.fileFormat).toBe("text");
  });
  it("registers .gamess for the GAMESS filetype", () => {
    const ft = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-gamess");
    expect(ft).toBeDefined();
    expect(ft?.extensions).toEqual([".gamess"]);
    expect(ft?.fileFormat).toBe("text");
  });
  it("registers .phonon for the CASTEP phonon filetype", () => {
    const ft = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-phonon");
    expect(ft).toBeDefined();
    expect(ft?.extensions).toEqual([".phonon"]);
    expect(ft?.fileFormat).toBe("text");
  });

  it("registers both .data and .lammps for the LAMMPS-data filetype", () => {
    const lammps = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-lammps-data");
    expect(lammps).toBeDefined();
    expect(lammps?.extensions).toEqual([".data", ".lammps"]);
  });

  it("registers .lammpstrj, .dump, and .trj for the LAMMPS-dump filetype", () => {
    const dump = STRUCTURE_FILETYPES_TEXT.find((f) => f.name === "megane-lammps-dump");
    expect(dump).toBeDefined();
    expect(dump?.extensions).toEqual([".lammpstrj", ".dump", ".trj"]);
    expect(dump?.fileFormat).toBe("text");
  });

  it("ships ASE-traj, XTC, DCD, and AMBER NetCDF binary filetypes", () => {
    expect(STRUCTURE_FILETYPES_BINARY).toHaveLength(4);
    const names = STRUCTURE_FILETYPES_BINARY.map((f) => f.name).sort();
    expect(names).toEqual(["megane-ase-traj", "megane-dcd", "megane-netcdf", "megane-xtc"]);
    for (const ft of STRUCTURE_FILETYPES_BINARY) {
      expect(ft.fileFormat).toBe("base64");
      expect(ft.contentType).toBe("file");
    }
    const xtc = STRUCTURE_FILETYPES_BINARY.find((f) => f.name === "megane-xtc");
    expect(xtc?.extensions).toEqual([".xtc"]);
    const dcd = STRUCTURE_FILETYPES_BINARY.find((f) => f.name === "megane-dcd");
    expect(dcd?.extensions).toEqual([".dcd"]);
    const nc = STRUCTURE_FILETYPES_BINARY.find((f) => f.name === "megane-netcdf");
    expect(nc?.extensions).toEqual([".nc"]);
  });

  it("ensures every extension starts with '.' and every name is unique across all arrays", () => {
    const allFiletypes = [
      PIPELINE_FILETYPE,
      ...STRUCTURE_FILETYPES_TEXT,
      ...STRUCTURE_FILETYPES_BINARY,
    ];
    const allExtensions = allFiletypes.flatMap((f) => f.extensions ?? []);
    for (const ext of allExtensions) {
      expect(ext.startsWith(".")).toBe(true);
    }
    const allNames = allFiletypes.map((f) => f.name);
    expect(new Set(allNames).size).toBe(allNames.length);
  });

  it("derives the *_NAMES_* arrays from .map(f => f.name)", () => {
    expect(STRUCTURE_FILETYPE_NAMES_TEXT).toEqual(STRUCTURE_FILETYPES_TEXT.map((f) => f.name));
    expect(STRUCTURE_FILETYPE_NAMES_BINARY).toEqual(STRUCTURE_FILETYPES_BINARY.map((f) => f.name));
    expect(STRUCTURE_FILETYPE_NAMES_TEXT).toHaveLength(23);
    expect(STRUCTURE_FILETYPE_NAMES_BINARY).toHaveLength(4);
  });
});

describe("LAMMPS data.* / dump.* patterns", () => {
  const patterned = withLammpsPrefixPatterns(STRUCTURE_FILETYPES_TEXT);
  const patternOf = (name: string) =>
    new RegExp(patterned.find((ft) => ft.name === name)!.pattern!);
  // JupyterLab matches the pattern against the basename of a "/" path.
  const basename = (name: string) => name.split(/[\\/]/).pop()!;

  it("agree with the shared case table (src/parsers/fileNames.ts lammpsPrefixExt)", () => {
    const data = patternOf("megane-lammps-data");
    const dump = patternOf("megane-lammps-dump");
    for (const { name, ext } of LAMMPS_CASES) {
      expect(data.test(basename(name)), name).toBe(ext === ".data");
      expect(dump.test(basename(name)), name).toBe(ext === ".dump");
    }
  });

  it("leave names ending in another file type's extension alone, in any case", () => {
    const pattern = new RegExp(lammpsPrefixPattern("data", [".json", ".tar.gz"]));
    expect(pattern.test("data.json")).toBe(false);
    expect(pattern.test("data.JSON")).toBe(false);
    expect(pattern.test("data.run.json")).toBe(false);
    expect(pattern.test("data.tar.gz")).toBe(false);
    expect(pattern.test("data.jsonl")).toBe(true);
    expect(pattern.test("DATA.peptide")).toBe(true);
  });

  it("match any data.<name> when no extension is known", () => {
    const pattern = new RegExp(lammpsPrefixPattern("dump", []));
    expect(pattern.test("dump.melt")).toBe(true);
    expect(pattern.test("dump.")).toBe(false);
    expect(pattern.test("xdump.melt")).toBe(false);
  });

  it("are given to the LAMMPS file types only, leaving the shared arrays untouched", () => {
    const withPattern = patterned.filter((ft) => ft.pattern && ft.name !== "megane-vasp");
    expect(withPattern.map((ft) => ft.name).sort()).toEqual(
      Object.values(LAMMPS_PREFIX_FILETYPES).sort(),
    );
    const lammpsData = STRUCTURE_FILETYPES_TEXT.find((ft) => ft.name === "megane-lammps-data")!;
    expect(lammpsData.pattern).toBeUndefined();
  });

  it("lists every Megane extension, lower-cased", () => {
    expect(MEGANE_EXTENSIONS).toEqual(expect.arrayContaining([".pdb", ".traj", ".megane.json"]));
    for (const ext of MEGANE_EXTENSIONS) expect(ext).toBe(ext.toLowerCase());
  });
});
