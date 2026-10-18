/**
 * Open a structure file as the Builder's document.
 *
 * The one path every way of opening goes through: File › Open…, a drop on the
 * view, and a host handing a file over (VS Code's *Open in megane Builder*,
 * JupyterLab's file-browser entry, `megane.Builder("x.pdb")` in a notebook).
 * Only the structure is taken; a trajectory's later frames are ignored.
 */

import type { StoreApi } from "zustand";
import { parseStructureFile } from "../parsers/structure";
import { trackFileOpen } from "../analytics";
import { useBuilderStore, type BuilderStore } from "./store";

/**
 * Parse `file` and make it the document. A file that does not parse leaves
 * the document as it was and says why in the notice line. Resolves to
 * whether the file was opened.
 */
export async function openStructureFile(
  file: File,
  api: StoreApi<BuilderStore> = useBuilderStore,
): Promise<boolean> {
  try {
    const parsed = await parseStructureFile(file);
    api.getState().openStructure(parsed.snapshot, parsed.labels, file.name);
    trackFileOpen("structure", file.name);
    return true;
  } catch (err) {
    api
      .getState()
      .reportError(
        `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    return false;
  }
}
