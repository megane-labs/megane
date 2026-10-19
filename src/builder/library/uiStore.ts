/**
 * The library's dialogs in one Builder: the one Ketcher dialog, the one file
 * input and whether the Place tool's gallery is open, so each is mounted once
 * (`LibraryHost`) however many places can open it. Every Builder has its own
 * (`BuilderStores.tsx`); `useLibraryUi` is the page-wide one.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";

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

const libraryUiStateCreator: StateCreator<LibraryUi> = (set) => ({
  sketch: null,
  galleryOpen: false,
  importer: null,
  openSketch: (request = {}) => set({ sketch: request }),
  closeSketch: () => set({ sketch: null }),
  setGalleryOpen: (galleryOpen) => set({ galleryOpen }),
  setImporter: (importer) => set({ importer }),
});

/** The page-wide library dialogs: what a Builder without `BuilderProvider` uses. */
export const useLibraryUi = create<LibraryUi>(libraryUiStateCreator);

/** Library dialogs of their own, for one Builder. */
export function createLibraryUi(): StoreApi<LibraryUi> {
  return createStore<LibraryUi>(libraryUiStateCreator);
}
