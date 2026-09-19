/**
 * UI state for the Build panel: the active tool, the element / bond order a
 * new atom or bond gets, the atoms currently selected in the 3D view, the
 * first atom of an in-progress bond, and the redo stack.
 *
 * The edit *history* is not here — it lives on the primary `load_structure`
 * node's params inside the pipeline store (see `pipeline/editHistory.ts`), so it is saved with
 * the pipeline. This store only holds what the panel needs between clicks.
 * Atom indices here are indices into the *rendered* structure (the edit
 * node's output); `BuildPanel` translates them to op refs.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { EditOp } from "../pipeline/types";
import { registerTestStores, GLOBAL_BUNDLE_ID } from "./testRegistry";

export type BuildTool = "select" | "add" | "bond" | "delete" | "move" | "element";

/** What the Viewport reports while the Build tab is active. */
export interface BuildPickInfo {
  /** Rendered atom index under the pointer, or null for empty space. */
  atomIndex: number | null;
  /** World point under the pointer at the pivot's depth (empty-space clicks). */
  world: [number, number, number] | null;
  shiftKey: boolean;
}

/**
 * Callbacks the Build panel installs for the 3D view. The panel and the
 * Viewport live in different subtrees, so they meet in this store.
 */
export interface BuildHandlers {
  pick: (info: BuildPickInfo) => void;
  /** Return true to start dragging `atomIndex` (the Move tool). */
  dragStart: (atomIndex: number) => boolean;
  /** Cumulative world displacement since the drag started. */
  dragMove: (delta: [number, number, number]) => void;
  dragEnd: () => void;
}

export interface BuildStore {
  tool: BuildTool;
  /** Atomic number used by the Add and Element tools. */
  element: number;
  /** Bond order used by the Bond tool and by Add's auto-bond. */
  bondOrder: number;
  /** Rendered-atom indices selected via click / box select. */
  selected: number[];
  /** First atom clicked with the Bond tool; the next click completes the bond. */
  pendingBondAtom: number | null;
  /** Ops removed by Undo, most recent last. Cleared by the next new op. */
  redoStack: EditOp[];
  /** Installed by the mounted Build panel; null when no panel is showing. */
  handlers: BuildHandlers | null;

  setTool: (tool: BuildTool) => void;
  setElement: (element: number) => void;
  setBondOrder: (order: number) => void;
  setSelected: (indices: number[]) => void;
  toggleSelected: (index: number) => void;
  clearSelected: () => void;
  setPendingBondAtom: (index: number | null) => void;
  pushRedo: (op: EditOp) => void;
  popRedo: () => EditOp | null;
  clearRedo: () => void;
  setHandlers: (handlers: BuildHandlers | null) => void;
}

export const buildStateCreator: StateCreator<BuildStore> = (set, get) => ({
  tool: "select",
  element: 6,
  bondOrder: 1,
  selected: [],
  pendingBondAtom: null,
  redoStack: [],
  handlers: null,

  setTool: (tool) => set({ tool, pendingBondAtom: null }),
  setElement: (element) => set({ element }),
  setBondOrder: (bondOrder) => set({ bondOrder }),
  setSelected: (indices) => set({ selected: [...new Set(indices)] }),
  toggleSelected: (index) =>
    set((s) => ({
      selected: s.selected.includes(index)
        ? s.selected.filter((i) => i !== index)
        : [...s.selected, index],
    })),
  clearSelected: () => set({ selected: [], pendingBondAtom: null }),
  setPendingBondAtom: (index) => set({ pendingBondAtom: index }),
  pushRedo: (op) => set((s) => ({ redoStack: [...s.redoStack, op] })),
  popRedo: () => {
    const stack = get().redoStack;
    if (stack.length === 0) return null;
    const op = stack[stack.length - 1];
    set({ redoStack: stack.slice(0, -1) });
    return op;
  },
  clearRedo: () => set({ redoStack: [] }),
  setHandlers: (handlers) => set({ handlers }),
});

/** App-wide singleton — used when no <MeganeProvider> is mounted. */
export const useBuildStore = create<BuildStore>(buildStateCreator);

/** Private Build-panel state for one viewer. */
export function createBuildStore(): StoreApi<BuildStore> {
  return createStore<BuildStore>(buildStateCreator);
}

// Test-only window hook (`window.__megane_test_build_store`), so Playwright
// specs can call the Build panel's pick / drag handlers without scripting
// WebGL hit-tests. No-op outside testMode — see ./testRegistry.ts.
registerTestStores(GLOBAL_BUNDLE_ID, { build: useBuildStore });
