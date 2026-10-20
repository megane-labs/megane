/**
 * Export the structure currently on screen as a file.
 *
 * The bytes come from the Rust writer (`megane_core::writer`, reached through
 * WASM), so what the Build panel exports and what `megane.write_structure`
 * produces in Python are identical. Delivery goes through `downloadBlob`,
 * which every host already routes: a plain download in the web app, the host
 * save dialog in the VS Code webview (`__MEGANE_SAVE_BLOB__`).
 */

import type { Snapshot } from "../types";
import { writeStructure, type StructureWriteFormat } from "../parsers/parseCore";
import { downloadBlob } from "../renderer/RenderCapture";

/** One entry of the export menu. */
export interface StructureExportFormat {
  value: StructureWriteFormat;
  label: string;
  ext: string;
  /**
   * The writer needs a unit cell (CIF, POSCAR) and rejects a structure
   * without one; menus disable the entry when `hasExportCell` is false.
   */
  needsCell?: boolean;
}

export const STRUCTURE_EXPORT_FORMATS: StructureExportFormat[] = [
  { value: "xyz", label: "XYZ", ext: ".xyz" },
  { value: "pdb", label: "PDB", ext: ".pdb" },
  { value: "mol", label: "MOL", ext: ".mol" },
  { value: "cif", label: "CIF", ext: ".cif", needsCell: true },
  { value: "poscar", label: "POSCAR", ext: ".vasp", needsCell: true },
];

/** True when the writer for `format` needs a unit cell (CIF, POSCAR). */
export function formatNeedsCell(format: StructureWriteFormat): boolean {
  return STRUCTURE_EXPORT_FORMATS.some((f) => f.value === format && f.needsCell === true);
}

/**
 * True when `box` is a cell the CIF / POSCAR writers accept: present, not all
 * zeros, and spanned by three independent vectors (the same test the Rust
 * writer applies before it refuses with "… needs a unit cell").
 */
export function hasExportCell(box: ArrayLike<number> | null | undefined): boolean {
  if (!box || box.length !== 9) return false;
  const m = Array.from(box);
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  const lengths = [0, 1, 2].map((r) => Math.hypot(m[r * 3], m[r * 3 + 1], m[r * 3 + 2]));
  const scale = lengths[0] * lengths[1] * lengths[2];
  return Number.isFinite(det) && scale > 0 && Math.abs(det) > 1e-9 * scale;
}

/** VASP's own extensionless names, which a POSCAR is saved back under as-is. */
const VASP_POSCAR_NAME_RE = /^(poscar|contcar)([-_.].*)?$/i;

/**
 * Strip a known structure extension so `water.pdb` exports as `water.xyz`.
 * VASP's bare names (`POSCAR`, `CONTCAR_relaxed`) have none and are kept.
 */
export function exportBaseName(fileName: string | null | undefined): string {
  const base = (fileName ?? "structure").split(/[\\/]/).pop() || "structure";
  return (
    base.replace(
      /\.(xyz|extxyz|pdb|ent|mol|sdf|mol2|gro|cif|mmcif|data|lammps|traj|vasp|poscar)$/i,
      "",
    ) || "structure"
  );
}

/** Serialize `snapshot` (optionally with residue labels) through the Rust writer. */
export async function snapshotToText(
  snapshot: Snapshot,
  format: StructureWriteFormat,
  atomLabels: string[] | null = null,
): Promise<string> {
  const labels = atomLabels && atomLabels.length === snapshot.nAtoms ? atomLabels : null;
  return writeStructure(format, snapshot.positions, snapshot.elements, snapshot.bonds, {
    bondOrders: snapshot.bondOrders,
    box: snapshot.box,
    boxOrigin: snapshot.boxOrigin,
    atomLabels: labels,
    chainIds: snapshot.atomChainIds,
  });
}

/**
 * The format Save writes without asking (⌘/Ctrl + S): the document's own
 * format when Megane can write it, so `caffeine.sdf` stays a MOL file with its
 * bond orders and `quartz.cif` stays a CIF, else XYZ (extended, with the cell,
 * when there is one).
 *
 * - `.pdb` / `.ent` → PDB; `.mol` / `.sdf` → MOL.
 * - `.cif` → CIF. `.mmcif` → PDB: an mmCIF is a macromolecule, and PDB keeps
 *   its residue names and chains, which the P 1 CIF writer does not.
 * - `.vasp` / `.poscar` and VASP's bare names (`POSCAR`, `CONTCAR`,
 *   `XDATCAR`, also suffixed: `CONTCAR_relaxed`) → POSCAR.
 *
 * A format that needs a cell falls back to XYZ when `hasCell` is false (the
 * cell was removed while editing), so Save never picks a writer that refuses.
 */
export function defaultExportFormat(
  fileName: string | null | undefined,
  hasCell = true,
): StructureWriteFormat {
  const format = documentFormat(fileName);
  return formatNeedsCell(format) && !hasCell ? "xyz" : format;
}

function documentFormat(fileName: string | null | undefined): StructureWriteFormat {
  const base = (fileName ?? "").split(/[\\/]/).pop() ?? "";
  if (/^(poscar|contcar|xdatcar)([-_.].*)?$/i.test(base)) return "poscar";
  const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]?.toLowerCase() ?? "";
  switch (ext) {
    case "pdb":
    case "ent":
    case "mmcif":
      return "pdb";
    case "mol":
    case "sdf":
      return "mol";
    case "cif":
      return "cif";
    case "vasp":
    case "poscar":
      return "poscar";
    default:
      return "xyz";
  }
}

/** The name a document called `fileName` is saved under in `format` (`water.pdb` → `water.xyz`). */
export function exportFileName(
  fileName: string | null | undefined,
  format: StructureWriteFormat,
): string {
  const base = exportBaseName(fileName);
  // `POSCAR` / `CONTCAR_relaxed` saved as POSCAR keep their VASP name.
  if (format === "poscar" && VASP_POSCAR_NAME_RE.test(base)) return base;
  const ext = STRUCTURE_EXPORT_FORMATS.find((f) => f.value === format)?.ext ?? `.${format}`;
  return `${base}${ext}`;
}

/** Write `snapshot` in `format` and hand the file to the host. Returns the file name. */
export async function exportSnapshot(
  snapshot: Snapshot,
  format: StructureWriteFormat,
  fileName: string | null | undefined,
  atomLabels: string[] | null = null,
): Promise<string> {
  const text = await snapshotToText(snapshot, format, atomLabels);
  const name = exportFileName(fileName, format);
  downloadBlob(new Blob([text], { type: "text/plain" }), name);
  return name;
}
