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
 * Dependency-free (no DOM, no WASM): the VS Code extension host imports it
 * directly, alongside the JupyterLab DocWidget.
 */

import { LAMMPS_DUMP_EXT, lammpsPrefixExt } from "../parsers/fileNames";

/** How many leading bytes of a file `isForeignLammpsPrefixFile` reads. */
export const LAMMPS_SNIFF_BYTES = 64 * 1024;

/** Header lines a LAMMPS data file states its size with. */
const DATA_ATOMS_RE = /^\d+\s+atoms$/;
const DATA_BOX_RE = /^\S+\s+\S+\s+xlo\s+xhi$/;

/**
 * True when `text`, the start of a file, reads as a LAMMPS data file: after
 * its first line (always a free-form comment) the header states the atom
 * count (`2004 atoms`) or the box (`-10.0 10.0 xlo xhi`).
 */
export function looksLikeLammpsData(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/#.*/, "").trim().replace(/\s+/g, " ");
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
 * True when Megane claimed `fileName` only by its LAMMPS-style name and
 * `head` — the start of the file, `LAMMPS_SNIFF_BYTES` are plenty — is not the
 * LAMMPS format that name stands for (`data.json`, `data.csv`, `dump.sql`).
 * The host then opens the file in its ordinary editor instead. False for any
 * name that is not a LAMMPS prefix name (`water.data`, `dump.xyz`): Megane
 * opens those by extension, as before.
 */
export function isForeignLammpsPrefixFile(fileName: string, head: Uint8Array): boolean {
  const ext = lammpsPrefixExt(fileName);
  if (!ext) return false;
  const text = new TextDecoder().decode(head.subarray(0, LAMMPS_SNIFF_BYTES));
  return ext === LAMMPS_DUMP_EXT ? !looksLikeLammpsDump(text) : !looksLikeLammpsData(text);
}
