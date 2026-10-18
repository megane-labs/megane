/**
 * One trajectory open path for every host.
 *
 * The webapp's `useMeganeLocal.loadXtc`, `openFile`'s trajectory branch and the
 * `.megane.json` companion loader all need the same two steps: pick the parser
 * from the file name, and — for a variable-atom LAMMPS dump — map the raw
 * per-frame type ids to elements via the loaded structure. Keeping both here
 * means a dump opened through any of them renders identically.
 */

import { parseXTCFile, parseDCDFile, parseLammpstrjFile, parseNetCDFFile } from "./xtc";
import type { XTCParseResult } from "./xtc";
import { remapTrajectoryTypesToElements } from "./parseCore";
import { TRAJECTORY_EXTS, trajectoryKindFromFileName } from "./fileNames";

/**
 * Parse a trajectory file attached to an already-loaded structure.
 *
 * @param file              The trajectory file; its name selects the parser.
 * @param expectedNAtoms    Atom count of the loaded structure.
 * @param structureElements Elements of the loaded structure. A variable-atom
 *   LAMMPS dump (`meta.variesTopology`) emits raw integer type ids as each
 *   frame's `elements`; these are remapped to atomic numbers through the
 *   frame-0 ↔ structure correspondence (`remapTrajectoryTypesToElements`, the
 *   LAMMPS element-resolution carve-out of CRITICAL RULE #11). The remap returns
 *   new frames — the parser output itself stays as-read. Omit to skip it.
 * @throws when the file name is not a trajectory format.
 */
export async function parseTrajectoryByName(
  file: File,
  expectedNAtoms: number,
  structureElements?: Uint8Array | null,
): Promise<XTCParseResult> {
  const kind = trajectoryKindFromFileName(file.name);
  let result: XTCParseResult;
  switch (kind) {
    case "xtc":
      result = await parseXTCFile(file, expectedNAtoms);
      break;
    case "dcd":
      result = await parseDCDFile(file, expectedNAtoms);
      break;
    case "lammpstrj":
      result = await parseLammpstrjFile(file, expectedNAtoms);
      break;
    case "netcdf":
      result = await parseNetCDFFile(file, expectedNAtoms);
      break;
    default:
      throw new Error(
        `Unsupported trajectory format: ${file.name} (expected one of ${TRAJECTORY_EXTS.join(", ")})`,
      );
  }
  if (!result.meta?.variesTopology || !structureElements) return result;
  return { ...result, frames: remapTrajectoryTypesToElements(result.frames, structureElements) };
}
