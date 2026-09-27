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
 * A dialog that is about to write an op (a supercell, a slab, a new cell) can
 * show it first: `setPreview(op)` applies it to the edited structure without
 * committing it, the view draws `preview` instead (`viewSnapshot`), and clicks
 * in the view are paused until the op is applied (`pushOp`) or dropped
 * (`setPreview(null)`).
 *
 * Atom indices in `selected` / `pendingBondAtom` and in the Viewport's
 * callbacks address the *rendered* structure; `result.refAt` translates
 * them to op refs before an op is written.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import { applyEditOps, type EditResult } from "../pipeline/executors/edit";
import type { EditAtomRef, EditOp } from "../pipeline/types";
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

/**
 * The one message the app shows at a time (an open error, a library import,
 * a refused crystal spec): every panel reports through it instead of keeping
 * its own error line, so feedback always appears in the same place.
 */
export interface BuilderNotice {
  level: "info" | "error";
  text: string;
}

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
   * An op a dialog is about to write, applied to `result` but not committed:
   * what the view draws while it is set. Any change to the document drops it.
   */
  preview: EditResult | null;
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
  /** With the Select tool, a drag on the view draws a box and selects what it holds. */
  boxSelect: boolean;
  /** The message on screen, if any; see `BuilderNotice`. */
  notice: BuilderNotice | null;

  // ── Document actions ──
  /** Start a document from a parsed structure. Replaces everything. */
  openStructure: (snapshot: Snapshot, labels: string[] | null, fileName: string) => void;
  /** Start a document from an empty cubic cell of edge `edge` Å. */
  newCell: (edge: number) => void;
  /** Start a document from a bulk crystal (`bulkSnapshot`). Throws on a bad spec. */
  newBulk: (spec: BulkSpec) => void;
  pushOp: (op: EditOp) => void;
  /** Append several ops as one user action: a single Undo / Redo step. */
  pushOps: (ops: EditOp[]) => void;
  /** Replace the most recent op (a drag in progress). */
  replaceLastOp: (op: EditOp) => void;
  /** Pop the most recent op onto the redo stack; returns it, or null. */
  undo: () => EditOp | null;
  /** Re-apply the most recently undone op; returns it, or null. */
  redo: () => EditOp | null;
  clearOps: () => void;
  setShowOriginal: (on: boolean) => void;
  /**
   * Show `op` applied to the edited structure without committing it, or stop
   * showing it with null. An op that cannot be applied shows nothing.
   */
  setPreview: (op: EditOp | null) => void;

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
  setBoxSelect: (on: boolean) => void;
  /** Show a message (replacing the current one), or clear it with null. */
  setNotice: (notice: BuilderNotice | null) => void;
  /** Shorthand for an error notice. */
  reportError: (text: string) => void;
  /** Shorthand for an informational notice. */
  reportInfo: (text: string) => void;
  /**
   * Drop a library molecule into the document with its centroid at `at`, as
   * one `add_fragment` op, and select the new atoms so a Move drag carries
   * the whole molecule. Returns the op's fragment id, or null when the
   * document is not editable.
   */
  addFragment: (molecule: LibraryMolecule, at: [number, number, number]) => string | null;
  /**
   * Move rendered atoms by their own displacements (a set distance, a
   * rotation, a cleaned-up geometry) as one Undo step: one `move_atoms` op per
   * distinct displacement. Returns whether anything was written.
   */
  moveAtoms: (displacements: Map<number, [number, number, number]>) => boolean;
  /** Select every rendered atom. */
  selectAll: () => void;
  /** Select the atoms that are not selected, and deselect the rest. */
  invertSelection: () => void;
}

/** The structure the 3D view draws for `state`: edited, or the source under the preview. */
export function shownSnapshot(state: Pick<BuilderStore, "source" | "result" | "showOriginal">) {
  if (!state.source) return null;
  return state.showOriginal ? state.source : (state.result?.snapshot ?? state.source);
}

/** What the 3D view draws: the preview of a pending op if there is one, else `shownSnapshot`. */
export function viewSnapshot(
  state: Pick<BuilderStore, "source" | "result" | "showOriginal" | "preview">,
) {
  return state.preview && !state.showOriginal ? state.preview.snapshot : shownSnapshot(state);
}

/**
 * Whether clicks may write ops: a document is open, the edited structure is
 * what is shown, and no dialog is previewing an op over it.
 */
export function canEdit(
  state: Pick<BuilderStore, "source" | "result" | "showOriginal"> &
    Partial<Pick<BuilderStore, "preview">>,
) {
  return !!state.source && !!state.result && !state.showOriginal && !state.preview;
}

/**
 * Ops pushed as the tail of a `pushOps` group. Undo keeps popping while it
 * pops one of these, and Redo keeps re-applying while the next one is, so a
 * multi-op action (an atom plus its hydrogens) moves as one step. Keyed by op
 * identity, so the op list itself stays plain `EditOp`s.
 */
const continuations = new WeakSet<EditOp>();

/**
 * The history as the user made it: one group per Undo step (an op plus the
 * ops pushed with it — an atom and its hydrogens, the moves of a cleaned-up
 * molecule), in order.
 */
