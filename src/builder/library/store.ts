/**
 * The user's molecule library, persisted in `localStorage` so it survives
 * reloads. Presets are not stored: `allMolecules` prepends them at read time,
 * so a preset renamed in a later release simply shows its new geometry.
 *
 * Storage is best-effort: a private window, blocked site data, or a full
 * quota leaves the library in memory only, never throws into the UI.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { PRESET_MOLECULES } from "./presets";
import type { LibraryMolecule, LibraryMoleculeDraft } from "./types";

export const LIBRARY_STORAGE_KEY = "megane.builder.library.v1";

export interface LibraryStore {
  /** The user's molecules, oldest first. */
  user: LibraryMolecule[];
  /** Add a molecule to the user library; returns it with its id. */
  addMolecule: (draft: LibraryMoleculeDraft) => LibraryMolecule;
  removeMolecule: (id: string) => void;
  renameMolecule: (id: string, name: string) => void;
}

/** Presets followed by the user's molecules. */
export function allMolecules(state: Pick<LibraryStore, "user">): LibraryMolecule[] {
  return [...PRESET_MOLECULES, ...state.user];
}

/** Whether `id` names a user molecule (presets cannot be removed or renamed). */
export function isUserMolecule(id: string): boolean {
  return id.startsWith("user:");
}

function newUserId(): string {
  return `user:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Keep only well-formed molecules from a stored blob; anything else is dropped. */
export function sanitizeStored(raw: unknown): LibraryMolecule[] {
  if (!Array.isArray(raw)) return [];
  const out: LibraryMolecule[] = [];
  for (const m of raw as Partial<LibraryMolecule>[]) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.id !== "string" || !isUserMolecule(m.id)) continue;
    if (typeof m.name !== "string") continue;
    if (!Array.isArray(m.elements) || !Array.isArray(m.positions) || !Array.isArray(m.bonds)) {
      continue;
    }
    if (m.positions.length !== m.elements.length * 3) continue;
    const n = m.elements.length;
    if (
      !m.bonds.every(
        (b) =>
          Array.isArray(b) &&
          b.length === 2 &&
          b.every((k) => Number.isInteger(k) && k >= 0 && k < n),
      )
    ) {
      continue;
    }
    const mol: LibraryMolecule = {
      id: m.id,
      name: m.name,
      formula: typeof m.formula === "string" ? m.formula : "",
      origin:
        m.origin === "sketch" || m.origin === "file" || m.origin === "selection"
          ? m.origin
          : "file",
      elements: m.elements.map(Number),
      positions: m.positions.map(Number),
      bonds: m.bonds.map(([i, j]) => [i, j]),
    };
    if (Array.isArray(m.bondOrders) && m.bondOrders.length === m.bonds.length) {
      mol.bondOrders = m.bondOrders.map(Number);
    }
    if (typeof m.molfile === "string") mol.molfile = m.molfile;
    if (m.planar === true) mol.planar = true;
    out.push(mol);
  }
  return out;
}

function readStorage(storage: Storage | null): LibraryMolecule[] {
  if (!storage) return [];
  try {
    const text = storage.getItem(LIBRARY_STORAGE_KEY);
    return text ? sanitizeStored(JSON.parse(text)) : [];
  } catch {
    return [];
  }
}

function writeStorage(storage: Storage | null, user: LibraryMolecule[]) {
  if (!storage) return;
  try {
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(user));
  } catch {
    /* quota or blocked storage: the library stays in memory */
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Builds the store's state; `storage` is where the user library is kept. */
export function libraryStateCreator(storage: Storage | null): StateCreator<LibraryStore> {
  return (set, get) => {
    const commit = (user: LibraryMolecule[]) => {
      set({ user });
      writeStorage(storage, user);
    };
    return {
      user: readStorage(storage),
      addMolecule: (draft) => {
        const molecule: LibraryMolecule = { ...draft, id: newUserId() };
        commit([...get().user, molecule]);
        return molecule;
      },
      removeMolecule: (id) => {
        const user = get().user;
        if (!user.some((m) => m.id === id)) return;
        commit(user.filter((m) => m.id !== id));
      },
      renameMolecule: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const user = get().user;
        if (!user.some((m) => m.id === id)) return;
        commit(user.map((m) => (m.id === id ? { ...m, name: trimmed } : m)));
      },
    };
  };
}

/** The app's library. */
export const useLibraryStore = create<LibraryStore>(libraryStateCreator(defaultStorage()));

/** A private library over `storage` (tests, embedding). */
export function createLibraryStore(storage: Storage | null = null): StoreApi<LibraryStore> {
  return createStore<LibraryStore>(libraryStateCreator(storage));
}
