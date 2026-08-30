/**
 * UI state for the Pipeline panel: which tab is active (Editor vs Chat) and a
 * transient "pipeline applied" notice surfaced after the chat assistant
 * rewrites the graph.
 *
 * Persistence is per-session (sessionStorage) rather than across reloads, so
 * every cold start opens on the Chat tab — the assistant is the primary entry
 * point for building pipelines. Within a session the user's tab choice is
 * preserved across navigations.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";

export type PipelinePanelMode = "editor" | "chat" | "inspector";

export interface PipelineAppliedNotice {
  kind: "applied";
  /** Monotonic id so consumers can de-dupe transient renders. */
  id: number;
}

/** sessionStorage key the app-wide singleton persists under. */
export const PIPELINE_UI_STORAGE_KEY = "megane-pipeline-ui";

/**
 * Where one store persists its panel tab. A string names a sessionStorage
 * key; `false` keeps the tab in memory for this instance only.
 */
export type PipelineUIStorage = string | false;

function loadMode(storageKey: PipelineUIStorage): PipelinePanelMode {
  if (storageKey === false) return "chat";
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        (parsed.mode === "editor" || parsed.mode === "chat" || parsed.mode === "inspector")
      ) {
        return parsed.mode;
      }
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
  return "chat";
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
  pendingNotice: PipelineAppliedNotice | null;
  setMode: (mode: PipelinePanelMode) => void;
  /** Surface a one-shot "applied" notice without leaving the current tab. */
  markPipelineApplied: () => void;
  dismissNotice: () => void;
}

let nextNoticeId = 1;

export function pipelineUIStateCreator(
  storageKey: PipelineUIStorage = PIPELINE_UI_STORAGE_KEY,
): StateCreator<PipelineUIStore> {
  return (set) => ({
    mode: loadMode(storageKey),
    pendingNotice: null,

    setMode: (mode) => {
      saveMode(storageKey, mode);
      set({ mode });
    },

    markPipelineApplied: () => {
      // Stay on the current tab (typically Chat) so the assistant's reply remains
      // visible; the editor frames the freshly applied graph via its own
      // mode-change effect when the user switches to it.
      set({ pendingNotice: { kind: "applied", id: nextNoticeId++ } });
    },

    dismissNotice: () => {
      set({ pendingNotice: null });
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