export function editSteps(edits: EditOp[]): EditOp[][] {
  const steps: EditOp[][] = [];
  for (const op of edits) {
    if (continuations.has(op) && steps.length > 0) steps[steps.length - 1].push(op);
    else steps.push([op]);
  }
  return steps;
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
  preview: null,
  revision: 0,

  tool: "select",
  element: 6,
  bondOrder: 1,
  selected: [],
  pendingBondAtom: null,
  handlers: null,
  placeSource: null,
  adsorbHeight: null,
  boxSelect: false,
  notice: null,

  openStructure: (snapshot, labels, fileName) =>
    set({
      source: snapshot,
      sourceLabels: labels,
      fileName,
      edits: [],
      redoStack: [],
      showOriginal: false,
      result: compute(snapshot, []),
      preview: null,
      selected: [],
      pendingBondAtom: null,
      notice: null,
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
        preview: null,
        revision: s.revision + 1,
      };
    }),

  pushOps: (ops) => {
    if (ops.length === 0) return;
    ops.slice(1).forEach((op) => continuations.add(op));
    set((s) => {
      const edits = [...s.edits, ...ops];
      return {
        edits,
        redoStack: [],
        result: compute(s.source, edits),
        preview: null,
        revision: s.revision + 1,
      };
    });
  },

  replaceLastOp: (op) =>
    set((s) => {
      if (s.edits.length === 0) return {};
      const edits = [...s.edits.slice(0, -1), op];
      return { edits, result: compute(s.source, edits), preview: null, revision: s.revision + 1 };
    }),

  undo: () => {
    const s = get();
    if (s.edits.length === 0) return null;
    const edits = s.edits.slice();
    const redoStack = s.redoStack.slice();
    let op: EditOp;
    do {
      op = edits.pop()!;
      redoStack.push(op);
    } while (continuations.has(op) && edits.length > 0);
    set({
      edits,
      redoStack,
      result: compute(s.source, edits),
      preview: null,
      revision: s.revision + 1,
      selected: [],
      pendingBondAtom: null,
    });
    return op;
  },

  redo: () => {
    const s = get();
    if (s.redoStack.length === 0) return null;
    const redoStack = s.redoStack.slice();
    const op = redoStack.pop()!;
    const edits = [...s.edits, op];
    while (redoStack.length > 0 && continuations.has(redoStack[redoStack.length - 1])) {
      edits.push(redoStack.pop()!);
    }
    set({
      edits,
      redoStack,
      result: compute(s.source, edits),
      preview: null,
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
            preview: null,
            revision: s.revision + 1,
            selected: [],
            pendingBondAtom: null,
          },
    ),

  setShowOriginal: (on) =>
    set((s) =>
      s.showOriginal === on
        ? {}
        : {
            showOriginal: on,
            preview: null,
            revision: s.revision + 1,
            selected: [],
            pendingBondAtom: null,
          },
    ),

  setPreview: (op) =>
    set((s) => {
      if (!op || !s.result || s.showOriginal) {
        return s.preview ? { preview: null, revision: s.revision + 1 } : {};
      }
      let preview: EditResult | null;
      try {
        preview = applyEditOps(s.result.snapshot, [op]);
      } catch {
        preview = null;
      }
      // The selection addresses the edited structure, not the preview.
      return { preview, revision: s.revision + 1, selected: [], pendingBondAtom: null };
    }),

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
  setBoxSelect: (boxSelect) => set({ boxSelect }),
  setNotice: (notice) => set({ notice }),
  reportError: (text) => set({ notice: { level: "error", text } }),
  reportInfo: (text) => set({ notice: { level: "info", text } }),
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
  moveAtoms: (displacements) => {
    const s = get();
    if (!canEdit(s)) return false;
    const n = s.result!.snapshot.nAtoms;
    const groups = new Map<string, { delta: [number, number, number]; atoms: EditAtomRef[] }>();
    for (const [i, delta] of displacements) {
      if (i < 0 || i >= n || delta.every((v) => Math.abs(v) < 1e-9)) continue;
      const ref = s.result!.refAt(i);
      if (ref === null) continue;
      const key = delta.map((v) => v.toFixed(9)).join(",");
      const group = groups.get(key) ?? { delta, atoms: [] };
      group.atoms.push(ref);
      groups.set(key, group);
    }
    if (groups.size === 0) return false;
    s.pushOps(
      [...groups.values()].map((g) => ({ op: "move_atoms", atoms: g.atoms, delta: g.delta })),
    );
    return true;
  },
  selectAll: () =>
    set((s) => {
      const n = viewSnapshot(s)?.nAtoms ?? 0;
      return { selected: Array.from({ length: n }, (_, i) => i), pendingBondAtom: null };
    }),
  invertSelection: () =>
    set((s) => {
      const n = viewSnapshot(s)?.nAtoms ?? 0;
      const chosen = new Set(s.selected);
      return {
        selected: Array.from({ length: n }, (_, i) => i).filter((i) => !chosen.has(i)),
        pendingBondAtom: null,
      };
    }),
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
