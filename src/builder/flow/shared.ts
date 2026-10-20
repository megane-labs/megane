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
 * it in Manual mode — alone. It also pins the document the result replaced
 * (`pinnedDocument`): until the result is edited, a *Manual structure* block
 * keeps reading that one, so a second Run builds the same model again rather
 * than building on the first one's output.
 *
 * A Run that would replace a document with unsaved edits asks first
 * (`confirmDiscard`); a Run that fails says so in the notice line, where it
 * shows with the Flow panel collapsed.
 */

import type { StoreApi } from "zustand";
import { confirmDiscard, type BuilderStore } from "../store";
import { documentOf } from "./deps";
import { topoOrder, upstreamOf, type FlowDeps } from "./engine";
import { outputNodeId, type FlowStore } from "./store";
import { blockTitle } from "./titles";
import type { FlowData } from "./types";

/**
 * Make `data` (the result whose cache key is `key`) the Manual document,
 * replacing the open one and its history, and pin the document it replaced
 * for the flow's *Manual structure* blocks.
 */
export function adoptResult(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  data: FlowData,
  key: string | null,
): void {
  // The document the flow read: the one before the flow's last result, if that is still open.
  const base = flow.getState().readDocument(documentOf(builder));
  builder.getState().openStructure(data.snapshot, data.labels, data.name);
  const after = documentOf(builder);
  flow.getState().setAdoptedKey(key);
  flow.getState().setPinnedDocument(base && after ? { adoptedDocKey: after.key, base } : null);
}

/** A block's title, with its tool and the library as `deps` give them. */
function titleOf(flow: FlowStore, deps: FlowDeps, id: string): string {
  const params = flow.nodes.find((n) => n.id === id)?.data.params;
  if (!params) return id;
  return blockTitle(params, params.type === "tool" ? deps.tool(params.tool) : null, deps.library());
}

/**
 * The notice for a run that left blocks failed (among `targets` and what
 * they need, or the whole graph), or null when none did. It names the first
 * failed block in dependency order — the cause, when the others failed for
 * want of its result — and counts the rest.
 */
export function runErrorText(flow: FlowStore, deps: FlowDeps, targets?: string[]): string | null {
  const order = topoOrder(flow) ?? flow.nodes.map((n) => n.id);
  const scope = targets ? upstreamOf(flow, targets) : null;
  const failed = order.filter(
    (id) => (!scope || scope.has(id)) && flow.runs[id]?.status === "error",
  );
  if (failed.length === 0) return null;
  const first = failed[0];
  const more = failed.length - 1;
  return `Run failed at “${titleOf(flow, deps, first)}”: ${flow.runs[first].error ?? "Failed"}${
    more > 0 ? ` (${more} more block${more === 1 ? "" : "s"} could not run)` : ""
  }`;
}

const STOPPED = "Run stopped; blocks that had not finished keep their last result.";

/**
 * Run what block `id` needs (Run to here), and say in the notice line when a
 * block failed or the run was stopped. The document is not replaced.
 */
export async function runTo(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  deps: FlowDeps,
  id: string,
): Promise<void> {
  const outcome = await flow.getState().run(deps, [id]);
  if (outcome === "cancelled") builder.getState().reportInfo(STOPPED);
  if (outcome !== "finished") return;
  const error = runErrorText(flow.getState(), deps, [id]);
  if (error) builder.getState().reportError(error);
}

/**
 * Run the whole flow, then make its output block's result the Manual
 * document unless that result is the one adopted last. Asks first when the
 * document has unsaved edits. Returns whether the document was replaced.
 */
export async function runAndShare(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  deps: FlowDeps,
): Promise<boolean> {
  if (flow.getState().running) return false;
  const outcome = await flow.getState().run(deps);
  if (outcome === "cancelled") builder.getState().reportInfo(STOPPED);
  if (outcome !== "finished") return false;
  const s = flow.getState();
  const error = runErrorText(s, deps);
  const report = () => {
    if (error) builder.getState().reportError(error);
  };
  const id = outputNodeId(s);
  const run = id ? s.runs[id] : undefined;
  if (!id || !run || run.status !== "done" || !run.data || run.key === s.adoptedKey) {
    report();
    return false;
  }
  // A flow that ends on the Manual structure block gives back the document itself.
  if (s.nodes.find((n) => n.id === id)?.data.params.type === "document") {
    report();
    return false;
  }
  if (!(await confirmDiscard(builder, "Run"))) {
    builder
      .getState()
      .reportInfo(
        `Built ${run.data.name} (${run.data.snapshot.nAtoms} atoms) but kept the open structure and its edits; use Open in Manual on “${titleOf(s, deps, id)}” to edit the result.`,
      );
    return false;
  }
  adoptResult(builder, flow, run.data, run.key);
  builder
    .getState()
    .reportInfo(
      `Built ${run.data.name} (${run.data.snapshot.nAtoms} atoms); Manual mode now edits it.`,
    );
  report();
  return true;
}

/**
 * Ask before `action` replaces a flow that has blocks (a template, Open flow…,
 * Clear). Resolves to true at once for an empty flow.
 */
export function confirmReplaceFlow(
  builder: StoreApi<BuilderStore>,
  flow: StoreApi<FlowStore>,
  action: string,
  confirmLabel: string,
): Promise<boolean> {
  const n = flow.getState().nodes.length;
  if (n === 0) return Promise.resolve(true);
  return builder.getState().requestConfirm({
    title: "Replace the flow?",
    message: `${action} replaces the ${n} block${n === 1 ? "" : "s"} of the current flow and their results. Undo (Ctrl+Z) brings them back.`,
    confirmLabel,
    danger: true,
  });
}
