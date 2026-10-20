/** The structure Manual and Flow mode share: a Run makes its result the Manual document. */

import { describe, it, expect, vi } from "vitest";
import type { StoreApi } from "zustand";
import { createBuilderStore } from "@/builder/store";
import { createFlowStore, type FlowStore } from "@/builder/flow/store";
import {
  adoptResult,
  confirmReplaceFlow,
  runAndShare,
  runErrorText,
  runTo,
} from "@/builder/flow/shared";
import { createFlowDeps, documentOf } from "@/builder/flow/deps";
import { createBuilderToolsStore } from "@/builder/tools/store";
import { useLibraryStore } from "@/builder/library/store";
import type { Snapshot } from "@/types";
import { initialToolParams } from "@/builder/flow/ports";
import { defaultBuiltinParams } from "@/builder/flow/builtins";
import type { FlowParams } from "@/builder/flow/types";
import { fakeDeps, tools, water, waterData } from "./helpers";

const mol = (smiles: string): FlowParams => ({
  type: "molecule",
  source: "smiles",
  smiles,
  libraryId: "",
  name: "",
});

function chain(): { flow: StoreApi<FlowStore>; a: string; box: string } {
  const flow = createFlowStore();
  const a = flow.getState().addNode(mol("O"));
  const p = initialToolParams(tools.liquid_box);
  const box = flow.getState().addNode({ ...p, values: { ...p.values, seed: 1 } });
  flow
    .getState()
    .connect({ source: a, target: box, sourceHandle: "out", targetHandle: "components" }, true);
  return { flow, a, box };
}

describe("adoptResult", () => {
  it("makes a result the Manual document and remembers its key", () => {
    const builder = createBuilderStore();
    const flow = createFlowStore();
    adoptResult(builder, flow, waterData("box"), "k1");
    expect(builder.getState().fileName).toBe("box");
    expect(builder.getState().source!.nAtoms).toBe(3);
    expect(flow.getState().adoptedKey).toBe("k1");
  });
});

describe("runAndShare", () => {
  it("makes the output block's result the Manual document", async () => {
    const builder = createBuilderStore();
    builder.getState().openStructure(water(), null, "slab");
    const { flow, box } = chain();
    expect(await runAndShare(builder, flow, fakeDeps())).toBe(true);
    const run = flow.getState().runs[box];
    expect(builder.getState().source).toBe(run.data!.snapshot);
    expect(builder.getState().fileName).toBe(run.data!.name);
    expect(builder.getState().notice?.text).toContain("Manual mode now edits it");
    expect(flow.getState().adoptedKey).toBe(run.key);
  });

  it("leaves Manual edits alone when the flow gives back the same result", async () => {
    const builder = createBuilderStore();
    const { flow, a } = chain();
    await runAndShare(builder, flow, fakeDeps());
    builder.getState().pushOp({ op: "delete_atoms", atoms: [0] });
    const edited = builder.getState().edits;
    expect(await runAndShare(builder, flow, fakeDeps())).toBe(false);
    expect(builder.getState().edits).toBe(edited);

    // A changed block gives a new result, which replaces the document again
    // once the unsaved edit may go.
    flow.getState().updateParams(a, { smiles: "CO" } as Partial<FlowParams>);
    const asked = runAndShare(builder, flow, fakeDeps());
    await vi.waitFor(() => expect(builder.getState().confirm).not.toBeNull());
    expect(builder.getState().confirm!.message).toContain("Run replaces");
    builder.getState().resolveConfirm(true);
    expect(await asked).toBe(true);
    expect(builder.getState().edits).toEqual([]);
  });

  it("keeps the results but not the document when replacing it is cancelled", async () => {
    const builder = createBuilderStore();
    builder.getState().openStructure(water(), null, "mine");
    builder.getState().pushOp({ op: "delete_atoms", atoms: [0] });
    const { flow, box } = chain();
    const asked = runAndShare(builder, flow, fakeDeps());
    await vi.waitFor(() => expect(builder.getState().confirm).not.toBeNull());
    builder.getState().resolveConfirm(false);
    expect(await asked).toBe(false);
    expect(builder.getState().fileName).toBe("mine");
    expect(builder.getState().edits).toHaveLength(1);
    expect(flow.getState().runs[box].status).toBe("done");
    expect(flow.getState().adoptedKey).toBeNull();
    expect(builder.getState().notice?.text).toContain("kept the open structure");
    expect(builder.getState().notice?.text).toContain("Open in Manual");
  });

  it("keeps the document when the flow only reads it back", async () => {
    const builder = createBuilderStore();
    builder.getState().openStructure(water(), null, "slab");
    builder.getState().pushOp({ op: "delete_atoms", atoms: [0] });
    const flow = createFlowStore();
    flow.getState().addNode({ type: "document" });
    const doc = builder.getState().result!.snapshot;
    const deps = fakeDeps({
      document: () => ({ data: { name: "slab", snapshot: doc, labels: null }, key: "d" }),
    });
    expect(await runAndShare(builder, flow, deps)).toBe(false);
    expect(builder.getState().edits).toHaveLength(1);
  });

  it("keeps the document when the output block fails", async () => {
    const builder = createBuilderStore();
    builder.getState().openStructure(water(), null, "slab");
    const { flow } = chain();
    const deps = fakeDeps({ call: async () => ({ ok: false, error: "no room" }) });
    expect(await runAndShare(builder, flow, deps)).toBe(false);
    expect(builder.getState().fileName).toBe("slab");
    expect(flow.getState().adoptedKey).toBeNull();
  });

  it("does nothing while a run is in progress, or for an empty flow", async () => {
    const builder = createBuilderStore();
    const flow = createFlowStore();
    expect(await runAndShare(builder, flow, fakeDeps())).toBe(false);
    flow.setState({ running: new AbortController() });
    flow.getState().addNode(mol("O"));
    expect(await runAndShare(builder, flow, fakeDeps())).toBe(false);
    expect(builder.getState().source).toBeNull();
  });
});

