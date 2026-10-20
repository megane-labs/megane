/**
 * Open a structure file as the Builder's document.
 *
 * The one path every way of opening goes through: File › Open…, a drop on the
 * view, and a host handing a file over (VS Code's *Open in megane Builder*,
 * JupyterLab's file-browser entry, `megane.Builder("x.pdb")` in a notebook).
 * Only the structure is taken; a trajectory's later frames are ignored, and
 * the notice line says so, as it says how many warnings the parser raised.
 * A document with unsaved edits is only replaced once the user agrees
 * (`confirmDiscard`); a file that does not parse never asks.
 */

import type { StoreApi } from "zustand";
import { parseStructureFile, type StructureParseResult } from "../parsers/structure";
import { trackFileOpen } from "../analytics";
import { confirmDiscard, useBuilderStore, type BuilderStore } from "./store";

/** What the parser said about a file worth telling, for the notice line. */
type ParseReport = Partial<Pick<StructureParseResult, "frames" | "meta" | "warnings">>;

/** How many frames `parsed` held (1 for a plain structure). */
export function frameCount(parsed: ParseReport): number {
  if (parsed.meta && parsed.meta.nFrames > 0) return parsed.meta.nFrames;
  return (parsed.frames?.length ?? 0) + 1;
}

/**
 * The info notice after opening `name`: which frame was taken from a
 * trajectory, the parser's warnings (how many and the first), and the files
 * of a multi-file drop that were left out. Null when there is nothing to say.
 */
export function openedNotice(name: string, parsed: ParseReport, ignored = 0): string | null {
  const frames = frameCount(parsed);
  const warnings = parsed.warnings ?? [];
  if (frames <= 1 && warnings.length === 0 && ignored === 0) return null;
  let text = frames > 1 ? `Opened frame 1 of ${frames} of ${name}` : `Opened ${name}`;
  if (warnings.length > 0) {
    text += ` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings[0]}`;
  }
  text += ".";
  if (frames > 1 && warnings.length === 0) text += " The Builder edits one frame.";
  if (ignored > 0) {
    text += ` ${ignored} other file${ignored === 1 ? " was" : "s were"} ignored: the Builder opens one file at a time.`;
  }
  return text;
}

/**
 * Parse `file` and make it the document. A file that does not parse leaves
 * the document as it was and says why in the notice line; with unsaved edits
 * open, the user is asked first and a "no" leaves the document as it was.
 * Resolves to whether the file was opened. `ignored` counts files dropped
 * alongside it that are left out (said in the notice).
 */
export async function openStructureFile(
  file: File,
  api: StoreApi<BuilderStore> = useBuilderStore,
  ignored = 0,
): Promise<boolean> {
  let parsed: StructureParseResult;
  try {
    parsed = await parseStructureFile(file);
  } catch (err) {
    api
      .getState()
      .reportError(
        `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    return false;
  }
  if (!(await confirmDiscard(api, `Opening ${file.name}`))) return false;
  api.getState().openStructure(parsed.snapshot, parsed.labels, file.name);
  const said = openedNotice(file.name, parsed, ignored);
  if (said) api.getState().reportInfo(said);
  trackFileOpen("structure", file.name);
  return true;
}

/** Open the first of `files` (a drop of several) and say the rest were ignored. */
export function openStructureFiles(
  files: ArrayLike<File>,
  api: StoreApi<BuilderStore> = useBuilderStore,
): Promise<boolean> {
  if (files.length === 0) return Promise.resolve(false);
  return openStructureFile(files[0], api, files.length - 1);
}
