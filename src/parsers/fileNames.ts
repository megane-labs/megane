/**
 * Filename → format dispatch helpers.
 *
 * Every other dispatch point in megane keys off the file *extension*
 * (`getParserForExtension` in `parseCore.ts`). VASP breaks that assumption:
 * `POSCAR`, `CONTCAR`, and `XDATCAR` are conventionally written with **no
 * extension at all**. This module is the single place that maps such bare
 * filenames onto the synthetic `.vasp` extension the rest of the pipeline
 * already understands, so the worker, the synchronous fallback, the pipeline
 * loaders, and the drag-drop guards all agree.
 *
 * Keep it dependency-free — it is imported from the Web Worker bundle.
 */

/** The synthetic extension every VASP structure file is dispatched under. */
export const VASP_EXT = ".vasp";

/**
 * Bare VASP filenames, matched case-insensitively against the *basename*.
 * VASP writes `POSCAR` / `CONTCAR` / `XDATCAR`, and users routinely suffix
 * them (`POSCAR.bak`, `CONTCAR_relaxed`, `XDATCAR-run2`), which is why the
 * VS Code `customEditors` selector uses `POSCAR*` too.
 */
const VASP_BARE_NAME_RE = /^(poscar|contcar|xdatcar)([-_.].*)?$/;

/** Strip any directory component from a path. */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * True when `name` is a VASP structure file recognised by basename rather than
 * by extension (`POSCAR`, `CONTCAR.bak`, `XDATCAR`, …). Files that already end
 * in `.vasp` are matched by the normal extension path and are NOT reported
 * here.
 */
export function isVaspBareName(name: string): boolean {
  return VASP_BARE_NAME_RE.test(basename(name).toLowerCase());
}

/**
 * Resolve the extension a structure file should be parsed as.
 *
 * Behaves exactly like the previous inline `name.match(/\.[^.]+$/)` everywhere
 * except for the extensionless VASP filenames, which resolve to `.vasp`.
 */
export function structureExtFromFileName(name: string, fallback = ".pdb"): string {
  if (isVaspBareName(name)) return VASP_EXT;
  return (
    basename(name)
      .toLowerCase()
      .match(/\.[^.]+$/)?.[0] ?? fallback
  );
}

/**
 * Extension-or-basename guard shared by the drag-drop / file-picker handlers.
 * `exts` is matched as a suffix (the historical behaviour); VASP's bare
 * filenames are matched separately when `.vasp` is one of the accepted
 * extensions.
 */
export function matchesStructureName(name: string, exts: readonly string[]): boolean {
  const lower = basename(name).toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return true;
  return exts.includes(VASP_EXT) && isVaspBareName(lower);
}

/**
 * Every extension a structure file is opened by — the file pickers' accept
 * lists, the drag-drop guards and `openFile`'s classifier all read this one
 * list, which `docs/docs/platform-support.md` documents. Each entry must have
 * a case in `getParserForExtension` (`parseCore.ts`); VASP's extensionless
 * spellings (POSCAR / CONTCAR / XDATCAR) are matched by `isVaspBareName`.
 */
export const STRUCTURE_EXTS: readonly string[] = [
  ".pdb",
  ".gro",
  ".xyz",
  // Jmol's second extension for plain XYZ.
  ".jxyz",
  ".mol",
  ".sdf",
  ".mol2",
  ".cif",
  ".mmcif",
  ".data",
  ".lammps",
  ".prmtop",
  ".traj",
  // LAMMPS dump opened standalone as a multi-frame structure (topology from
  // frame 0; integer atom `type` ids used as element proxies). Also listed in
  // TRAJECTORY_EXTS so it can still be attached onto a separately-loaded
  // topology via the Load Trajectory node.
  ".lammpstrj",
  ".dump",
  ".trj",
  ".vasp",
  // Chemical Markup Language.
  ".cml",
  // Molden geometry output.
  ".molden",
  // XCrySDen structure / animation (`.axsf` is the animated variant).
  ".xsf",
  ".axsf",
  // Chem3D XML (CDXML family).
  ".c3xml",
  // Wavefunction Odyssey. `.xodydata` is XML, `.odydata` is the older text
  // layout; the parser detects which from the content, not the extension.
  ".xodydata",
  ".odydata",
  // CASTEP / Quantum ESPRESSO NMR output.
  ".magres",
  ".gamess",
  ".phonon",
];

/** Every extension a trajectory file attached to a loaded topology is opened by. */
export const TRAJECTORY_EXTS: readonly string[] = [
  ".xtc",
  ".lammpstrj",
  ".dump",
  ".trj",
  ".dcd",
  ".nc",
];

/** `STRUCTURE_EXTS` as a file-input `accept` attribute. */
export const STRUCTURE_ACCEPT = STRUCTURE_EXTS.join(",");

/** `TRAJECTORY_EXTS` as a file-input `accept` attribute. */
export const TRAJECTORY_ACCEPT = TRAJECTORY_EXTS.join(",");
