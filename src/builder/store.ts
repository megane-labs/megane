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
 * them to op refs before an op is written. Every change to the history
 * carries the selection across by those refs (`remapSelection`): an atom
 * keeps its place in the selection wherever it lands, and one that no longer
 * exists drops out.
 *
 * A drag rewrites its own moves on every pointer move (`setDragOps`); the
 * history before it is replayed once, at the drag's first move, and each
 * further move only shifts the moved atoms of that cached result
 * (`applyMoves`) instead of replaying the whole history again.
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
import { moveOps, type AxisKey, type DragMode, type DragReadout } from "./manipulate";
import { labelStep } from "./placement";

/** A structure with no atoms and no cell: what placing a molecule with nothing open starts from. */
export function emptySnapshot(): Snapshot {
  return {
    nAtoms: 0,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(0),
    elements: new Uint8Array(0),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** A structure with no atoms and a cubic cell of edge `edge` Å: the blank sheet. */
export function emptyCellSnapshot(edge: number): Snapshot {
  const a = Math.max(edge, 0.1);
  return { ...emptySnapshot(), box: new Float32Array([a, 0, 0, 0, a, 0, 0, 0, a]) };
}

/** File name the Builder gives a document that started from a blank cell. */
export const UNTITLED = "untitled";

/** A drag of atoms in progress, for the status line and the view's warnings. */
export interface DragStatus {
  mode: DragMode;
  /** The axis the drag is locked to (an axis key pressed mid-drag), or null. */
  axis: AxisKey | null;
  /** What the drag did so far; null until the pointer moves. */
  readout: DragReadout | null;
  /** Rendered atoms in a close contact the drag made (see `closeContacts`). */
  contacts: number[];
}

/**
 * The one message the app shows at a time (an open error, a library import,
 * a refused crystal spec): every panel reports through it instead of keeping
 * its own error line, so feedback always appears in the same place.
 */
export interface BuilderNotice {
  level: "info" | "error";
  text: string;
}

/**
 * A question the app asks before it does something that cannot be undone
 * (replacing a document with unsaved edits, deleting a library molecule):
 * `requestConfirm` puts it here, `ConfirmHost` draws it over the Builder, and
 * the answer resolves the promise. An in-app dialog rather than
 * `window.confirm`, which VS Code webviews do not show.
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Label of the button that goes ahead ("Discard edits"). */
  confirmLabel: string;
  /** Draw the go-ahead button in the danger colour. */
  danger?: boolean;
}

/**
 * How Add, Element, Delete and Bond keep explicit hydrogens balanced:
 * `auto` does it while the document has any H atom (a bare skeleton stays
 * bare), `on` always, `off` never.
 */
export type HydrogenMode = "auto" | "on" | "off";

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
  /**
   * Bumped by every change to the document's content (an op, undo, redo,
   * clear); `savedVersion` is its value when the document was opened or last
   * saved, so the two differ exactly while there are unsaved edits
   * (`isDirty`).
   */
  docVersion: number;
  savedVersion: number;

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
  /**
   * With the Select tool, a left drag that does not move the selection draws
   * a box and selects what it holds, instead of turning the view.
   */
  boxSelect: boolean;
  /** Round drags to `SNAP_DISTANCE` Å / `SNAP_ANGLE`°. */
  snap: boolean;
  /** The drag in progress, or null. Keyboard shortcuts pause while it is set. */
  drag: DragStatus | null;
  /** The message on screen, if any; see `BuilderNotice`. */
  notice: BuilderNotice | null;
  /** How explicit hydrogens are kept balanced; see `HydrogenMode`. */
  hydrogenMode: HydrogenMode;
  /** The question on screen, if any; see `ConfirmRequest`. */
  confirm: ConfirmRequest | null;

  // ── Document actions ──
  /** Start a document from a parsed structure. Replaces everything. */
  openStructure: (snapshot: Snapshot, labels: string[] | null, fileName: string) => void;
  /** Drop the document: back to the empty start screen. */
  closeDocument: () => void;
  /** Start a document from an empty cubic cell of edge `edge` Å. */
  newCell: (edge: number) => void;
  /** Start a document from a bulk crystal (`bulkSnapshot`). Throws on a bad spec. */
  newBulk: (spec: BulkSpec) => void;
  /** Append an op as one Undo step; `label` says what the user did, for the history list. */
  pushOp: (op: EditOp, label?: string) => void;
  /**
   * Append several ops as one user action: a single Undo / Redo step, listed
   * in the history as `label` when given ("Delete O #5 (+2 H)").
   */
  pushOps: (ops: EditOp[], label?: string) => void;
  /** Replace the most recent op. */
  replaceLastOp: (op: EditOp) => void;
  /**
   * Replace every op after the first `base` with `ops`, as one Undo step: a
   * drag rewriting what it has written so far. Empty `ops` leave the history
   * at `base`.
   */
  setDragOps: (base: number, ops: EditOp[]) => void;
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
  /** Record that the document as it is now has been saved (`isDirty` turns false). */
  markSaved: () => void;
  /**
   * Ask `request` in the confirm dialog; resolves to whether the user went
   * ahead. A question still open is answered "no" first.
   */
  requestConfirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Answer the open question (the confirm dialog's buttons). */
  resolveConfirm: (ok: boolean) => void;

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
  setSnap: (on: boolean) => void;
  setHydrogenMode: (mode: HydrogenMode) => void;
  setDrag: (drag: DragStatus | null) => void;
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
  moveAtoms: (displacements: Map<number, [number, number, number]>, label?: string) => boolean;
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
 * The residue labels of the edited structure, atom by atom: each atom keeps
 * the label of the source atom it came from (followed through deletions and
 * reorders by its op ref), and an atom the edits added gets none (`UNK` in a
 * PDB). Null when the source had no labels.
 */
export function editedLabels(
  state: Pick<BuilderStore, "source" | "sourceLabels" | "result">,
): string[] | null {
  const { sourceLabels, result } = state;
  if (!sourceLabels || !result) return sourceLabels;
  const out: string[] = [];
  for (let i = 0; i < result.snapshot.nAtoms; i++) {
    const ref = result.refAt(i);
    out.push(typeof ref === "number" ? (sourceLabels[ref] ?? "") : "");
  }
  return out;
}

/** Whether the open document has edits that were not saved. */
export function isDirty(state: Pick<BuilderStore, "source" | "docVersion" | "savedVersion">) {
  return !!state.source && state.docVersion !== state.savedVersion;
}

/**
 * Ask before an action replaces the open document (`action` names it: "Open
 * water.pdb"). Resolves to true at once when there is nothing unsaved to lose.
 */
export function confirmDiscard(api: StoreApi<BuilderStore>, action: string): Promise<boolean> {
  const s = api.getState();
  if (!isDirty(s)) return Promise.resolve(true);
  const steps = s.edits.length;
  return s.requestConfirm({
    title: "Discard unsaved edits?",
    message: `${action} replaces the open structure${s.fileName ? ` (${s.fileName})` : ""} and its history${steps > 0 ? ` of ${steps} edit${steps === 1 ? "" : "s"}` : ""}. Save it first to keep the edits.`,
    confirmLabel: "Discard edits",
    danger: true,
  });
}

/** The answer waiting on the open `ConfirmRequest`, per store. */
const confirmResolvers = new WeakMap<object, (ok: boolean) => void>();

/** A content change also clears an error notice: the error is about what came before. */
function clearedError(s: Pick<BuilderStore, "notice">): Partial<BuilderStore> {
  return s.notice?.level === "error" ? { notice: null } : {};
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

/**
 * The selection (and the Bond tool's first atom) carried from `before` to
 * `after` by atom ref: each atom keeps its place in the selection under its
 * new index, and an atom `after` no longer has drops out.
 */
export function remapSelection(
  before: EditResult | null,
  after: EditResult | null,
  s: Pick<BuilderStore, "selected" | "pendingBondAtom">,
): Pick<BuilderStore, "selected" | "pendingBondAtom"> {
  const { selected, pendingBondAtom } = s;
  if ((selected.length === 0 && pendingBondAtom === null) || before === after) {
    return { selected, pendingBondAtom };
  }
  if (!before || !after) return { selected: [], pendingBondAtom: null };
  const n = before.snapshot.nAtoms;
  const refOf = (i: number) => (i >= 0 && i < n ? before.refAt(i) : null);
  const wanted = new Map<EditAtomRef, number>();
  for (const i of [...selected, ...(pendingBondAtom !== null ? [pendingBondAtom] : [])]) {
    const ref = refOf(i);
    if (ref !== null) wanted.set(ref, -1);
  }
  let left = wanted.size;
  for (let i = 0; i < after.snapshot.nAtoms && left > 0; i++) {
    const ref = after.refAt(i);
    if (wanted.get(ref) === -1) {
      wanted.set(ref, i);
      left--;
    }
  }
  const to = (i: number) => {
    const ref = refOf(i);
    const j = ref === null ? undefined : wanted.get(ref);
    return j === undefined || j < 0 ? null : j;
  };
  return {
    selected: selected.map(to).filter((i): i is number => i !== null),
    pendingBondAtom: pendingBondAtom === null ? null : to(pendingBondAtom),
  };
}

/**
 * `base` with `ops` applied, when they are all `move_atoms` of atoms `base`
 * has (`indexOf`): the moved atoms shifted, everything else shared. Null
 * otherwise, for a full replay. What a drag's every pointer move does
 * instead of replaying the whole history.
 */
export function applyMoves(
  base: EditResult,
  ops: EditOp[],
  indexOf: (ref: EditAtomRef) => number | undefined,
): EditResult | null {
  const positions = new Float32Array(base.snapshot.positions);
  for (const op of ops) {
    if (op.op !== "move_atoms") return null;
    const [dx, dy, dz] = op.delta;
    for (const ref of op.atoms) {
      const i = indexOf(ref);
      if (i === undefined) return null;
      positions[i * 3] += dx;
      positions[i * 3 + 1] += dy;
      positions[i * 3 + 2] += dz;
    }
  }
  return {
    snapshot: { ...base.snapshot, positions },
    refAt: base.refAt,
    get outputRefs() {
      return base.outputRefs;
    },
    warnings: base.warnings,
  };
}

/** The history a drag started from, replayed once (see `setDragOps`). */
interface DragBase {
  source: Snapshot;
  /** The ops before the drag's own, as they were at its first move. */
  prefix: EditOp[];
  result: EditResult;
  /** Ref → rendered index in `result`, built on first use. */
  index: Map<EditAtomRef, number> | null;
}

export const builderStateCreator: StateCreator<BuilderStore> = (set, get, storeApi) => {
  let dragBase: DragBase | null = null;

  /** `dragBase` if it still describes the first `base` ops of `edits` on `source`. */
  const cachedBase = (source: Snapshot | null, edits: EditOp[], base: number) => {
    const c = dragBase;
    if (!c || c.source !== source || c.prefix.length !== base || edits.length < base) return null;
    for (let k = 0; k < base; k++) if (c.prefix[k] !== edits[k]) return null;
    return c;
  };

  /** The result of `edits` after a drag rewrote the ops past `base`; see `applyMoves`. */
  const dragResult = (
    s: BuilderStore,
    base: number,
    ops: EditOp[],
    edits: EditOp[],
  ): { result: EditResult | null; moved: boolean } => {
    let c = cachedBase(s.source, s.edits, base);
    if (!c && s.source && s.result && s.edits.length === base) {
      // The drag's first move: the history so far is what is shown.
      c = dragBase = { source: s.source, prefix: s.edits, result: s.result, index: null };
    }
    if (c) {
      if (ops.length === 0) return { result: c.result, moved: true };
      const cache = c;
      const indexOf = (ref: EditAtomRef) => {
        if (!cache.index) {
          cache.index = new Map();
          for (let i = 0; i < cache.result.snapshot.nAtoms; i++) {
            cache.index.set(cache.result.refAt(i), i);
          }
        }
        return cache.index.get(ref);
      };
      const result = applyMoves(c.result, ops, indexOf);
      if (result) return { result, moved: true };
    }
    return { result: compute(s.source, edits), moved: false };
  };

  return {
    source: null,
    sourceLabels: null,
    fileName: null,
    edits: [],
    redoStack: [],
    showOriginal: false,
    result: null,
    preview: null,
    revision: 0,
    docVersion: 0,
    savedVersion: 0,

    tool: "select",
    element: 6,
    bondOrder: 1,
    selected: [],
    pendingBondAtom: null,
    handlers: null,
    placeSource: null,
    adsorbHeight: null,
    boxSelect: false,
    snap: false,
    drag: null,
    notice: null,
    hydrogenMode: "auto",
    confirm: null,

    openStructure: (snapshot, labels, fileName) =>
      set((s) => ({
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
        docVersion: s.docVersion + 1,
        savedVersion: s.docVersion + 1,
      })),

    closeDocument: () =>
      set((s) => ({
        source: null,
        sourceLabels: null,
        fileName: null,
        edits: [],
        redoStack: [],
        showOriginal: false,
        result: null,
        preview: null,
        selected: [],
        pendingBondAtom: null,
        notice: null,
        docVersion: s.docVersion + 1,
        savedVersion: s.docVersion + 1,
      })),

    newCell: (edge) => get().openStructure(emptyCellSnapshot(edge), null, UNTITLED),
    newBulk: (spec) => get().openStructure(bulkSnapshot(spec), null, bulkName(spec)),

    pushOp: (op, label) => {
      labelStep([op], label);
      set((s) => {
        const edits = [...s.edits, op];
        const result = compute(s.source, edits);
        return {
          edits,
          redoStack: [],
          result,
          ...remapSelection(s.result, result, s),
          preview: null,
          revision: s.revision + 1,
          docVersion: s.docVersion + 1,
          ...clearedError(s),
        };
      });
    },

    pushOps: (ops, label) => {
      if (ops.length === 0) return;
      ops.slice(1).forEach((op) => continuations.add(op));
      labelStep(ops, label);
      set((s) => {
        const edits = [...s.edits, ...ops];
        const result = compute(s.source, edits);
        return {
          edits,
          redoStack: [],
          result,
          ...remapSelection(s.result, result, s),
          preview: null,
          revision: s.revision + 1,
          docVersion: s.docVersion + 1,
          ...clearedError(s),
        };
      });
    },

    replaceLastOp: (op) =>
      set((s) => {
        if (s.edits.length === 0) return {};
        const edits = [...s.edits.slice(0, -1), op];
        const result = compute(s.source, edits);
        return {
          edits,
          result,
          ...remapSelection(s.result, result, s),
          preview: null,
          revision: s.revision + 1,
          docVersion: s.docVersion + 1,
        };
      }),

    setDragOps: (base, ops) => {
      ops.slice(1).forEach((op) => continuations.add(op));
      set((s) => {
        if (base > s.edits.length) return {};
        const edits = [...s.edits.slice(0, base), ...ops];
        const { result, moved } = dragResult(s, base, ops, edits);
        return {
          edits,
          ...(ops.length > 0 ? { redoStack: [] } : {}),
          result,
          // Moves keep every atom where it is in the list.
          ...(moved ? {} : remapSelection(s.result, result, s)),
          preview: null,
          revision: s.revision + 1,
          docVersion: s.docVersion + 1,
          ...clearedError(s),
        };
      });
    },

    undo: () => {
      const s = get();
      // While the original is shown the edits are out of sight: leave them be.
      if (s.edits.length === 0 || s.showOriginal) return null;
      const edits = s.edits.slice();
      const redoStack = s.redoStack.slice();
      let op: EditOp;
      do {
        op = edits.pop()!;
        redoStack.push(op);
      } while (continuations.has(op) && edits.length > 0);
      const result = compute(s.source, edits);
      set({
        edits,
        redoStack,
        result,
        ...remapSelection(s.result, result, s),
        preview: null,
        revision: s.revision + 1,
        docVersion: s.docVersion + 1,
      });
      return op;
    },

    redo: () => {
      const s = get();
      if (s.redoStack.length === 0 || s.showOriginal) return null;
      const redoStack = s.redoStack.slice();
      const op = redoStack.pop()!;
      const edits = [...s.edits, op];
      while (redoStack.length > 0 && continuations.has(redoStack[redoStack.length - 1])) {
        edits.push(redoStack.pop()!);
      }
      const result = compute(s.source, edits);
      set({
        edits,
        redoStack,
        result,
        ...remapSelection(s.result, result, s),
        preview: null,
        revision: s.revision + 1,
        docVersion: s.docVersion + 1,
      });
      return op;
    },

    // Undo every step at once: the ops go onto the redo stack in the order
    // single undos would leave them, so Redo brings them back step by step.
    clearOps: () =>
      set((s) => {
        if (s.edits.length === 0 || s.showOriginal) return {};
        const result = compute(s.source, []);
        return {
          edits: [],
          redoStack: [...s.redoStack, ...s.edits.slice().reverse()],
          result,
          ...remapSelection(s.result, result, s),
          preview: null,
          revision: s.revision + 1,
          docVersion: s.docVersion + 1,
        };
      }),

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

    markSaved: () => set((s) => ({ savedVersion: s.docVersion })),

    requestConfirm: (request) => {
      confirmResolvers.get(storeApi)?.(false);
      return new Promise<boolean>((resolve) => {
        confirmResolvers.set(storeApi, resolve);
        set({ confirm: request });
      });
    },

    resolveConfirm: (ok) => {
      const resolve = confirmResolvers.get(storeApi);
      confirmResolvers.delete(storeApi);
      set({ confirm: null });
      resolve?.(ok);
    },

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
    setSnap: (snap) => set({ snap }),
    setHydrogenMode: (hydrogenMode) => set({ hydrogenMode }),
    setDrag: (drag) => set({ drag }),
    setNotice: (notice) => set({ notice }),
    reportError: (text) => set({ notice: { level: "error", text } }),
    reportInfo: (text) => set({ notice: { level: "info", text } }),
    addFragment: (molecule, at) => {
      // With nothing open, the molecule starts a new, cell-less document.
      if (!get().source) get().openStructure(emptySnapshot(), null, UNTITLED);
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
    moveAtoms: (displacements, label) => {
      const s = get();
      if (!canEdit(s)) return false;
      const n = s.result!.snapshot.nAtoms;
      const refs = new Map<number, EditAtomRef>();
      for (const i of displacements.keys()) {
        const ref = i >= 0 && i < n ? s.result!.refAt(i) : null;
        if (ref !== null) refs.set(i, ref);
      }
      const ops = moveOps(displacements, refs);
      if (ops.length === 0) return false;
      s.pushOps(ops, label);
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
  };
};

/** The page-wide store: the document of a Builder mounted without `BuilderProvider`. */
export const useBuilderStore = create<BuilderStore>(builderStateCreator);

/** A private store (tests, one Builder of several on a page: `BuilderStores.tsx`). */
export function createBuilderStore(): StoreApi<BuilderStore> {
  return createStore<BuilderStore>(builderStateCreator);
}

// Test-only window hook (`window.__megane_test_builder_store`), so Playwright
// specs can drive the pick / drag handlers without scripting WebGL hit-tests.
registerTestStores(GLOBAL_BUNDLE_ID, { builder: useBuilderStore });
