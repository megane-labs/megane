/**
 * What the molecule library does, shared by every place that offers it: the
 * Place tool's gallery (`LibraryPanel`), the top bar's Insert menu, and the
 * Inspector's *Save as fragment*. `useLibraryActions` holds the actions;
 * `useLibraryUi` holds the one Ketcher dialog, the one file input and whether
 * the gallery is open, so each is mounted once (`LibraryHost`) however many
 * places can open it.
 *
 * Errors and confirmations go to the Builder's single notice.
 */

import { useCallback } from "react";
import { create } from "zustand";
import { useBuilderStore, canEdit, shownSnapshot } from "../store";
import { autoPlacement } from "./fragment";
import { draftFromFile, draftFromSnapshot } from "./sketch";
import { useLibraryStore } from "./store";
import type { LibraryMolecule, LibraryMoleculeDraft } from "./types";

/** Default height of an adsorbate above the clicked surface atom, Å. */
export const DEFAULT_ADSORB_HEIGHT = 2;

/** What the sketch dialog opens with: empty, or a user molecule's molfile to edit. */
export interface SketchRequest {
  molfile?: string;
  name?: string;
}

export interface LibraryUi {
  /** The open sketch dialog, or null. */
  sketch: SketchRequest | null;
  /** Whether the Place tool's gallery is open. */
  galleryOpen: boolean;
  /** Clicks the hidden file input; installed by the mounted `LibraryHost`. */
  importer: (() => void) | null;
  openSketch: (request?: SketchRequest) => void;
  closeSketch: () => void;
  setGalleryOpen: (open: boolean) => void;
  setImporter: (importer: (() => void) | null) => void;
}

export const useLibraryUi = create<LibraryUi>((set) => ({
  sketch: null,
  galleryOpen: false,
  importer: null,
  openSketch: (request = {}) => set({ sketch: request }),
  closeSketch: () => set({ sketch: null }),
  setGalleryOpen: (galleryOpen) => set({ galleryOpen }),
  setImporter: (importer) => set({ importer }),
}));

export function useLibraryActions() {
  const addFragment = useBuilderStore((s) => s.addFragment);
  const setPlaceSource = useBuilderStore((s) => s.setPlaceSource);
  const reportError = useBuilderStore((s) => s.reportError);
  const reportInfo = useBuilderStore((s) => s.reportInfo);
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

  /** Drop `m` beside the structure (as one op) and select it. */
  const add = useCallback(
    (m: LibraryMolecule) => {
      const s = useBuilderStore.getState();
      if (!canEdit(s)) return;
      addFragment(m, autoPlacement(shownSnapshot(s), m));
    },
    [addFragment],
  );

  /** Choose `m` for the Place tool; choosing the chosen one again turns Place off. */
  const place = useCallback(
    (m: LibraryMolecule) => {
      const s = useBuilderStore.getState();
      setPlaceSource(s.placeSource?.id === m.id && s.tool === "place" ? null : m);
    },
    [setPlaceSource],
  );

  const remove = useCallback(
    (m: LibraryMolecule) => {
      if (useBuilderStore.getState().placeSource?.id === m.id) setPlaceSource(null);
      removeMolecule(m.id);
    },
    [removeMolecule, setPlaceSource],
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
    const s = useBuilderStore.getState();
    const shown = shownSnapshot(s);
    if (!shown || s.selected.length === 0) return;
    try {
      keep(
        draftFromSnapshot(shown, `Selection (${s.selected.length} atoms)`, "selection", s.selected),
      );
    } catch (err) {
      reportError(err instanceof Error ? err.message : String(err));
    }
  }, [keep, reportError]);

  return { keep, add, place, remove, importFile, saveSelection };
}
