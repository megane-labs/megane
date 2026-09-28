/**
 * Whether a Builder panel (Details, History) is open, remembered per id in
 * `localStorage`, so the panels come back the way they were left; a blocked
 * storage leaves the state in memory only. (The key keeps its old "sections"
 * name so choices made before the panels existed still apply.)
 */

import { useCallback, useEffect, useState } from "react";

export const SECTIONS_STORAGE_KEY = "megane.builder.sections.v1";

type OpenMap = Record<string, boolean>;

function readOpen(storage: Storage | null): OpenMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SECTIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: OpenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOpen(storage: Storage | null, id: string, open: boolean) {
  if (!storage) return;
  try {
    storage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify({ ...readOpen(storage), [id]: open }));
  } catch {
    /* quota or blocked storage: the state stays in memory */
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether panel `id` is open: the stored choice, else `defaultOpen`. Returns
 * the state, a toggle, and `reveal`, which opens it (and remembers that) —
 * for a panel something is about to be shown in.
 */
export function useSectionOpen(
  id: string,
  defaultOpen: boolean,
  storage: Storage | null = defaultStorage(),
): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(() => readOpen(storage)[id] ?? defaultOpen);
  useEffect(() => {
    setOpen(readOpen(storage)[id] ?? defaultOpen);
  }, [id, defaultOpen, storage]);
  const toggle = useCallback(() => {
    setOpen((o) => {
      writeOpen(storage, id, !o);
      return !o;
    });
  }, [id, storage]);
  const reveal = useCallback(() => {
    writeOpen(storage, id, true);
    setOpen(true);
  }, [id, storage]);
  return [open, toggle, reveal];
}
