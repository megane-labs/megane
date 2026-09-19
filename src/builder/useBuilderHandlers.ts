/**
 * The Builder's click / drag semantics for the 3D view, as `BuildHandlers`.
 *
 * Every click becomes one `EditOp` on the store (or a selection change). The
 * Viewport reports rendered atom indices; they are translated to op refs
 * through `result.outputRefs` so an op always names the atom the user saw.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { StoreApi } from "zustand";
import type { EditAtomRef } from "../pipeline/types";
import { canEdit, shownSnapshot, type BuilderStore } from "./store";
import { newAtomId, placeBondedAtom } from "./placement";
import type { BuildHandlers, BuildPickInfo } from "./types";

/** Build the handlers for `api` and install them in the store while mounted. */
export function useBuilderHandlers(api: StoreApi<BuilderStore>): BuildHandlers {
  const refFor = useCallback(
    (renderedIndex: number): EditAtomRef | null =>
      api.getState().result?.outputRefs[renderedIndex] ?? null,
    [api],
  );

  const pick = useCallback(
    (info: BuildPickInfo) => {
      const state = api.getState();
      const snapshot = shownSnapshot(state);
      if (!canEdit(state) || !snapshot) return;
      const { atomIndex } = info;
      switch (state.tool) {
        case "select": {
          if (atomIndex === null) {
            if (!info.shiftKey) state.clearSelected();
            return;
          }
          if (info.shiftKey) state.toggleSelected(atomIndex);
          else state.setSelected([atomIndex]);
          return;
        }
        case "add": {
          const id = newAtomId();
          if (atomIndex !== null) {
            const ref = refFor(atomIndex);
            if (ref === null) return;
            state.pushOp({
              op: "add_atom",
              id,
              element: state.element,
              position: placeBondedAtom(snapshot, atomIndex, state.element),
              bondTo: ref,
              order: state.bondOrder,
            });
          } else if (info.world) {
            state.pushOp({ op: "add_atom", id, element: state.element, position: info.world });
          }
          return;
        }
        case "bond": {
          if (atomIndex === null) return;
          if (state.pendingBondAtom === null || state.pendingBondAtom === atomIndex) {
            state.setPendingBondAtom(atomIndex);
            return;
          }
          const a = refFor(state.pendingBondAtom);
          const b = refFor(atomIndex);
          state.setPendingBondAtom(null);
          if (a === null || b === null) return;
          state.pushOp({ op: "add_bond", a, b, order: state.bondOrder });
          return;
        }
        case "delete": {
          if (atomIndex === null) return;
          const ref = refFor(atomIndex);
          if (ref === null) return;
          state.clearSelected();
          state.pushOp({ op: "delete_atoms", atoms: [ref] });
          return;
        }
        case "element": {
          if (atomIndex === null) return;
          const ref = refFor(atomIndex);
          if (ref === null) return;
          state.pushOp({ op: "set_element", atoms: [ref], element: state.element });
          return;
        }
        case "move":
          // Moves are drags (below); a bare click selects.
          if (atomIndex !== null) state.setSelected([atomIndex]);
          return;
        case "place": {
          // Stamp the chosen library molecule at the clicked point; a click
          // on an atom is ignored so a molecule never lands on top of one.
          if (atomIndex !== null || !info.world || !state.placeSource) return;
          state.addFragment(state.placeSource, info.world);
          return;
        }
      }
    },
    [api, refFor],
  );

  // A drag writes one move_atoms op at press time and rewrites its delta while
  // the pointer moves, so the history gains a single op.
  const dragRefs = useRef<EditAtomRef[] | null>(null);
  const dragStart = useCallback(
    (atomIndex: number): boolean => {
      const state = api.getState();
      if (!canEdit(state) || state.tool !== "move") return false;
      // Drag the whole selection when the grabbed atom is part of it.
      const group = state.selected.includes(atomIndex) ? state.selected : [atomIndex];
      const refs = group.map(refFor).filter((r): r is EditAtomRef => r !== null);
      if (refs.length === 0) return false;
      dragRefs.current = refs;
      state.pushOp({ op: "move_atoms", atoms: refs, delta: [0, 0, 0] });
      return true;
    },
    [api, refFor],
  );
  const dragMove = useCallback(
    (delta: [number, number, number]) => {
      if (!dragRefs.current) return;
      api.getState().replaceLastOp({ op: "move_atoms", atoms: dragRefs.current, delta });
    },
    [api],
  );
  const dragEnd = useCallback(() => {
    if (!dragRefs.current) return;
    dragRefs.current = null;
    // A drag that never moved leaves a zero-delta op behind; drop it without
    // leaving it on the redo stack.
    const state = api.getState();
    const tail = state.edits[state.edits.length - 1];
    if (tail && tail.op === "move_atoms" && tail.delta.every((d) => d === 0)) {
      state.undo();
      api.setState({ redoStack: state.redoStack });
    }
  }, [api]);

  const installed = useMemo<BuildHandlers>(
    () => ({ pick, dragStart, dragMove, dragEnd }),
    [pick, dragStart, dragMove, dragEnd],
  );
  useEffect(() => {
    api.getState().setHandlers(installed);
    return () => {
      if (api.getState().handlers === installed) api.getState().setHandlers(null);
    };
  }, [api, installed]);

  return installed;
}
