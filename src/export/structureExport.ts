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

export const STRUCTURE_EXPORT_FORMATS: {
  value: StructureWriteFormat;
  label: string;
  ext: string;
}[] = [
  { value: "xyz", label: "XYZ", ext: ".xyz" },
  { value: "pdb", label: "PDB", ext: ".pdb" },
  { value: "mol", label: "MOL", ext: ".mol" },
];

/** Strip a known structure extension so `water.pdb` exports as `water.xyz`. */
export function exportBaseName(fileName: string | null | undefined): string {
  const base = (fileName ?? "structure").split(/[\\/]/).pop() || "structure";
  return base.replace(/\.(xyz|extxyz|pdb|mol|sdf|mol2|gro|cif|mmcif|data|lammps|traj)$/i, "");
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
    atomLabels: labels,
    chainIds: snapshot.atomChainIds,
  });
}

/** Write `snapshot` in `format` and hand the file to the host. Returns the file name. */
export async function exportSnapshot(
  snapshot: Snapshot,
  format: StructureWriteFormat,
  fileName: string | null | undefined,
  atomLabels: string[] | null = null,
): Promise<string> {
  const text = await snapshotToText(snapshot, format, atomLabels);
  const ext = STRUCTURE_EXPORT_FORMATS.find((f) => f.value === format)?.ext ?? `.${format}`;
  const name = `${exportBaseName(fileName)}${ext}`;
  downloadBlob(new Blob([text], { type: "text/plain" }), name);
  return name;
}
