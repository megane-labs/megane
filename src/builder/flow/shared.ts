/**
 * The structure Manual and Flow mode share.
 *
 * The Builder has one structure: the Manual document. Manual mode edits it in
 * the view; Flow mode reads it (the *Manual structure* block, and the 3D view
 * while no block is picked) and writes it: a Run makes the result of the
 * flow's output block the document, and *Open in Manual* does the same for
 * any block's result. Either way the store remembers the result's cache key
 * (`adoptedKey`), so a Run that only gives back the result already adopted
 * (or the document itself) leaves the document — and whatever was edited on
 * it in Manual mode — alone.
 */

import type { StoreApi } from "zustand";
import { shownSnapshot, type BuilderStore } from "../store";
import type { FlowDeps } from "./engine";
import { outputNodeId, type FlowStore } from "./store";
import type { FlowData } from "./types";

/**
 * Make `data` (the result whose cache key is `key`) the Manual document,
 * replacing the open one and its history.
 */
export function adoptResult(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  data: FlowData,
  key: string | null,
): void {
  builder.getState().openStructure(data.snapshot, data.labels, data.name);
  flow.getState().setAdoptedKey(key);
}

/**
 * Run the whole flow, then make its output block's result the Manual
 * document unless that result is the one adopted last. Returns whether the
 * document was replaced.
 */
export async function runAndShare(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  deps: FlowDeps,
): Promise<boolean> {
  if (flow.getState().running) return false;
  await flow.getState().run(deps);
  const s = flow.getState();
  const id = outputNodeId(s);
  const run = id ? s.runs[id] : undefined;
  if (!run || run.status !== "done" || !run.data || run.key === s.adoptedKey) return false;
  // A flow that ends on the Manual structure block gives back the document itself.
  if (run.data.snapshot === shownSnapshot(builder.getState())) return false;
  adoptResult(builder, flow, run.data, run.key);
  builder
    .getState()
    .reportInfo(
      `Built ${run.data.name} (${run.data.snapshot.nAtoms} atoms); Manual mode now edits it.`,
    );
  return true;
}
