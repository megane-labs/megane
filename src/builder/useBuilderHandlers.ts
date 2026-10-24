/**
 * The Builder's click / drag semantics for the 3D view, as `BuildHandlers`.
 *
 * Every click becomes one `EditOp` on the store (or a selection change). The
 * Viewport reports rendered atom indices; they are translated to op refs
 * through `result.refAt` so an op always names the atom the user saw.
 *
 * The mouse is the viewer's: a drag the Builder does not take turns the view
 * (left rotates, right and Shift + left pan, middle and the wheel zoom) and a
 * double-click sets the rotation center. Select and Move click to select
 * (Shift / Ctrl / ⌘ toggles) and drag the selection to move it (modifiers turn
 * or spin it, see `manipulate.ts`); Move drags any atom at once, and Select's
 * Box draws a rubber band instead of turning the view.
 *
 * In a headset (WebXR) the same handlers serve the hands: a pinch let go is
 * a `pick`, and a drag reports the hand's rigid motion (`dragRigid`) instead
 * of a pointer gesture, so it writes its moves the same way.
 *
 * The atom and bond edits go through `editActions.ts`, so a click here
 * handles hydrogens exactly as the atom menu, the Inspector and the keys do.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { StoreApi } from "zustand";
import type { EditAtomRef, EditOp } from "../pipeline/types";
import { canEdit, shownSnapshot, type BuilderStore } from "./store";
import { adsorptionSite, atomName } from "./placement";
import { bondOrderBetween } from "./hydrogens";
import {
  addFreeAtom,
  addOnAtom,
  bondAtoms,
  deleteAtoms,
  removeBond,
  setElements,
} from "./editActions";
import { inScope, isTypingTarget } from "./shortcuts";
import {
  AXIS_KEYS,
  axisVector,
  closeContacts,
  dragDisplacements,
  dragModeFor,
  moveOps,
  rigidDisplacements,
  type AxisKey,
  type DragMode,
} from "./manipulate";
import type {
  BuildBoxMode,
  BuildDragGesture,
  BuildHandlers,
  BuildModifiers,
  BuildPickInfo,
  BuildPressAction,
  BuildRigidMotion,
} from "./types";

/** Undo's shortcut, for the close-contact notice. */
const UNDO_KEYS = "Ctrl/⌘ + Z";

/** A drag in progress: what it carries and what it started from. */
interface ActiveDrag {
  /** Length of the history before the drag; its ops follow. */
  base: number;
  /** The redo stack at the press, put back if the drag writes nothing. */
  redoStack: EditOp[];
  atoms: number[];
  refs: Map<number, EditAtomRef>;
  /** Rendered positions at the press. */
  start: Float32Array;
  mode: DragMode;
  axis: AxisKey | null;
  /** The pointer's gesture so far; null until it moves. */
  gesture: BuildDragGesture | null;
  /** A headset hand's motion so far, which replaces the gesture; null for the mouse. */
  rigid: BuildRigidMotion | null;
}

/** Whether `e` asks for the context menu from the keyboard: the Menu key, or Shift + F10. */
export function isMenuKey(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">,
) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

/** What the app hooks in besides the store. */
export interface BuilderHandlerOptions {
  /**
   * Open the atom menu for rendered atom `atom` from the keyboard (the Menu
   * key or Shift + F10 with exactly one atom selected). Without it the keys
   * do nothing.
   */
  openAtomMenu?: (atom: number) => void;
  /** Only keys pressed with the focus inside this element count (an IDE host). */
  scope?: RefObject<HTMLElement | null>;
}

