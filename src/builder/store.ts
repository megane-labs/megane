/**
 * The Builder's document and tool state.
 *
 * The Builder is a structure *editor*, separate from the viewer: it has no
 * pipeline graph. Its document is a source structure (a file, or a blank
 * cell) plus an ordered list of edit operations, and what the 3D view shows is
 * always `applyEditOps(source, edits)` (or the source alone while "Show
 * original" is on). Undo and Redo move ops between `edits` and `redoStack`;
 * saving bakes the result into a file. The op list, its atom addressing and
 * the replay itself are the same engine the viewer's `load_structure` node
 * uses (`pipeline/executors/edit.ts`), which is what will let a Builder
 * document travel into the viewer later.
 *
 * Atom indices in `selected` / `pendingBondAtom` and in the Viewport's
 * callbacks address the *rendered* structure; `result.refAt` translates
 * them to op refs before an op is written.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { applyEditOps, type EditResult } from "../pipeline/executors/edit";
import type { EditOp } from "../pipeline/types";
import type { Snapshot } from "../types";
import { registerTestStores, GLOBAL_BUNDLE_ID } from "../stores/testRegistry";
import type { BuildHandlers, BuildTool } from "./types";
import { fragmentOp, newFragmentId } from "./library/fragment";
import type { LibraryMolecule } from "./library/types";
import { bulkName, bulkSnapshot, type BulkSpec } from "../crystal/bulk";

/** A structure with no atoms and a cubic cell of edge `edge` Å: the blank sheet. */
export function emptyCellSnapshot(edge: number): Snapshot {
  const a = Math.max(edge, 0.1);
  return {
    nAtoms: 0,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(0),
    elements: new Uint8Array(0),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: new Float32Array([a, 0, 0, 0, a, 0, 0, 0, a]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** File name the Builder gives a document that started from a blank cell. */
export const UNTITLED = "untitled";

export interface BuilderStore {
  // ── Document ──
  /** The structure as loaded (or the blank cell); never mutated. */
  source: Snapshot | null;
  /** Per-atom residue labels of the source, for PDB export. */
  sourceLabels: string[] | null;
  fileName: string | null;
  edits: EditOp[];
  /** Ops removed by Undo, most recent last. Cleared by the next new op. */
  redoStack: EditOp[];
  /** Preview the source without its edits; editing is paused while on. */
  showOriginal: boolean;
  /** `applyEditOps(source, edits)`, recomputed whenever either changes. */
  result: EditResult | null;
  /**
   * Bumped by every change that reshapes the rendered structure without
   * replacing the document (an op, undo, redo, the preview toggle): the view
   * keeps its camera across such changes and re-fits only for a new document.
   */
  revision: number;

  // ── Tools ──
  tool: BuildTool;
  /** Atomic number used by the Add and Element tools. */
  element: number;
  /** Bond order used by the Bond tool and by Add's auto-bond. */
  bondOrder: number;
  /** Rendered-atom indices selected in the 3D view. */
  selected: number[];
  /** First atom clicked with the Bond tool; the next click completes the bond. */
  pendingBondAtom: number | null;
  /** Installed by the mounted app; null otherwise. */
  handlers: BuildHandlers | null;
  /** The library molecule the Place tool stamps; null until one is chosen. */
  placeSource: LibraryMolecule | null;
  /**
   * When set, the Place tool also accepts a click *on* an atom and stamps the
   * molecule this many Å above it along the cell's c axis (or +z without a
   * cell) — an adsorbate on a surface site. Null keeps clicks on atoms inert.
   */
  adsorbHeight: number | null;

  // ── Document actions ──
  /** Start a document from a parsed structure. Replaces everything. */
  openStructure: (snapshot: Snapshot, labels: string[] | null, fileName: string) => void;
  /** Start a document from an empty cubic cell of edge `edge` Å. */
  newCell: (edge: number) => void;
  /** Start a document from a bulk crystal (`bulkSnapshot`). Throws on a bad spec. */
  newBulk: (spec: BulkSpec) => void;
  pushOp: (op: EditOp) => void;
  /** Replace the most recent op (a drag in progress). */
  replaceLastOp: (op: EditOp) => void;
  /** Pop the most recent op onto the redo stack; returns it, or null. */
  undo: () => EditOp | null;
  /** Re-apply the most recently undone op; returns it, or null. */
  redo: () => EditOp | null;
  clearOps: () => void;
  setShowOriginal: (on: boolean) => void;

  // ── Tool actions ──
  setTool: (tool: BuildTool) => void;
  setElement: (element: number) => void;
  setBondOrder: (order: number) => void;
  setSelected: (indices: number[]) => void;
  toggleSelected: (index: number) => void;
  clearSelected: () => void;
  setPendingBondAtom: (index: number | null) => void;
  setHandlers: (handlers: BuildHandlers | null) => void;
  /** Choose the molecule the Place tool stamps (and switch to that tool), or clear it. */
  setPlaceSource: (molecule: LibraryMolecule | null) => void;
  setAdsorbHeight: (height: number | null) => void;
  /**
   * Drop a library molecule into the document with its centroid at `at`, as
   * one `add_fragment` op, and select the new atoms so a Move drag carries
   * the whole molecule. Returns the op's fragment id, or null when the
   * document is not editable.
   */
  addFragment: (molecule: LibraryMolecule, at: [number, number, number]) => string | null;
}

/** The structure the 3D view draws for `state`: edited, or the source under the preview. */
export function shownSnapshot(state: Pick<BuilderStore, "source" | "result" | "showOriginal">) {
  if (!state.source) return null;
  return state.showOriginal ? state.source : (state.result?.snapshot ?? state.source);
}

/** Whether clicks may write ops: a document is open and the edited structure is what is shown. */
export function canEdit(state: Pick<BuilderStore, "source" | "result" | "showOriginal">) {
  return !!state.source && !!state.result && !state.showOriginal;
}

function compute(source: Snapshot | null, edits: EditOp[]): EditResult | null {
  return source ? applyEditOps(source, edits) : null;
}

export const builderStateCreator: StateCreator<BuilderStore> = (set, get) => ({
  source: null,
  sourceLabels: null,
  fileName: null,
  edits: [],
  redoStack: [],
  showOriginal: false,
  result: null,
  revision: 0,

  tool: "select",
  element: 6,
  bondOrder: 1,
  selected: [],
  pendingBondAtom: null,
  handlers: null,
  placeSource: null,
  adsorbHeight: null,

  openStructure: (snapshot, labels, fileName) =>
    set({
      source: snapshot,
      sourceLabels: labels,
      fileName,
      edits: [],
      redoStack: [],
      showOriginal: false,
      result: compute(snapshot, []),
      selected: [],
      pendingBondAtom: null,
    }),

  newCell: (edge) => get().openStructure(emptyCellSnapshot(edge), null, UNTITLED),
  newBulk: (spec) => get().openStructure(bulkSnapshot(spec), null, bulkName(spec)),

  pushOp: (op) =>
    set((s) => {
      const edits = [...s.edits, op];
      return {
        edits,
        redoStack: [],
        result: compute(s.source, edits),
        revision: s.revision + 1,
      };
    }),

  replaceLastOp: (op) =>
    set((s) => {
      if (s.edits.length === 0) return {};
      const edits = [...s.edits.slice(0, -1), op];
      return { edits, result: compute(s.source, edits), revision: s.revision + 1 };
    }),

  undo: () => {
    const s = get();
    if (s.edits.length === 0) return null;
    const op = s.edits[s.edits.length - 1];
    const edits = s.edits.slice(0, -1);
    set({
      edits,
      redoStack: [...s.redoStack, op],
      result: compute(s.source, edits),
      revision: s.revision + 1,
      selected: [],
      pendingBondAtom: null,
    });
    return op;
  },

  redo: () => {
    const s = get();
    if (s.redoStack.length === 0) return null;
    const op = s.redoStack[s.redoStack.length - 1];
    const edits = [...s.edits, op];
    set({
      edits,
      redoStack: s.redoStack.slice(0, -1),
      result: compute(s.source, edits),
      revision: s.revision + 1,
    });
    return op;
  },

  clearOps: () =>
    set((s) =>
      s.edits.length === 0
        ? {}
        : {
            edits: [],
            redoStack: [],
            result: compute(s.source, []),
            revision: s.revision + 1,
            selected: [],
            pendingBondAtom: null,
          },
    ),

  setShowOriginal: (on) =>
    set((s) =>
      s.showOriginal === on
        ? {}
        : { showOriginal: on, revision: s.revision + 1, selected: [], pendingBondAtom: null },
    ),

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
  setHandlers: (handlers) => set({ handlers }),
  setPlaceSource: (molecule) =>
    set((s) =>
      molecule
        ? { placeSource: molecule, tool: "place", pendingBondAtom: null }
        : { placeSource: null, tool: s.tool === "place" ? "select" : s.tool },
    ),
  setAdsorbHeight: (height) =>
    set({ adsorbHeight: height !== null && Number.isFinite(height) ? height : null }),
  addFragment: (molecule, at) => {
    const s = get();
    if (!canEdit(s)) return null;
    const before = s.result!.snapshot.nAtoms;
    const id = newFragmentId(molecule.name);
    s.pushOp(fragmentOp(id, molecule, at));
    const after = get().result!.snapshot.nAtoms;
    const added = Array.from({ length: after - before }, (_, k) => before + k);
    set({ selected: added, pendingBondAtom: null });
    return id;
  },
});

/** The app's store. */
export const useBuilderStore = create<BuilderStore>(builderStateCreator);

/** A private store (tests, embedding). */
export function createBuilderStore(): StoreApi<BuilderStore> {
  return createStore<BuilderStore>(builderStateCreator);
}

// Test-only window hook (`window.__megane_test_builder_store`), so Playwright
// specs can drive the pick / drag handlers without scripting WebGL hit-tests.
registerTestStores(GLOBAL_BUNDLE_ID, { builder: useBuilderStore });
