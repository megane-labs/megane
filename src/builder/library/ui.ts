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
import { autoPlacementInfo, describePlacement, formulaOf, geometryFromSnapshot } from "./fragment";
import { draftFromFile, draftFromSnapshot } from "./sketch";
import { allMolecules, PERSIST_FAILED_NOTICE, useLibraryStore } from "./store";
import type { LibraryMolecule, LibraryMoleculeDraft } from "./types";

/** Default height of an adsorbate above the clicked surface atom, Å. */
export const DEFAULT_ADSORB_HEIGHT = 2;

export { useLibraryUi, type LibraryUi, type SketchRequest } from "./uiStore";

/** `base`, or `base (2)`, `base (3)`, … — the first that no name in `taken` uses. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base} (${k})`;
    if (!names.has(candidate)) return candidate;
  }
}

/** `text`, followed once per page by the warning that the library is not being saved. */
function withPersistNotice(text: string): string {
  return useLibraryStore.getState().takePersistNotice() ? `${text} ${PERSIST_FAILED_NOTICE}` : text;
}

export function useLibraryActions() {
  const api = useBuilderStoreApi();
  const addFragment = useScopedBuilderStore((s) => s.addFragment);
  const setPlaceSource = useScopedBuilderStore((s) => s.setPlaceSource);
  const reportError = useScopedBuilderStore((s) => s.reportError);
  const reportInfo = useScopedBuilderStore((s) => s.reportInfo);
  const addMolecule = useLibraryStore((s) => s.addMolecule);
  const removeMolecule = useLibraryStore((s) => s.removeMolecule);
  const renameMolecule = useLibraryStore((s) => s.renameMolecule);
  const replaceMolecule = useLibraryStore((s) => s.replaceMolecule);

  /** Keep a molecule in the user library and say so. */
  const keep = useCallback(
    (draft: LibraryMoleculeDraft) => {
      const added = addMolecule(draft);
      reportInfo(withPersistNotice(`Added ${added.name} to the library.`));
      return added;
    },
    [addMolecule, reportInfo],
  );

  /** Save an edited sketch over the user molecule `id`; the Place tool follows it. */
  const update = useCallback(
    (id: string, draft: LibraryMoleculeDraft) => {
      const updated = replaceMolecule(id, draft);
      if (!updated) {
        reportError("That molecule is no longer in the library.");
        return null;
      }
      const s = api.getState();
      if (s.placeSource?.id === id && s.tool === "place") setPlaceSource(updated);
      reportInfo(withPersistNotice(`Updated ${updated.name} in the library.`));
      return updated;
    },
    [api, replaceMolecule, reportError, reportInfo, setPlaceSource],
  );

  /** Rename a user molecule (blank names are ignored). */
  const rename = useCallback(
    (m: LibraryMolecule, name: string) => {
      if (!name.trim() || name.trim() === m.name) return;
      renameMolecule(m.id, name);
      const s = api.getState();
      if (s.placeSource?.id === m.id && s.tool === "place") {
        setPlaceSource({ ...s.placeSource, name: name.trim() });
      }
      const warn = useLibraryStore.getState().takePersistNotice();
      if (warn) reportInfo(PERSIST_FAILED_NOTICE);
    },
    [api, renameMolecule, reportInfo, setPlaceSource],
  );

  /**
   * Drop `m` into the document (as one op) and select it, and say where it
   * went: the emptiest part of the cell, or beside the structure. With
   * nothing open, start a document with it.
   */
  const add = useCallback(
    (m: LibraryMolecule) => {
      const s = api.getState();
      if (s.source && !canEdit(s)) return;
      const placement = autoPlacementInfo(shownSnapshot(s), m);
      if (addFragment(m, placement.at) !== null) {
        reportInfo(`Added ${m.name} ${describePlacement(placement)}.`);
      }
    },
    [api, addFragment, reportInfo],
  );

  /** Choose `m` for the Place tool; choosing the chosen one again turns Place off. */
  const place = useCallback(
    (m: LibraryMolecule) => {
      const s = api.getState();
      setPlaceSource(s.placeSource?.id === m.id && s.tool === "place" ? null : m);
    },
    [api, setPlaceSource],
  );

  /** Remove a user molecule after asking (it cannot be undone); resolves to whether it went. */
  const remove = useCallback(
    async (m: LibraryMolecule) => {
      const ok = await api.getState().requestConfirm({
        title: "Remove from the library?",
        message: `${m.name} will be deleted from your molecule library. This cannot be undone.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return false;
      if (api.getState().placeSource?.id === m.id) setPlaceSource(null);
      removeMolecule(m.id);
      return true;
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
      // Named after its formula ("C2H6O", "C2H6O (2)", …): rename it in the gallery.
      const formula = formulaOf(geometryFromSnapshot(shown, s.selected).elements);
      const taken = allMolecules(useLibraryStore.getState()).map((m) => m.name);
      const name = uniqueName(formula || "Fragment", taken);
      keep(draftFromSnapshot(shown, name, "selection", s.selected));
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  }, [api, keep, reportError]);

  return { keep, update, rename, add, place, remove, importFile, saveSelection };
}
