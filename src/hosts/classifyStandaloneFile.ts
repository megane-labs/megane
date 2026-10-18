/**
 * What a host should do with a file the user opened on its own.
 *
 * The VSCode custom editor (`vscode-megane/webview/main.tsx`) and the
 * JupyterLab DocWidget (`jupyterlab-megane/src/MeganeDocWidget.tsx`) both open
 * a single file standalone — there is no pipeline around it yet. Some formats
 * cannot be rendered that way, and both hosts must refuse them with the same
 * actionable message (CRITICAL RULE #6). This module is the one place that
 * decides, derived from the canonical extension lists rather than a private
 * copy of them:
 *
 * - **trajectory-only** — in `TRAJECTORY_EXTS` but not `STRUCTURE_EXTS`
 *   (XTC, DCD, AMBER NetCDF): frames without topology. The host still tries
 *   the trajectory loader and, when it fails, appends `loadFailureHint`.
 *   LAMMPS dump is in both lists, so it opens as a multi-frame structure.
 * - **spectrum** — in `SPECTRUM_EXTS` but not `VOLUMETRIC_EXTS` (JCAMP-DX):
 *   no coordinates at all. `.dx` is shared with OpenDX grids and only content
 *   sniffing (done by the Load Spectrum / Load Volumetric nodes) can tell them
 *   apart, so a standalone `.dx` is treated as volumetric.
 * - **volumetric** — `VOLUMETRIC_EXTS` (CUBE, OpenDX): a scalar field with no
 *   atoms to draw it on.
 * - **structure** — everything else, handed to the structure loader (which
 *   reports unsupported formats itself).
 */

import { SPECTRUM_EXTS } from "../parsers/spectrum";
import { STRUCTURE_EXTS, TRAJECTORY_EXTS } from "../parsers/fileNames";
import { VOLUMETRIC_EXTS } from "../pipeline/executors/parseVolumetric";

export type StandaloneFileKind = "structure" | "trajectory-only" | "spectrum" | "volumetric";

export interface StandaloneFileClassification {
  kind: StandaloneFileKind;
  /** Set when the file must not be loaded at all: show this to the user instead. */
  errorMessage?: string;
  /** Set when loading may fail for want of a topology: append this to the load error. */
  loadFailureHint?: string;
}

/** Trajectory formats that carry no atom topology of their own. */
export const TRAJECTORY_ONLY_EXTS: readonly string[] = TRAJECTORY_EXTS.filter(
  (ext) => !STRUCTURE_EXTS.includes(ext),
);

/** Spectrum formats whose extension no other format claims. */
export const SPECTRUM_ONLY_EXTS: readonly string[] = SPECTRUM_EXTS.filter(
  (ext) => !VOLUMETRIC_EXTS.includes(ext),
);

/** Appended to a failed trajectory-only load: the file needs a topology first. */
export const TRAJECTORY_ONLY_HINT =
  "Open a structure file (PDB, GRO, etc.) first, or use the pipeline editor to wire a Load Structure node.";

/** Lower-cased last extension of `fileName` (`""` when there is none). */
function extensionOf(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

/**
 * Decide how a host should open `fileName` (the file's basename, which the
 * error messages quote verbatim) standalone.
 */
export function classifyStandaloneFile(fileName: string): StandaloneFileClassification {
  const ext = extensionOf(fileName);
  if (SPECTRUM_ONLY_EXTS.includes(ext)) {
    return {
      kind: "spectrum",
      errorMessage:
        `${fileName} is a spectrum, which has no atoms or coordinates to render. ` +
        "Add a Load Spectrum node in the pipeline editor and wire it to a " +
        "Spectrum Plot node to view it.",
    };
  }
  if (VOLUMETRIC_EXTS.includes(ext)) {
    return {
      kind: "volumetric",
      errorMessage:
        `${fileName} is a volumetric grid, which has no atoms to render on its own. ` +
        "Open a structure file (PDB, GRO, etc.) first, then add a Load Volumetric node " +
        "in the pipeline editor and point it at this file to draw an isosurface.",
    };
  }
  if (TRAJECTORY_ONLY_EXTS.includes(ext)) {
    return { kind: "trajectory-only", loadFailureHint: TRAJECTORY_ONLY_HINT };
  }
  return { kind: "structure" };
}

/**
 * The GROMACS topology a host looks for next to an opened `.gro` file: same
 * stem, `.top` extension (`conf.gro` → `conf.top`, `Box.GRO` → `Box.top`).
 * `null` for any other file. Only the name is returned — each host resolves it
 * against the opened file's directory through its own filesystem.
 *
 * The VSCode extension host keeps a copy of this (it is compiled on its own
 * and cannot import `src/`); `tests/ts/vscode/extension.test.ts` pins the two.
 */
export function siblingTopologyName(fileName: string): string | null {
  if (extensionOf(fileName) !== ".gro") return null;
  return fileName.slice(0, fileName.lastIndexOf(".")) + ".top";
}
