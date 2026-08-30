/**
 * View state persistence store.
 * Saves camera position/orientation to localStorage so that camera state
 * survives page reloads. Follows the same pattern as useAIConfigStore.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { MeganeCameraState } from "../renderer/MoleculeRenderer";

export interface PersistedViewState {
  camera: MeganeCameraState | null;
}

/** localStorage key the app-wide singleton persists under. */
export const VIEW_STATE_STORAGE_KEY = "megane-view-state";

/**
 * Where one store persists its camera. A string names a localStorage key;
 * `false` keeps the camera in memory for this instance only.
 *
 * Scoping the store is not enough on its own — two viewers sharing one fixed
 * key would still overwrite each other's saved camera on every orbit.
 */
export type ViewStateStorage = string | false;

function loadViewState(storageKey: ViewStateStorage): PersistedViewState {
  if (storageKey === false) return { camera: null };
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.camera && typeof parsed.camera === "object") {
        return { camera: parsed.camera as MeganeCameraState };
      }
    }
  } catch {
    // ignore parse errors
  }
  return { camera: null };
}

function saveViewState(storageKey: ViewStateStorage, state: PersistedViewState): void {
  if (storageKey === false) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // ignore storage errors (private browsing, quota exceeded)
  }
}

export interface ViewStateStore extends PersistedViewState {
  updateCamera: (camera: MeganeCameraState) => void;
  clearViewState: () => void;
}

export function viewStateCreator(
  storageKey: ViewStateStorage = VIEW_STATE_STORAGE_KEY,
): StateCreator<ViewStateStore> {
  return (set) => ({
    ...loadViewState(storageKey),

    updateCamera: (camera) => {
      set({ camera });
      saveViewState(storageKey, { camera });
    },

    clearViewState: () => {
      set({ camera: null });
      if (storageKey === false) return;
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    },
  });
}

/** App-wide singleton — used when no <MeganeProvider> is mounted. */
export const useViewStateStore = create<ViewStateStore>(viewStateCreator());

/**
 * Private camera-persistence store for one viewer. Defaults to in-memory:
 * an anonymous instance has no stable identity across reloads, and silently
 * reusing the legacy key is the very collision this exists to prevent. Pass a
 * key explicitly to persist.
 */
export function createViewStateStore(
  storageKey: ViewStateStorage = false,
): StoreApi<ViewStateStore> {
  return createStore<ViewStateStore>(viewStateCreator(storageKey));
}
