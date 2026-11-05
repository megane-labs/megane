/**
 * Filename → format dispatch helpers.
 *
 * Every other dispatch point in megane keys off the file *extension*
 * (`getParserForExtension` in `parseCore.ts`). Two families of files break
 * that assumption:
 *
 * - VASP writes `POSCAR`, `CONTCAR`, and `XDATCAR` with **no extension at
 *   all**; they map onto the synthetic `.vasp` extension.
 * - LAMMPS names files by a **leading** keyword (`data.peptide`,
 *   `dump.melt`); they map onto `.data` / `.dump` (`lammpsPrefixExt`).
 *
 * This module is the single place that maps such filenames onto the extension
 * the rest of the pipeline already understands, so the worker, the
 * synchronous fallback, the pipeline loaders, and the drag-drop guards all
 * agree.
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

/** The extension a LAMMPS data file named `data.<name>` dispatches under. */
export const LAMMPS_DATA_EXT = ".data";

/** The extension a LAMMPS dump named `dump.<name>` dispatches under. */
export const LAMMPS_DUMP_EXT = ".dump";

/** `data.<name>` / `dump.<name>`, matched against the lower-cased basename. */
const LAMMPS_PREFIX_RE = /^(data|dump)\.(.+)$/;

/**
 * The extension a LAMMPS file named by its leading keyword dispatches under:
 * `.data` for `data.<name>`, `.dump` for `dump.<name>`, `null` otherwise.
 *
 * LAMMPS names files by what they are rather than by an extension —
 * `read_data data.peptide`, `write_data data.final`,
 * `dump 1 all atom 100 dump.melt` — so the name's *first* word says which
 * parser reads it. A name that also ends in an extension Megane reads is that
 * format instead: LAMMPS's `dump xyz` style writes an XYZ file, conventionally
 * `dump.xyz`, and `data.lammps` is LAMMPS data by its extension already.
 *
 * Mirrors `megane_core::formats::lammps_prefix_extension` (the canonical rule)
 * and `lammps_prefix_ext` in `python/megane/parsers/dispatch.py`; all of them
 * are tested against `tests/fixtures/lammps_prefix_names.json`.
 */
export function lammpsPrefixExt(name: string): string | null {
  const lower = basename(name).toLowerCase();
  const match = LAMMPS_PREFIX_RE.exec(lower);
  if (!match) return null;
  const last = lower.slice(lower.lastIndexOf("."));
  if (STRUCTURE_EXTS.includes(last) || TRAJECTORY_KIND_BY_EXT.has(last)) return null;
  return match[1] === "data" ? LAMMPS_DATA_EXT : LAMMPS_DUMP_EXT;
}

/**
 * Resolve the extension a structure file should be parsed as.
 *
 * Behaves exactly like the previous inline `name.match(/\.[^.]+$/)` everywhere
 * except for the extensionless VASP filenames, which resolve to `.vasp`, and
 * LAMMPS's prefix names, which resolve to `.data` / `.dump`.
 */
export function structureExtFromFileName(name: string, fallback = ".pdb"): string {
  if (isVaspBareName(name)) return VASP_EXT;
  const lammps = lammpsPrefixExt(name);
  if (lammps) return lammps;
  return (
    basename(name)
      .toLowerCase()
      .match(/\.[^.]+$/)?.[0] ?? fallback
  );
}

/**
 * Extension-or-basename guard shared by the drag-drop / file-picker handlers.
 * `exts` is matched as a suffix (the historical behaviour); VASP's bare
 * filenames and LAMMPS's prefix names are matched separately when the
 * extension they resolve to is one of the accepted extensions.
 */
export function matchesStructureName(name: string, exts: readonly string[]): boolean {
  const lower = basename(name).toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return true;
  if (exts.includes(VASP_EXT) && isVaspBareName(lower)) return true;
  const lammps = lammpsPrefixExt(lower);
  return lammps !== null && exts.includes(lammps);
}

/**
 * Every extension a structure file is opened by — the file pickers' accept
 * lists, the drag-drop guards and `openFile`'s classifier all read this one
 * list, which `docs/docs/platform-support.md` documents. Each entry must have
 * a case in `getParserForExtension` (`parseCore.ts`); VASP's extensionless
 * spellings (POSCAR / CONTCAR / XDATCAR) are matched by `isVaspBareName`, and
 * LAMMPS's prefix names (`data.*`, `dump.*`) by `lammpsPrefixExt`.
 */
export const STRUCTURE_EXTS: readonly string[] = [
  ".pdb",
  ".gro",
  ".xyz",
  // Jmol's second extension for plain XYZ.
  ".jxyz",
  // Extended XYZ (ASE's `extxyz` writer) — same grammar as `.xyz`.
  ".extxyz",
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

/** Trajectory formats handled by the binary/text trajectory parsers. */
export type TrajectoryKind = "xtc" | "dcd" | "lammpstrj" | "netcdf";

/**
 * Trajectory extension → parser kind. The single table every trajectory open
 * path dispatches through (`trajectoryKindFromFileName`), and the source of
 * `TRAJECTORY_EXTS` below, so the accept lists and the dispatch cannot drift.
 */
const TRAJECTORY_KIND_BY_EXT: ReadonlyMap<string, TrajectoryKind> = new Map([
  [".xtc", "xtc"],
  // LAMMPS dump spellings.
  [".lammpstrj", "lammpstrj"],
  [".dump", "lammpstrj"],
  [".trj", "lammpstrj"],
  [".dcd", "dcd"],
  // AMBER NetCDF.
  [".nc", "netcdf"],
]);

/** Every extension a trajectory file attached to a loaded topology is opened by. */
export const TRAJECTORY_EXTS: readonly string[] = [...TRAJECTORY_KIND_BY_EXT.keys()];

/**
 * Resolve which trajectory parser a file name dispatches to, or `null` when the
 * extension is not a trajectory format (matched case-insensitively against the
 * basename's last extension). A LAMMPS dump named `dump.<name>` is a LAMMPS
 * dump (`lammpsPrefixExt`).
 */
export function trajectoryKindFromFileName(name: string): TrajectoryKind | null {
  const ext =
    lammpsPrefixExt(name) ??
    basename(name)
      .toLowerCase()
      .match(/\.[^.]+$/)?.[0];
  return (ext && TRAJECTORY_KIND_BY_EXT.get(ext)) || null;
}

/** The trajectory drag-drop guard: true when `name` is a trajectory format. */
export function matchesTrajectoryName(name: string): boolean {
  return trajectoryKindFromFileName(name) !== null;
}

/** `STRUCTURE_EXTS` as a file-input `accept` attribute. */
export const STRUCTURE_ACCEPT = STRUCTURE_EXTS.join(",");

/** `TRAJECTORY_EXTS` as a file-input `accept` attribute. */
export const TRAJECTORY_ACCEPT = TRAJECTORY_EXTS.join(",");
