/**
 * The standalone Builder's safety net: an autosave of the open document in
 * the browser, and the browser's own "leave the page?" warning while there
 * are unsaved edits. Only the web app uses them (`BuilderHost.standalone`);
 * an IDE that embeds the Builder keeps its own documents.
 *
 * The autosave is the document as the Builder holds it, not a baked file:
 * the source structure, its residue labels and name, and the edits grouped
 * by Undo step (`editSteps`) with the label each step is listed under, so a
 * restored document undoes step by step as it did before the tab closed. The redo stack is not kept. It is written a
 * moment after each change (`AUTOSAVE_DELAY_MS`) and when the page is
 * hidden, removed once the document has nothing unsaved, and skipped when
 * it would not fit comfortably in `localStorage` (`AUTOSAVE_MAX_CHARS`).
 * Every storage access is guarded: a private window, a full quota or blocked
 * site data just means no autosave.
 */

import { useEffect } from "react";
import type { StoreApi } from "zustand";
import type { EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";
import { editSteps, isDirty, UNTITLED, type BuilderStore } from "./store";
import { stepLabelOf } from "./placement";

/** The `localStorage` key of the autosave. */
export const AUTOSAVE_KEY = "megane-builder-autosave";
/** Debounce between a change and its autosave, ms. */
export const AUTOSAVE_DELAY_MS = 1000;
/** Autosaves longer than this many characters (~4 MB) are not written. */
export const AUTOSAVE_MAX_CHARS = 4_000_000;

/** An autosaved document. */
export interface AutosaveData {
  version: 1;
  /** When it was written (ms since the epoch). */
  savedAt: number;
  fileName: string | null;
  source: Snapshot;
  sourceLabels: string[] | null;
  /** The edits, one array per Undo step. */
  steps: EditOp[][];
  /** The history-list label of each step (null: described from its ops). */
  labels: (string | null)[];
}

const TYPED_ARRAYS = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;

/** Marks a typed array in the JSON (`{"$typed": "Float32Array", "data": […]}`). */
const TYPED_TAG = "$typed";

/** `value` with every typed array replaced by a tagged plain array, ready for JSON. */
export function encodeValue(value: unknown): unknown {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const name = value.constructor.name;
    if (name in TYPED_ARRAYS) {
      return { [TYPED_TAG]: name, data: Array.from(value as unknown as ArrayLike<number>) };
    }
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = encodeValue(v);
    return out;
  }
  return value;
}

/** The inverse of `encodeValue`: tagged arrays become typed arrays again. */
export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const tag = obj[TYPED_TAG];
    if (typeof tag === "string" && tag in TYPED_ARRAYS && Array.isArray(obj.data)) {
      return TYPED_ARRAYS[tag as TypedArrayName].from(obj.data as number[]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = decodeValue(v);
    return out;
  }
  return value;
}

/** The browser's `localStorage`, or null where it cannot be reached. */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The autosave of `state` as JSON, or null when there is nothing unsaved to
 * keep or it is larger than `AUTOSAVE_MAX_CHARS`.
 */
export function autosaveText(
  state: Pick<
    BuilderStore,
    "source" | "sourceLabels" | "fileName" | "edits" | "docVersion" | "savedVersion"
  >,
  now = Date.now(),
): string | null {
  if (!state.source || !isDirty(state)) return null;
  const steps = editSteps(state.edits);
  const data = {
    version: 1,
    savedAt: now,
    fileName: state.fileName,
    source: encodeValue(state.source),
    sourceLabels: state.sourceLabels,
    steps: encodeValue(steps),
    labels: steps.map((step) => stepLabelOf(step[0]) ?? null),
  };
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return null;
  }
  return text.length > AUTOSAVE_MAX_CHARS ? null : text;
}

/**
 * Keep `state` as the autosave, or remove the autosave when the document has
 * nothing unsaved (or too much to keep). Never throws.
 */