/** Build the handlers for `api` and install them in the store while mounted. */
export function useBuilderHandlers(
  api: StoreApi<BuilderStore>,
  options: BuilderHandlerOptions = {},
): BuildHandlers {
  const { openAtomMenu, scope } = options;
  const refFor = useCallback(
    (renderedIndex: number): EditAtomRef | null => {
      const result = api.getState().result;
      if (!result || renderedIndex < 0 || renderedIndex >= result.snapshot.nAtoms) return null;
      return result.refAt(renderedIndex);
    },
    [api],
  );

  const pick = useCallback(
    (info: BuildPickInfo) => {
      const state = api.getState();
      // Place needs no open document: the first molecule placed starts one.
      if (!state.source && state.tool === "place") {
        if (state.placeSource && info.atomIndex === null && info.world) {
          state.addFragment(state.placeSource, info.world);
        }
        return;
      }
      const snapshot = shownSnapshot(state);
      if (!canEdit(state) || !snapshot) return;
      const { atomIndex } = info;
      switch (state.tool) {
        // Move selects like Select; its drags are what differ (pressAction).
        case "select":
        case "move": {
          const extend = info.shiftKey || !!info.mod;
          if (atomIndex === null) {
            if (!extend) state.clearSelected();
            return;
          }
          if (extend) state.toggleSelected(atomIndex);
          else state.setSelected([atomIndex]);
          return;
        }
        case "add": {
          // Hydrogens follow the hydrogen mode: a click on an H replaces it.
          if (atomIndex !== null) {
            if (refFor(atomIndex) === null) return;
            addOnAtom(state, atomIndex, state.element, state.bondOrder);
          } else if (info.world) {
            addFreeAtom(state, info.world, state.element);
          }
          return;
        }
        case "bond": {
          // A click on empty space lets go of the first atom.
          if (atomIndex === null) {
            if (state.pendingBondAtom !== null) state.setPendingBondAtom(null);
            return;
          }
          if (state.pendingBondAtom === null || state.pendingBondAtom === atomIndex) {
            state.setPendingBondAtom(atomIndex);
            return;
          }
          const first = state.pendingBondAtom;
          state.setPendingBondAtom(null);
          if (refFor(first) === null || refFor(atomIndex) === null) return;
          // Shift on the second atom of a bond removes the bond instead.
          if (info.shiftKey) {
            if (bondOrderBetween(snapshot, first, atomIndex) === 0) {
              state.reportInfo(
                `${atomName(snapshot, first)} and ${atomName(snapshot, atomIndex)} are not bonded: nothing to remove.`,
              );
              return;
            }
            removeBond(state, first, atomIndex);
            return;
          }
          bondAtoms(state, first, atomIndex, state.bondOrder);
          return;
        }
        case "delete": {
          if (atomIndex === null || refFor(atomIndex) === null) return;
          deleteAtoms(state, [atomIndex]);
          return;
        }
        case "element": {
          if (atomIndex === null || refFor(atomIndex) === null) return;
          setElements(state, [atomIndex], state.element);
          return;
        }
        case "place": {
          // Stamp the chosen library molecule at the clicked point. A click on
          // an atom is ignored so a molecule never lands on top of one —
          // unless an adsorption height is set, in which case the molecule
          // goes that far above the atom along the surface normal.
          if (!state.placeSource) return;
          if (atomIndex !== null) {
            if (state.adsorbHeight === null) return;
            state.addFragment(
              state.placeSource,
              adsorptionSite(snapshot, atomIndex, state.adsorbHeight),
            );
            return;
          }
          if (!info.world) return;
          state.addFragment(state.placeSource, info.world);
          return;
        }
      }
    },
    [api, refFor],
  );

  // What a left press does if the pointer moves: Select and Move drag atoms
  // (Select only the ones already selected, so a stray drag never moves an
  // atom by accident), Select draws a box from anywhere else while its Box is
  // on, and every other drag is left to the camera, as in the viewer.
  const pressAction = useCallback(
    (atomIndex: number | null): BuildPressAction => {
      const state = api.getState();
      if (!canEdit(state) || (state.tool !== "select" && state.tool !== "move")) return "camera";
      if (atomIndex !== null && (state.tool === "move" || state.selected.includes(atomIndex)))
        return "move";
      return state.tool === "select" && state.boxSelect ? "box" : "camera";
    },
    [api],
  );

  // A drag rewrites the ops it wrote so far on every move, from the positions
  // at the press, so the history gains a single step however long it runs.
  const drag = useRef<ActiveDrag | null>(null);

  const applyDrag = useCallback(() => {
    const d = drag.current;
    if (!d || (!d.gesture && !d.rigid)) return;
    const state = api.getState();
    const vector = d.axis ? axisVector(d.axis, state.result?.snapshot.box ?? null) : null;
    const { displacements, readout } = d.rigid
      ? rigidDisplacements(d.start, d.atoms, d.rigid, { snap: state.snap })
      : dragDisplacements(d.start, d.atoms, d.mode, d.gesture!, {
          axis: d.axis && vector ? { key: d.axis, vector } : null,
          snap: state.snap,
        });
    state.setDragOps(d.base, moveOps(displacements, d.refs));
    const moved = api.getState().result?.snapshot;
    state.setDrag({
      mode: d.mode,
      axis: d.axis && vector ? d.axis : null,
      readout,
      contacts: moved ? closeContacts(moved, d.atoms) : [],
    });
  }, [api]);

  const dragStart = useCallback(
    (atomIndex: number, mods: BuildModifiers): boolean => {
      const state = api.getState();
      if (!canEdit(state) || (state.tool !== "select" && state.tool !== "move")) return false;
      const snapshot = state.result!.snapshot;
      // Drag the whole selection when the grabbed atom is part of it; else
      // the atom alone, which becomes the selection so the halo shows it.
      const inSelection = state.selected.includes(atomIndex);
      const group = (inSelection ? state.selected : [atomIndex]).filter(
        (i) => i >= 0 && i < snapshot.nAtoms && refFor(i) !== null,
      );
      if (group.length === 0) return false;
      if (!inSelection) state.setSelected([atomIndex]);
      const mode = dragModeFor(mods);
      drag.current = {
        base: state.edits.length,
        redoStack: state.redoStack,
        atoms: group,
        refs: new Map(group.map((i) => [i, refFor(i)!])),
        start: new Float32Array(snapshot.positions),
        mode,
        axis: null,
        gesture: null,
        rigid: null,
      };
      state.setDrag({ mode, axis: null, readout: null, contacts: [] });
      return true;
    },
    [api, refFor],
  );
  const dragMove = useCallback(
    (gesture: BuildDragGesture) => {
      if (!drag.current) return;
      drag.current.gesture = gesture;
      applyDrag();
    },
    [applyDrag],
  );
  const dragRigid = useCallback(
    (motion: BuildRigidMotion) => {
      if (!drag.current) return;
      // A hand needs no axis lock (one pressed before it moved is dropped).
      drag.current.axis = null;
      drag.current.rigid = motion;
      applyDrag();
    },
    [applyDrag],
  );
  const finishDrag = useCallback(
    (cancel: boolean) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const state = api.getState();
      const contacts = state.drag?.contacts.length ?? 0;
      if (cancel) state.setDragOps(d.base, []);
      // A drag that moved nothing leaves no step, and the redo stack as it was.
      if (api.getState().edits.length === d.base) api.setState({ redoStack: d.redoStack });
      state.setDrag(null);
      if (!cancel && contacts > 0 && api.getState().edits.length > d.base) {
        state.reportInfo(
          `${contacts} atoms are in close contact after the move. Undo (${UNDO_KEYS}) takes it back.`,
        );
      }
    },
    [api],
  );
  const dragEnd = useCallback(() => finishDrag(false), [finishDrag]);

  // Mid-drag keys: an axis key locks (or, pressed again, frees) the motion,
  // Esc cancels the drag. The Builder's shortcuts pause while a drag runs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const d = drag.current;
      if (!d || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        finishDrag(true);
        return;
      }
      const key = e.key.toLowerCase() as AxisKey;
      // A hand has its six degrees of freedom; there is nothing to lock.
      if (!AXIS_KEYS.includes(key) || d.rigid) return;
      e.preventDefault();
      if (d.axis !== key && !axisVector(key, api.getState().result?.snapshot.box ?? null)) {
        api
          .getState()
          .reportInfo("No cell: A B C need a unit cell. X Y Z lock to the view's axes.");
        return;
      }
      d.axis = d.axis === key ? null : key;
      if (d.gesture) applyDrag();
      else api.getState().setDrag({ ...api.getState().drag!, axis: d.axis });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api, applyDrag, finishDrag]);

  // The Menu key (or Shift + F10) opens the atom menu for the one selected atom.
  useEffect(() => {
    if (!openAtomMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isMenuKey(e) || drag.current) return;
      if (scope && !inScope(e.target, scope.current)) return;
      if (isTypingTarget(e.target)) return;
      const s = api.getState();
      const n = shownSnapshot(s)?.nAtoms ?? 0;
      if (s.preview || s.selected.length !== 1 || s.selected[0] >= n) return;
      e.preventDefault();
      openAtomMenu(s.selected[0]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api, openAtomMenu, scope]);

  const boxSelect = useCallback(
    (indices: number[], mode: BuildBoxMode) => {
      const state = api.getState();
      if (mode === "replace") state.setSelected(indices);
      else if (mode === "add") state.setSelected([...state.selected, ...indices]);
      else {
        const drop = new Set(indices);
        state.setSelected(state.selected.filter((i) => !drop.has(i)));
      }
    },
    [api],
  );

  const installed = useMemo<BuildHandlers>(
    () => ({ pick, pressAction, dragStart, dragMove, dragRigid, dragEnd, boxSelect }),
    [pick, pressAction, dragStart, dragMove, dragRigid, dragEnd, boxSelect],
  );
  useEffect(() => {
    api.getState().setHandlers(installed);
    return () => {
      if (api.getState().handlers === installed) api.getState().setHandlers(null);
    };
  }, [api, installed]);

  return installed;
}