/** A one-atom cubic cell, so a supercell of it counts its repeats in atoms. */
function cell(): Snapshot {
  return {
    ...water(),
    nAtoms: 1,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 0]),
    elements: new Uint8Array([29]),
    bonds: new Uint32Array([]),
    box: new Float32Array([3, 0, 0, 0, 3, 0, 0, 0, 3]),
  };
}

describe("a flow that starts from the Manual structure", () => {
  function supercellOfDocument() {
    const builder = createBuilderStore();
    builder.getState().openStructure(cell(), null, "cu");
    const flow = createFlowStore();
    const doc = flow.getState().addNode({ type: "document" });
    const sc = flow.getState().addNode({ type: "supercell", repeat: [2, 2, 2] });
    flow
      .getState()
      .connect({ source: doc, target: sc, sourceHandle: "out", targetHandle: "structure" }, false);
    const deps = createFlowDeps({
      builder,
      tools: createBuilderToolsStore(builder),
      library: useLibraryStore,
    });
    return { builder, flow, deps, doc, sc };
  }

  it("builds the same model on every Run instead of building on its own result", async () => {
    const { builder, flow, deps, doc, sc } = supercellOfDocument();
    expect(await runAndShare(builder, flow, deps)).toBe(true);
    expect(builder.getState().source!.nAtoms).toBe(8);
    const first = flow.getState().runs[sc].key;
    // The document is now the flow's result: the block still reads the one before it.
    flow.getState().documentChanged(deps.document()!.key);
    expect(flow.getState().runs[doc].status).toBe("done");
    expect(await runAndShare(builder, flow, deps)).toBe(false);
    expect(builder.getState().source!.nAtoms).toBe(8);
    expect(flow.getState().runs[sc].key).toBe(first);
    expect(flow.getState().runs[sc].data!.snapshot.nAtoms).toBe(8);

    // A changed setting re-runs on the original structure, not on 8 atoms.
    flow.getState().updateParams(sc, { repeat: [3, 1, 1] } as Partial<FlowParams>);
    expect(await runAndShare(builder, flow, deps)).toBe(true);
    expect(builder.getState().source!.nAtoms).toBe(3);
    expect(flow.getState().pinnedDocument!.base.data.name).toBe("cu");
  });

  it("reads the document again once it is edited in Manual mode", async () => {
    const { builder, flow, deps, doc, sc } = supercellOfDocument();
    await runAndShare(builder, flow, deps);
    builder.getState().pushOp({ op: "delete_atoms", atoms: [0] });
    flow.getState().documentChanged(deps.document()!.key);
    expect(flow.getState().runs[doc].status).toBe("stale");
    expect(flow.getState().runs[sc].status).toBe("stale");
    const asked = runAndShare(builder, flow, deps);
    await vi.waitFor(() => expect(builder.getState().confirm).not.toBeNull());
    builder.getState().resolveConfirm(true);
    expect(await asked).toBe(true);
    // The edited supercell (7 atoms), repeated.
    expect(builder.getState().source!.nAtoms).toBe(56);
  });

  it("does not pin a document when none was open", () => {
    const builder = createBuilderStore();
    const flow = createFlowStore();
    adoptResult(builder, flow, waterData("box"), "k");
    expect(flow.getState().pinnedDocument).toBeNull();
    expect(documentOf(builder)!.data.name).toBe("box");
  });
});