export function writeAutosave(state: Parameters<typeof autosaveText>[0], now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const text = autosaveText(state, now);
    if (text === null) store.removeItem(AUTOSAVE_KEY);
    else store.setItem(AUTOSAVE_KEY, text);
  } catch {
    // Quota or blocked storage: no autosave this time.
  }
}

/** The autosave left by an earlier visit, or null (none, unreadable or malformed). */
export function readAutosave(): AutosaveData | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.steps) || !parsed.source) return null;
    const source = decodeValue(parsed.source) as Snapshot;
    if (
      typeof source.nAtoms !== "number" ||
      !(source.positions instanceof Float32Array) ||
      !(source.elements instanceof Uint8Array)
    ) {
      return null;
    }
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : null,
      source,
      sourceLabels: Array.isArray(parsed.sourceLabels) ? (parsed.sourceLabels as string[]) : null,
      ...stepsAndLabels(parsed.steps as unknown[], parsed.labels),
    };
  } catch {
    return null;
  }
}

/** The non-empty steps of a read autosave, each with its label (when it had one). */
function stepsAndLabels(
  rawSteps: unknown[],
  rawLabels: unknown,
): Pick<AutosaveData, "steps" | "labels"> {
  const labels = Array.isArray(rawLabels) ? rawLabels : [];
  const out: Pick<AutosaveData, "steps" | "labels"> = { steps: [], labels: [] };
  rawSteps.forEach((raw, i) => {
    if (!Array.isArray(raw) || raw.length === 0) return;
    out.steps.push(decodeValue(raw) as EditOp[]);
    out.labels.push(typeof labels[i] === "string" ? (labels[i] as string) : null);
  });
  return out;
}

/** Remove the autosave. Never throws. */
export function clearAutosave(): void {
  try {
    storage()?.removeItem(AUTOSAVE_KEY);
  } catch {
    // Nothing to remove.
  }
}

/**
 * Make `data` the document again: its source, then each edit step as one
 * Undo step. The restored document counts as unsaved. Returns whether it
 * could be restored; a failure is said in the notice line.
 */
export function restoreAutosave(api: StoreApi<BuilderStore>, data: AutosaveData): boolean {
  const name = data.fileName ?? "the structure";
  try {
    api.getState().openStructure(data.source, data.sourceLabels, data.fileName ?? UNTITLED);
    data.steps.forEach((step, i) => api.getState().pushOps(step, data.labels[i] ?? undefined));
  } catch (err) {
    api
      .getState()
      .reportError(
        `Could not restore ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    return false;
  }
  const n = data.steps.length;
  api.getState().reportInfo(`Restored ${name} with ${n} unsaved edit${n === 1 ? "" : "s"}.`);
  return true;
}

/** "today at 14:05" style wording of when an autosave was written. */
export function autosaveTime(savedAt: number, now = Date.now()): string {
  const at = new Date(savedAt);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === at.toDateString()
    ? `today at ${time}`
    : `${at.toLocaleDateString()} at ${time}`;
}

/**
 * While mounted and `enabled`, keep the autosave in step with the document:
 * written `AUTOSAVE_DELAY_MS` after each change, at once when the page is
 * hidden or the app unmounts, and removed when nothing is unsaved.
 */
export function useAutosave(api: StoreApi<BuilderStore>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      writeAutosave(api.getState());
    };
    const unsubscribe = api.subscribe((s, prev) => {
      if (
        s.docVersion === prev.docVersion &&
        s.savedVersion === prev.savedVersion &&
        s.source === prev.source
      ) {
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        writeAutosave(api.getState());
      }, AUTOSAVE_DELAY_MS);
    });
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [api, enabled]);
}

/**
 * While mounted and `enabled`, have the browser ask before the page is left
 * with unsaved edits (closing the tab, reloading, navigating away).
 */
export function useUnsavedGuard(api: StoreApi<BuilderStore>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty(api.getState())) return;
      // Keep the autosave current: the page may be about to go.
      writeAutosave(api.getState());
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [api, enabled]);
}
