/**
 * UI state for the Pipeline panel: which tab is active (Editor or Inspector).
 * The AI assistant is not a tab of its own — it is docked inside the Editor
 * tab, under the graph it edits.
 *
 * Persistence is per-session (sessionStorage) rather than across reloads, so
 * every cold start opens on the Editor tab, where the graph and the assistant
 * are both on screen. Within a session the user's tab choice is preserved
 * across navigations.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";

export type PipelinePanelMode = "editor" | "inspector";

/** sessionStorage key the app-wide singleton persists under. */
export const PIPELINE_UI_STORAGE_KEY = "megane-pipeline-ui";

/**
 * Where one store persists its panel tab. A string names a sessionStorage
 * key; `false` keeps the tab in memory for this instance only.
 */
export type PipelineUIStorage = string | false;

function loadMode(storageKey: PipelineUIStorage): PipelinePanelMode {
  if (storageKey === false) return "editor";
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      // "chat" was a tab of its own in earlier builds; the assistant now
      // lives in the Editor tab, so it lands there.
      if (parsed && (parsed.mode === "editor" || parsed.mode === "chat")) return "editor";
      if (parsed && parsed.mode === "inspector") return "inspector";
    }
  } catch {
    // ignore parse / storage errors
  }
  // Drop any stale localStorage entry from earlier builds so the per-session
  // model is the single source of truth.
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
  return "editor";
}

function saveMode(storageKey: PipelineUIStorage, mode: PipelinePanelMode) {
  if (storageKey === false) return;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({ mode }));
  } catch {
    // ignore quota / blocked storage
  }
}

export interface PipelineUIStore {
  mode: PipelinePanelMode;
  setMode: (mode: PipelinePanelMode) => void;
}

export function pipelineUIStateCreator(
  storageKey: PipelineUIStorage = PIPELINE_UI_STORAGE_KEY,
): StateCreator<PipelineUIStore> {
  return (set) => ({
    mode: loadMode(storageKey),

    setMode: (mode) => {
      saveMode(storageKey, mode);
      set({ mode });
    },
  });
}

/** App-wide singleton — used when no <MeganeProvider> is mounted. */
export const usePipelineUIStore = create<PipelineUIStore>(pipelineUIStateCreator());

/**
 * Private pipeline-panel UI state for one viewer. Defaults to in-memory so
 * two viewers do not overwrite each other's saved tab under one fixed key.
 */
export function createPipelineUIStore(
  storageKey: PipelineUIStorage = false,
): StoreApi<PipelineUIStore> {
  return createStore<PipelineUIStore>(pipelineUIStateCreator(storageKey));
}
