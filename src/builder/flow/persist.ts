/**
 * Flow mode remembered across reloads: the graph (as Save writes it), the
 * name it was opened under and which mode the Builder was in, kept in
 * `localStorage` and put back when a Builder mounts with an empty flow.
 *
 * Every Builder on an origin shares the one entry (the JupyterLab tabs, the
 * widgets of a notebook): the last flow edited is the one a new Builder
 * starts from, which is what reopening the app should do. The entry is
 * versioned and checked like a flow file, so anything else under the key, or
 * a blocked or full storage, is ignored rather than breaking the Builder.
 */

import { useEffect } from "react";
import type { StoreApi } from "zustand";
import { parseSerializedFlow, type FlowStore, type SerializedFlow } from "./store";
import type { FlowMode } from "./types";

export const FLOW_STORAGE_KEY = "megane.builder.flow.v1";

/** What is kept between visits. */
export interface PersistedFlow {
  mode: FlowMode;
  flow: SerializedFlow;
  name: string | null;
}

/** The page's `localStorage`, or null where it cannot be reached. */
export function defaultFlowStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The kept flow, or null when there is none or it is not one. */
export function readPersistedFlow(storage: Storage | null): PersistedFlow | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(FLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedFlow>;
    if (parsed.mode !== "manual" && parsed.mode !== "flow") return null;
    return {
      mode: parsed.mode,
      flow: parseSerializedFlow(parsed.flow),
      name: typeof parsed.name === "string" ? parsed.name : null,
    };
  } catch {
    return null;
  }
}

/** The entry for `state`, as stored. */
export function persistedText(state: Pick<FlowStore, "mode" | "serialize" | "fileName">): string {
  const entry: PersistedFlow = {
    mode: state.mode,
    flow: state.serialize(),
    name: state.fileName,
  };
  return JSON.stringify(entry);
}

/** Store `text`; a blocked or full storage keeps the flow in memory only. */
export function writePersistedFlow(storage: Storage | null, text: string): void {
  if (!storage) return;
  try {
    storage.setItem(FLOW_STORAGE_KEY, text);
  } catch {
    /* quota or blocked storage */
  }
}

/**
 * Put the kept flow and mode back into `flowApi` when it mounts with no
 * blocks (not as an Undo step), then keep the entry up to date.
 */
export function useFlowPersistence(
  flowApi: StoreApi<FlowStore>,
  storage: Storage | null = defaultFlowStorage(),
): void {
  useEffect(() => {
    const saved = readPersistedFlow(storage);
    const s = flowApi.getState();
    if (saved && s.nodes.length === 0) {
      if (saved.flow.nodes.length > 0) s.load(saved.flow, { name: saved.name, history: false });
      s.setMode(saved.mode);
    }
    let last: string | null = null;
    const write = (state: FlowStore) => {
      const text = persistedText(state);
      if (text === last) return;
      last = text;
      writePersistedFlow(storage, text);
    };
    write(flowApi.getState());
    return flowApi.subscribe((state, prev) => {
      if (
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.mode !== prev.mode ||
        state.fileName !== prev.fileName
      ) {
        write(state);
      }
    });
  }, [flowApi, storage]);
}
