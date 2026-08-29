/**
 * Bridge between the Selection Inspector (in the pipeline panel) and the 3D
 * Viewport (in the viewer). They live in different component subtrees, so this
 * small store carries the live preview highlight one way and the 3D pick /
 * box-select results the other way.
 */

import { create, type StateCreator, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";
import type { ClickedAtom } from "../pipeline/inspectorQuery";

let nextToken = 1;

export interface InspectorInteractionStore {
  /** Atom indices the Inspector wants highlighted live in the 3D view. */
  previewIndices: number[] | null;
  /** True while the Inspector has "box select" armed (suspends camera rotate). */
  boxSelectActive: boolean;
  /** Result of a completed box drag (token de-dupes repeated identical sets). */
  boxResult: { indices: number[]; token: number } | null;
  /** An atom clicked in the 3D view while the Inspector is active. */
  pickedAtom: (ClickedAtom & { token: number }) | null;

  setPreviewIndices: (indices: number[] | null) => void;
  setBoxSelectActive: (active: boolean) => void;
  publishBoxResult: (indices: number[]) => void;
  publishPickedAtom: (atom: ClickedAtom) => void;
}

export const inspectorInteractionStateCreator: StateCreator<InspectorInteractionStore> = (
  set,
) => ({
  previewIndices: null,
  boxSelectActive: false,
  boxResult: null,
  pickedAtom: null,

  setPreviewIndices: (indices) => set({ previewIndices: indices }),
  setBoxSelectActive: (active) => set({ boxSelectActive: active }),
  publishBoxResult: (indices) => set({ boxResult: { indices, token: nextToken++ } }),
  publishPickedAtom: (atom) => set({ pickedAtom: { ...atom, token: nextToken++ } }),
});

/** App-wide singleton — used when no <MeganeProvider> is mounted. */
export const useInspectorInteractionStore = create<InspectorInteractionStore>(
  inspectorInteractionStateCreator,
);

/**
 * Private Inspector bridge for one viewer. Without this a pick in viewer A
 * publishes into viewer B's Inspector panel.
 */
export function createInspectorInteractionStore(): StoreApi<InspectorInteractionStore> {
  return createStore<InspectorInteractionStore>(inspectorInteractionStateCreator);
}
