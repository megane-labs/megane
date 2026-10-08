import type { DocumentRegistry } from "@jupyterlab/docregistry";

export const FACTORY_NAME = "megane Molecular Viewer";
export const FACTORY_NAME_BINARY = "megane Molecular Viewer (binary)";
export const FACTORY_NAME_PIPELINE = "megane Pipeline Viewer";

export const PIPELINE_FILETYPE_NAME = "megane-pipeline";

export const PIPELINE_FILETYPE: DocumentRegistry.IFileType = {
  name: PIPELINE_FILETYPE_NAME,
  displayName: "megane Pipeline",
  extensions: [".megane.json"],
  mimeTypes: ["application/json"],
  fileFormat: "text",
  contentType: "file",
};

export const STRUCTURE_FILETYPES_TEXT: DocumentRegistry.IFileType[] = [
  {
    name: "megane-pdb",
    displayName: "PDB",
    extensions: [".pdb"],
    mimeTypes: ["chemical/x-pdb"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-gro",
    displayName: "GRO",
    extensions: [".gro"],
    mimeTypes: ["chemical/x-gro"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-xyz",
    // `.jxyz` (Jmol) and `.extxyz` (ASE extended XYZ) are second extensions
    // for the same format, so they belong on this filetype rather than new ones.
    displayName: "XYZ",
    extensions: [".xyz", ".jxyz", ".extxyz"],
    mimeTypes: ["chemical/x-xyz"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-mol",
    displayName: "MOL",
    extensions: [".mol"],
    mimeTypes: ["chemical/x-mdl-molfile"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-sdf",
    displayName: "SDF",
    extensions: [".sdf"],
    mimeTypes: ["chemical/x-mdl-sdfile"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-mol2",
    displayName: "MOL2",
    extensions: [".mol2"],
    mimeTypes: ["chemical/x-mol2"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-cif",
    displayName: "CIF",
    extensions: [".cif"],
    mimeTypes: ["chemical/x-cif"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-mmcif",
    displayName: "mmCIF",
    extensions: [".mmcif"],
    mimeTypes: ["chemical/x-mmcif"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-lammps-data",
    displayName: "LAMMPS data",
    extensions: [".data", ".lammps"],
    mimeTypes: ["chemical/x-lammps-data"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-amber-prmtop",
    displayName: "AMBER topology",
    extensions: [".prmtop"],
    mimeTypes: ["chemical/x-amber-prmtop"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-xsf",
    displayName: "XCrySDen structure",
    extensions: [".xsf", ".axsf"],
    mimeTypes: ["chemical/x-xcrysden-structure"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-cml",
    displayName: "Chemical Markup Language",
    extensions: [".cml"],
    mimeTypes: ["chemical/x-cml"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    // Volumetric grids. Registered so double-clicking one opens megane, which
    // then explains that a grid needs a structure to overlay — see
    // VOLUMETRIC_ONLY_EXTENSIONS in trajectoryUtils.ts.
    name: "megane-cube",
    displayName: "Gaussian CUBE",
    extensions: [".cube", ".cub"],
    mimeTypes: ["chemical/x-gaussian-cube"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-opendx",
    displayName: "OpenDX grid",
    extensions: [".dx"],
    mimeTypes: ["chemical/x-opendx"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    // VASP structure files. `POSCAR` / `CONTCAR` / `XDATCAR` normally carry no
    // extension at all, so this entry also declares a `pattern` — JupyterLab
    // matches `IFileType.pattern` against the basename before it falls back to
    // extension matching. The regex is case-sensitive (JupyterLab compiles it
    // without flags), hence the explicit upper/lower alternatives.
    name: "megane-vasp",
    displayName: "VASP structure",
    extensions: [".vasp"],
    pattern: "^(POSCAR|CONTCAR|XDATCAR|poscar|contcar|xdatcar)([-_.].*)?$",
    mimeTypes: ["chemical/x-vasp"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-molden",
    displayName: "Molden",
    extensions: [".molden"],
    mimeTypes: ["chemical/x-molden"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    // JCAMP-DX spectra. Registered so double-clicking one opens megane, which
    // then explains that a spectrum needs the Load Spectrum node -- see
    // SPECTRUM_ONLY_EXTENSIONS in trajectoryUtils.ts.
    name: "megane-jcampdx",
    displayName: "JCAMP-DX spectrum",
    extensions: [".jdx", ".jcamp"],
    mimeTypes: ["chemical/x-jcamp-dx"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-c3xml",
    displayName: "Chem3D XML",
    extensions: [".c3xml"],
    mimeTypes: ["chemical/x-c3xml"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    // Both Odyssey layouts are text, so one entry covers the XML `.xodydata`
    // and the older `.odydata`; the parser tells them apart by content.
    name: "megane-odydata",
    displayName: "Odyssey data",
    extensions: [".xodydata", ".odydata"],
    mimeTypes: ["chemical/x-odydata"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-magres",
    displayName: "CASTEP magres",
    extensions: [".magres"],
    mimeTypes: ["chemical/x-magres"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-gamess",
    displayName: "GAMESS output",
    extensions: [".gamess"],
    mimeTypes: ["chemical/x-gamess-output"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-phonon",
    displayName: "CASTEP phonon",
    extensions: [".phonon"],
    mimeTypes: ["chemical/x-castep-phonon"],
    fileFormat: "text",
    contentType: "file",
  },
  {
    name: "megane-lammps-dump",
    displayName: "LAMMPS dump",
    extensions: [".lammpstrj", ".dump", ".trj"],
    mimeTypes: ["chemical/x-lammps-dump"],
    fileFormat: "text",
    contentType: "file",
  },
];

export const STRUCTURE_FILETYPES_BINARY: DocumentRegistry.IFileType[] = [
  {
    name: "megane-ase-traj",
    displayName: "ASE trajectory",
    extensions: [".traj"],
    mimeTypes: ["application/octet-stream"],
    fileFormat: "base64",
    contentType: "file",
  },
  {
    name: "megane-xtc",
    displayName: "XTC trajectory",
    extensions: [".xtc"],
    mimeTypes: ["chemical/x-xtc"],
    fileFormat: "base64",
    contentType: "file",
  },
  {
    name: "megane-dcd",
    displayName: "DCD trajectory",
    extensions: [".dcd"],
    mimeTypes: ["chemical/x-dcd"],
    fileFormat: "base64",
    contentType: "file",
  },
  {
    name: "megane-netcdf",
    displayName: "AMBER NetCDF trajectory",
    extensions: [".nc"],
    mimeTypes: ["application/x-netcdf"],
    fileFormat: "base64",
    contentType: "file",
  },
];

export const STRUCTURE_FILETYPE_NAMES_TEXT = STRUCTURE_FILETYPES_TEXT.map((f) => f.name);
export const STRUCTURE_FILETYPE_NAMES_BINARY = STRUCTURE_FILETYPES_BINARY.map((f) => f.name);
