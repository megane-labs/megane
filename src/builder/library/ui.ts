/**
 * What the molecule library does, shared by every place that offers it: the
 * Place tool's gallery (`LibraryPanel`) and the Inspector's *Save as
 * fragment*. `useLibraryActions` holds the actions; the library's dialogs
 * (the one Ketcher dialog, the one file input, whether the gallery is open)
 * live in `uiStore.ts`.
 *
 * Errors and confirmations go to the Builder's single notice.
 */

import { useCallback } from "react";
import { canEdit, shownSnapshot } from "../store";
import { useBuilderStoreApi, useScopedBuilderStore } from "../BuilderStores";
import { autoPlacement } from "./fragment";
import { draftFromFile, draftFromSnapshot } from "./sketch";
import { useLibraryStore } from "./store";
import type { LibraryMolecule, LibraryMoleculeDraft } from "./types";

/** Default height of an adsorbate above the clicked surface atom, Å. */
export const DEFAULT_ADSORB_HEIGHT = 2;

export { useLibraryUi, type LibraryUi, type SketchRequest } from "./uiStore";

export function useLibraryActions() {
  const api = useBuilderStoreApi();
  const addFragment = useScopedBuilderStore((s) => s.addFragment);
  const setPlaceSource = useScopedBuilderStore((s) => s.setPlaceSource);
  const reportError = useScopedBuilderStore((s) => s.reportError);
  const reportInfo = useScopedBuilderStore((s) => s.reportInfo);
  const addMolecule = useLibraryStore((s) => s.addMolecule);
  const removeMolecule = useLibraryStore((s) => s.removeMolecule);

  /** Keep a molecule in the user library and say so. */
  const keep = useCallback(
    (draft: LibraryMoleculeDraft) => {
      const added = addMolecule(draft);
      reportInfo(`Added ${added.name} to the library.`);
      return added;
    },
    [addMolecule, reportInfo],
  );

  /** Drop `m` beside the structure (as one op) and select it; with nothing open, start a document with it. */
  const add = useCallback(
    (m: LibraryMolecule) => {
      const s = api.getState();
      if (s.source && !canEdit(s)) return;
      addFragment(m, autoPlacement(shownSnapshot(s), m));
    },
    [api, addFragment],
  );

  /** Choose `m` for the Place tool; choosing the chosen one again turns Place off. */
  const place = useCallback(
    (m: LibraryMolecule) => {
      const s = api.getState();
      setPlaceSource(s.placeSource?.id === m.id && s.tool === "place" ? null : m);
    },
    [api, setPlaceSource],
  );

  const remove = useCallback(
    (m: LibraryMolecule) => {
      if (api.getState().placeSource?.id === m.id) setPlaceSource(null);
      removeMolecule(m.id);
    },
    [api, removeMolecule, setPlaceSource],
  );

  const importFile = useCallback(
    async (file: File) => {
      try {
        keep(await draftFromFile(file));
      } catch (err) {
        reportError(
          `Could not import ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [keep, reportError],
  );

  /** Keep the selected atoms (and the bonds between them) as a library molecule. */
  const saveSelection = useCallback(() => {
    const s = api.getState();
    const shown = shownSnapshot(s);
    if (!shown || s.selected.length === 0) return;
    try {
      keep(
        draftFromSnapshot(shown, `Selection (${s.selected.length} atoms)`, "selection", s.selected),
      );
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  }, [api, keep, reportError]);

  return { keep, add, place, remove, importFile, saveSelection };
}
