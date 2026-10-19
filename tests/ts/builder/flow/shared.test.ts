/** The structure Manual and Flow mode share: a Run makes its result the Manual document. */

import { describe, it, expect } from "vitest";
import type { StoreApi } from "zustand";
import { createBuilderStore } from "@/builder/store";
import { createFlowStore, type FlowStore } from "@/builder/flow/store";
import { adoptResult, runAndShare } from "@/builder/flow/shared";
import { initialToolParams } from "@/builder/flow/ports";
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

    // A changed block gives a new result, which replaces the document again.
    flow.getState().updateParams(a, { smiles: "CO" } as Partial<FlowParams>);
    expect(await runAndShare(builder, flow, fakeDeps())).toBe(true);
    expect(builder.getState().edits).toEqual([]);
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