describe("run errors and Stop", () => {
  it("says which block failed, first in dependency order, outside the panel", async () => {
    const builder = createBuilderStore();
    const { flow } = chain();
    const deps = fakeDeps({ embedSmiles: async () => Promise.reject(new Error("bad SMILES")) });
    expect(await runAndShare(builder, flow, deps)).toBe(false);
    expect(builder.getState().notice).toEqual({
      level: "error",
      text: "Run failed at “Molecule: O”: bad SMILES (1 more block could not run)",
    });
  });

  it("reports a failed side branch even when the output was built", async () => {
    const builder = createBuilderStore();
    const flow = createFlowStore();
    flow.getState().addNode(mol(""));
    const bulk = flow.getState().addNode(defaultBuiltinParams("crystal"));
    const sc = flow.getState().addNode({ type: "supercell", repeat: [1, 1, 1] });
    flow
      .getState()
      .connect({ source: bulk, target: sc, sourceHandle: "out", targetHandle: "structure" }, false);
    expect(await runAndShare(builder, flow, fakeDeps())).toBe(true);
    // Cubic fcc Cu: four atoms.
    expect(builder.getState().source!.nAtoms).toBe(4);
    expect(builder.getState().notice?.level).toBe("error");
    expect(builder.getState().notice?.text).toBe(
      "Run failed at “Molecule”: Enter a SMILES string.",
    );
    // Run to here only answers for what it ran.
    expect(runErrorText(flow.getState(), fakeDeps(), [sc])).toBeNull();
  });

  it("runs to a block and reports its failure, or that it was stopped", async () => {
    const builder = createBuilderStore();
    const { flow, a, box } = chain();
    const deps = fakeDeps({ call: async () => ({ ok: false, error: "no room" }) });
    await runTo(builder, flow, deps, box);
    expect(builder.getState().notice?.text).toBe("Run failed at “Liquid box”: no room");
    expect(builder.getState().source).toBeNull();

    builder.getState().setNotice(null);
    await runTo(builder, flow, fakeDeps(), a);
    expect(builder.getState().notice).toBeNull();

    // Stop while RDKit embeds: the run ends at once, without waiting for it.
    flow.getState().updateParams(a, { smiles: "CCO" } as Partial<FlowParams>);
    const never = fakeDeps({ embedSmiles: () => new Promise<Snapshot>(() => {}) });
    const pending = runTo(builder, flow, never, a);
    await vi.waitFor(() => expect(flow.getState().runs[a].status).toBe("running"));
    flow.getState().cancel();
    expect(flow.getState().stopping).toBe(true);
    await pending;
    expect(flow.getState().running).toBeNull();
    expect(flow.getState().stopping).toBe(false);
    expect(builder.getState().notice?.text).toContain("Run stopped");

    // The same for a whole Run.
    const all = runAndShare(builder, flow, never);
    await vi.waitFor(() => expect(flow.getState().runs[a].status).toBe("running"));
    flow.getState().cancel();
    expect(await all).toBe(false);
    expect(builder.getState().notice?.text).toContain("Run stopped");
  });
});

describe("confirmReplaceFlow", () => {
  it("asks only when the flow has blocks", async () => {
    const builder = createBuilderStore();
    const flow = createFlowStore();
    expect(await confirmReplaceFlow(builder, flow, "Open x.json", "Open flow")).toBe(true);
    expect(builder.getState().confirm).toBeNull();
    flow.getState().addNode(mol("O"));
    const asked = confirmReplaceFlow(builder, flow, "Open x.json", "Open flow");
    expect(builder.getState().confirm).toMatchObject({
      confirmLabel: "Open flow",
      danger: true,
    });
    expect(builder.getState().confirm!.message).toContain("Open x.json replaces the 1 block");
    builder.getState().resolveConfirm(false);
    expect(await asked).toBe(false);
  });
});
