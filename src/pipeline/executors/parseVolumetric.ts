/**
 * Volumetric-format dispatch.
 *
 * `LoadVolumetricNode` used to hard-code the CUBE reader. Now that there is
 * more than one volumetric format, dispatch lives here so every host and every
 * test agrees on the rules — and so the one genuinely ambiguous extension is
 * resolved in a single place.
 *
 * ## The `.dx` collision
 *
 * OpenDX grids and JCAMP-DX spectra both claim `.dx`. They cannot be told
 * apart by name, only by content:
 *
 * - OpenDX opens with `object … class gridpositions`
 * - JCAMP-DX opens with `##TITLE=` / `##JCAMP-DX=`
 *
 * So `.dx` is sniffed (`isOpenDx`). A `.dx` that turns out to be JCAMP-DX gets
 * an explicit, actionable error rather than a confusing parse failure —
 * megane has no spectrum surface yet (see #611), and saying so is more useful
 * than "expected N data values, got 0".
 */

import type { VolumetricData } from "../types";
import { parseCube } from "./parseCube";
import { isOpenDx, parseDx } from "./parseDx";

/** File-dialog filter for the Load Volumetric node. */
export const VOLUMETRIC_ACCEPT = ".cube,.cub,.dx";

/** Drag-drop guard for the Load Volumetric node. */
export const VOLUMETRIC_EXTS = [".cube", ".cub", ".dx"];

/** True when `name` is a volumetric file this node will attempt to open. */
export function isVolumetricFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return VOLUMETRIC_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Parse a volumetric file by extension, sniffing content for `.dx`.
 * Throws a descriptive `Error` for unsupported or misidentified input.
 */
export function parseVolumetric(fileName: string, text: string): VolumetricData {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".cube") || lower.endsWith(".cub")) {
    return parseCube(text);
  }
  if (lower.endsWith(".dx")) {
    if (!isOpenDx(text)) {
      throw new Error(
        "This .dx file is not an OpenDX grid. It looks like a JCAMP-DX spectrum, " +
          "which Megane cannot display yet — the viewer has no 2D plot surface.",
      );
    }
    return parseDx(text);
  }
  throw new Error(`Unsupported volumetric format: ${fileName}`);
}
