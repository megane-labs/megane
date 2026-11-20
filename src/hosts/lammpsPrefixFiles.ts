/**
 * Whether a host should keep a file it opened because of a LAMMPS-style name.
 *
 * LAMMPS names its files by a leading keyword (`data.peptide`, `dump.melt`;
 * see `lammpsPrefixExt` in `src/parsers/fileNames.ts`), and the editor hosts
 * claim such names for Megane by default — the VS Code `customEditors`
 * selectors `data.*` / `dump.*` and the JupyterLab file type patterns. A
 * leading `data.` or `dump.` is common outside LAMMPS too (`data.json`,
 * `data.csv`, `dump.sql`), and VS Code's globs cannot tell those apart by
 * name. So when the name is *all* that made Megane the default, the host looks
 * at the start of the file and, if it is not the LAMMPS format the name
 * claims, hands the file back to the editor that would otherwise have opened
 * it. The file name still decides the parser everywhere else: a non-LAMMPS
 * `data.*` dropped on a Load Structure node is parsed as LAMMPS data and
 * reports why it is not.
 *
 * The `.lammps` extension is just as loose: LAMMPS writes its log to
 * `log.lammps` by default and input scripts are often `in.lammps`, so a
 * `.lammps` file is checked for a LAMMPS data header the same way.
 *
 * Dependency-free (no DOM, no WASM): the VS Code extension host imports it
 * directly, alongside the JupyterLab DocWidget.
 */

import { LAMMPS_DATA_EXT, LAMMPS_DUMP_EXT, lammpsPrefixExt } from "../parsers/fileNames";

/** How many leading bytes of a file `isForeignLammpsPrefixFile` reads. */
export const LAMMPS_SNIFF_BYTES = 64 * 1024;

/** Header lines a LAMMPS data file states its size with. */
const DATA_ATOMS_RE = /^\d+\s+atoms$/;
const DATA_BOX_RE = /^\S+\s+\S+\s+xlo\s+xhi$/;

/** Every header line of a LAMMPS data file opens with a number. */
const DATA_HEADER_LINE_RE = /^[-+]?(?:\d|\.\d)/;

/**
 * True when `text`, the start of a file, reads as a LAMMPS data file: after
 * its first line (always a free-form comment) the header states the atom
 * count (`2004 atoms`) or the box (`-10.0 10.0 xlo xhi`). The header is read
 * only as far as it goes — every header line opens with a number, so the
 * first line that does not (a section such as `Masses`, or anything that is
 * not a data file at all) ends it. A LAMMPS log (`log.lammps`) also prints
 * `2004 atoms` once it has read a data file, but after its own command lines.
 */
export function looksLikeLammpsData(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/#.*/, "").trim().replace(/\s+/g, " ");
    if (line === "") continue;
    if (!DATA_HEADER_LINE_RE.test(line)) return false;
    if (DATA_ATOMS_RE.test(line) || DATA_BOX_RE.test(line)) return true;
  }
  return false;
}

/**
 * True when `text`, the start of a file, reads as a LAMMPS dump: its first
 * non-blank line is an `ITEM:` header (`ITEM: TIMESTEP`, or `ITEM: UNITS` /
 * `ITEM: TIME` when the dump writes those first).
 */
export function looksLikeLammpsDump(text: string): boolean {
  return /^\s*ITEM:/.test(text.replace(/^\uFEFF/, ""));
}

/**
 * The LAMMPS format Megane claims `fileName` as by its name alone, or `null`
 * when its extension settles it: `.data` / `.dump` for a leading-keyword name
 * (`lammpsPrefixExt`), and `.data` for any `*.lammps` — the extension of
 * LAMMPS data files, but also of LAMMPS's default log (`log.lammps`) and of
 * many input scripts (`in.lammps`).
 */
export function lammpsNameClaim(fileName: string): string | null {
  const prefix = lammpsPrefixExt(fileName);
  if (prefix) return prefix;
  return /\.lammps$/i.test(fileName) ? LAMMPS_DATA_EXT : null;
}

/**
 * True when Megane claimed `fileName` only by its LAMMPS-style name and
 * `head` — the start of the file, `LAMMPS_SNIFF_BYTES` are plenty — is not the
 * LAMMPS format that name stands for (`data.json`, `data.csv`, `dump.sql`,
 * `log.lammps`). The host then opens the file in its ordinary editor instead.
 * False for any name `lammpsNameClaim` leaves to its extension (`water.data`,
 * `dump.xyz`): Megane opens those as before.
 */
export function isForeignLammpsPrefixFile(fileName: string, head: Uint8Array): boolean {
  const ext = lammpsNameClaim(fileName);
  if (!ext) return false;
  const text = new TextDecoder().decode(head.subarray(0, LAMMPS_SNIFF_BYTES));
  return ext === LAMMPS_DUMP_EXT ? !looksLikeLammpsDump(text) : !looksLikeLammpsData(text);
}
