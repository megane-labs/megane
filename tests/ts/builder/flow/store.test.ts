/** Flow mode's store: wiring rules, stale results, runs, and saved flows. */

import { describe, it, expect } from "vitest";
import {
  FLOW_HISTORY_LIMIT,
  createFlowStore,
  flowViewData,
  outputNodeId,
  parseSerializedFlow,
  type FlowStore,
} from "@/builder/flow/store";
import { nodeKey } from "@/builder/flow/engine";
import { initialToolParams } from "@/builder/flow/ports";
import type { FlowParams } from "@/builder/flow/types";
import type { StoreApi } from "zustand";
import { fakeDeps, tools, waterData } from "./helpers";

const mol = (smiles = "O"): FlowParams => ({
  type: "molecule",
  source: "smiles",
  smiles,
  libraryId: "",
  name: "",
});

function liquid(): FlowParams {
  const p = initialToolParams(tools.liquid_box);
  return { ...p, values: { ...p.values, seed: 1 } };
}

const wire = (
  s: StoreApi<FlowStore>,
  source: string,
  target: string,
  handle: string,
  multiple = true,
) => s.getState().connect({ source, target, sourceHandle: "out", targetHandle: handle }, multiple);

function chain() {
  const s = createFlowStore();
  const a = s.getState().addNode(mol("O"));
  const box = s.getState().addNode(liquid());
  wire(s, a, box, "components");
  return { s, a, box };
}

describe("flow store", () => {
  it("starts in Manual mode and switches", () => {
    const s = createFlowStore();
    expect(s.getState().mode).toBe("manual");
    s.getState().setMode("flow");
    expect(s.getState().mode).toBe("flow");
  });

  it("adds blocks under each other, selecting the new one", () => {
    const s = createFlowStore();
    const a = s.getState().addNode(mol());
    const b = s.getState().addNode(mol());
    const [na, nb] = s.getState().nodes;
    expect([a, b]).toEqual(["n1", "n2"]);
    expect(nb.position.y).toBeGreaterThan(na.position.y);
    expect(na.selected).toBe(false);
    expect(nb.selected).toBe(true);
    expect(s.getState().addNode(mol(), { x: 5, y: 6 })).toBe("n3");
    expect(s.getState().nodes[2].position).toEqual({ x: 5, y: 6 });
  });

  it("refuses self wires, duplicates, loops and missing handles", () => {
    const { s, a, box } = chain();
    expect(wire(s, a, a, "components")).toBe(false);
    expect(wire(s, a, box, "components")).toBe(false);
    expect(wire(s, box, a, "x")).toBe(false);
    expect(
      s
        .getState()
        .connect({ source: a, target: box, sourceHandle: "out", targetHandle: null }, true),
    ).toBe(false);
    expect(s.getState().edges).toHaveLength(1);
  });

  it("replaces the wire into a single input, adds to a multiple one", () => {
    const { s, box } = chain();
    const b = s.getState().addNode(mol("C"));
    expect(wire(s, b, box, "components", true)).toBe(true);
    expect(s.getState().edges).toHaveLength(2);
    const c = s.getState().addNode(mol("N"));
    const solv = s.getState().addNode(initialToolParams(tools.solvate));
    wire(s, b, solv, "solvent", false);
    wire(s, c, solv, "solvent", false);
    expect(
      s
        .getState()
        .edges.filter((e) => e.target === solv)
        .map((e) => e.source),
    ).toEqual([c]);
  });

  it("runs, shows the last block, and marks downstream results stale on edits", async () => {
    const { s, a, box } = chain();
    await s.getState().run(fakeDeps());
    expect(s.getState().runs[box].status).toBe("done");
    expect(s.getState().viewNodeId).toBe(box);
    expect(s.getState().running).toBeNull();

    s.getState().updateParams(a, { smiles: "CO" } as Partial<FlowParams>);
    expect(s.getState().runs[a].status).toBe("stale");
    expect(s.getState().runs[box].status).toBe("stale");
    expect((s.getState().nodes[0].data.params as { smiles: string }).smiles).toBe("CO");
  });

  it("marks downstream stale when a wire goes, and drops a removed block's run", async () => {
    const { s, a, box } = chain();
    await s.getState().run(fakeDeps());
    const edge = s.getState().edges[0];
    s.getState().removeEdges([]);
    s.getState().removeEdges([edge.id]);
    expect(s.getState().edges).toHaveLength(0);
    expect(s.getState().runs[box].status).toBe("stale");
    expect(s.getState().runs[a].status).toBe("done");

    wire(s, a, box, "components");
    s.getState().removeNode(a);
    expect(s.getState().nodes.map((n) => n.id)).toEqual([box]);
    expect(s.getState().edges).toHaveLength(0);
    expect(s.getState().runs[a]).toBeUndefined();

    s.getState().removeNode(box);
    expect(s.getState().viewNodeId).toBeNull();
  });

  it("takes the editor's nodes and edges as they are", () => {
    const { s, a } = chain();
    const nodes = s
      .getState()
      .nodes.map((n) => (n.id === a ? { ...n, position: { x: 99, y: 1 } } : n));
    s.getState().setNodes(nodes);
    expect(s.getState().nodes[0].position).toEqual({ x: 99, y: 1 });
    const edges = s.getState().edges.map((e) => ({ ...e, selected: true }));
    s.getState().setEdges(edges);
    expect(s.getState().edges[0].selected).toBe(true);
    s.getState().removeNodes([]);
    expect(s.getState().nodes).toHaveLength(2);
  });

  it("selects one block", () => {
    const { s, a, box } = chain();
    s.getState().selectNode(a);
    expect(
      s
        .getState()
        .nodes.filter((n) => n.selected)
        .map((n) => n.id),
    ).toEqual([a]);
    s.getState().selectNode(null);
    expect(s.getState().nodes.some((n) => n.selected)).toBe(false);
    expect(box).toBe("n2");
  });

  it("shows the selected block's result, else the last run's", async () => {
    const { s, a, box } = chain();
    expect(flowViewData(s.getState())).toBeNull();
    await s.getState().run(fakeDeps());
    s.getState().selectNode(null);
    expect(flowViewData(s.getState())!.id).toBe(box);
    s.getState().selectNode(a);
    expect(flowViewData(s.getState())!.id).toBe(a);
  });

  it("shows the shared structure when no block is selected", async () => {
    const { s, a, box } = chain();
    const doc = waterData("slab");
    expect(flowViewData(s.getState(), doc)).toEqual({ id: null, data: doc });
    await s.getState().run(fakeDeps());
    s.getState().selectNode(null);
    expect(flowViewData(s.getState(), doc)!.id).toBeNull();
    expect(flowViewData(s.getState(), null)!.id).toBe(box);
    s.getState().selectNode(a);
    expect(flowViewData(s.getState(), doc)!.id).toBe(a);
  });

  it("finds the block a Run builds the model in", () => {
    expect(outputNodeId(createFlowStore().getState())).toBeNull();
    const { s, box } = chain();
    expect(outputNodeId(s.getState())).toBe(box);
    s.getState().addNode(mol("N"));
    expect(outputNodeId(s.getState())).toBe(box);
    s.setState({
      edges: [
        ...s.getState().edges,
        { id: "loop", source: box, target: "n1", targetHandle: "components" },
      ],
    });
    expect(outputNodeId(s.getState())).toBeNull();
  });

  it("marks Manual structure blocks stale when the document changes", async () => {
    const s = createFlowStore();
    const doc = s.getState().addNode({ type: "document" });
    const solv = s.getState().addNode(initialToolParams(tools.solvate));
    wire(s, doc, solv, "document", false);
    const other = s.getState().addNode(mol("O"));
    wire(s, other, solv, "solvent", false);
    const deps = fakeDeps({ document: () => ({ data: waterData("slab"), key: "doc-1" }) });
    await s.getState().run(deps);
    expect(s.getState().runs[solv].status).toBe("done");
    expect(s.getState().runs[doc].key).toBe(nodeKey({ type: "document" }, {}, "doc-1"));

    s.getState().documentChanged("doc-1");
    expect(s.getState().runs[doc].status).toBe("done");
    s.getState().documentChanged("doc-2");
    expect(s.getState().runs[doc].status).toBe("stale");
    expect(s.getState().runs[solv].status).toBe("stale");
    expect(s.getState().runs[other].status).toBe("done");
  });

  it("remembers the adopted result until the flow is cleared or replaced", () => {
    const { s } = chain();
    s.getState().setAdoptedKey("k");
    expect(s.getState().adoptedKey).toBe("k");
    s.getState().load(s.getState().serialize());
    expect(s.getState().adoptedKey).toBeNull();
    s.getState().setAdoptedKey("k");
    s.getState().clear();
    expect(s.getState().adoptedKey).toBeNull();
  });

  it("runs to a target and keeps the shown block", async () => {
    const { s, a, box } = chain();
    await s.getState().run(fakeDeps(), [a]);
    expect(s.getState().runs[box]).toBeUndefined();
    expect(s.getState().viewNodeId).toBe(a);
    await s.getState().run(fakeDeps());
    expect(s.getState().viewNodeId).toBe(a);
  });

  it("ignores Run while a run is in progress, and stops on Cancel", async () => {
    const { s, box } = chain();
    let release: () => void = () => {};
    const deps = fakeDeps({
      call: (tool, _a, { signal }) =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, error: "Cancelled." });
          signal?.addEventListener("abort", () => release());
          void tool;
        }),
    });
    const running = s.getState().run(deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getState().running).not.toBeNull();
    await s.getState().run(deps); // no second run
    s.getState().cancel();
    await running;
    expect(s.getState().running).toBeNull();
    expect(s.getState().runs[box].status).toBe("idle");
  });

  it("reports a loop on every block", async () => {
    const s = createFlowStore();
    s.setState({
      nodes: [
        { id: "a", position: { x: 0, y: 0 }, data: { params: liquid() } },
        { id: "b", position: { x: 0, y: 0 }, data: { params: liquid() } },
      ],
      edges: [
        { id: "1", source: "a", target: "b", targetHandle: "components" },
        { id: "2", source: "b", target: "a", targetHandle: "components" },
      ],
    });
    await s.getState().run(fakeDeps());
    expect(s.getState().runs.a.error).toContain("loop");
    expect(s.getState().runs.b.status).toBe("error");
  });

  it("saves and opens a flow, and clears", async () => {
    const { s } = chain();
    const saved = s.getState().serialize();
    expect(saved.version).toBe(1);
    expect(saved.edges).toEqual([{ source: "n1", target: "n2", targetHandle: "components" }]);
    const t = createFlowStore();
    t.getState().load(parseSerializedFlow(JSON.parse(JSON.stringify(saved))));
    expect(t.getState().nodes.map((n) => [n.id, n.type])).toEqual([
      ["n1", "molecule"],
      ["n2", "tool"],
    ]);
    expect(t.getState().edges[0]).toMatchObject({ source: "n1", target: "n2", type: "deletable" });
    expect(t.getState().addNode(mol())).toBe("n3");
    t.getState().clear();
    expect(t.getState().nodes).toEqual([]);
  });

  it("fills in a tool block's missing settings without touching its result", () => {
    const s = createFlowStore();
    const m = s.getState().addNode(mol());
    const t = s.getState().addNode({
      type: "tool",
      tool: "liquid_box",
      label: "Liquid box",
      values: { density: 0.9, seed: 3 },
      rows: {},
    });
    s.getState().addNode({ type: "tool", tool: "unknown", label: "", values: {}, rows: {} });
    const before = s.getState().nodes;
    s.getState().completeTools((name) => tools[name] ?? null);
    const params = s.getState().nodes.find((n) => n.id === t)!.data.params;
    expect(params).toMatchObject({ values: { density: 0.9, seed: 3, shape: "cubic" } });
    expect(s.getState().nodes.find((n) => n.id === m)).toBe(before[0]);
    expect(s.getState().nodes[2]).toBe(before[2]);
    // Nothing missing: the graph is left as it is.
    const after = s.getState().nodes;
    s.getState().completeTools((name) => tools[name] ?? null);
    expect(s.getState().nodes).toBe(after);
  });
});

describe("parseSerializedFlow", () => {
  it("refuses what is not a flow", () => {
    expect(() => parseSerializedFlow(null)).toThrow("Not a Flow file.");
    expect(() => parseSerializedFlow({ version: 2 })).toThrow("version");
    expect(() => parseSerializedFlow({ version: 1, nodes: {} })).toThrow("Not a Flow file.");
    expect(() =>
      parseSerializedFlow({ version: 1, nodes: [{ id: "a", params: { type: "x" } }], edges: [] }),
    ).toThrow("block");
    expect(() =>
      parseSerializedFlow({
        version: 1,
        nodes: [{ id: "a", params: { type: "document" } }],
        edges: [{ source: "a", target: "b", targetHandle: "x" }],
      }),
    ).toThrow("wire");
  });

  it("knows every block type", () => {
    const flow = parseSerializedFlow({
      version: 1,
      nodes: [
        { id: "a", position: { x: 0, y: 0 }, params: { type: "crystal" } },
        { id: "b", position: { x: 0, y: 0 }, params: { type: "slab" } },
        { id: "c", position: { x: 0, y: 0 }, params: { type: "adsorb" } },
        { id: "d", position: { x: 0, y: 0 }, params: { type: "polymer" } },
        { id: "e", position: { x: 0, y: 0 }, params: { type: "supercell" } },
      ],
      edges: [{ source: "a", target: "b", targetHandle: "bulk" }],
    });
    expect(flow.nodes).toHaveLength(5);
  });
});

describe("flow history", () => {
  const ids = (s: StoreApi<FlowStore>) => s.getState().nodes.map((n) => n.id);

  it("undoes and redoes adding, wiring and removing blocks", () => {
    const { s, a, box } = chain();
    expect(s.getState().past).toHaveLength(3);
    s.getState().removeNodes([a]);
    expect(ids(s)).toEqual([box]);
    s.getState().undo();
    expect(ids(s)).toEqual([a, box]);
    expect(s.getState().edges).toHaveLength(1);
    s.getState().undo();
    expect(s.getState().edges).toHaveLength(0);
    s.getState().redo();
    s.getState().redo();
    expect(ids(s)).toEqual([box]);
    // Nothing left to redo; a new change drops what Undo stepped back from.
    s.getState().redo();
    expect(ids(s)).toEqual([box]);
    s.getState().undo();
    s.getState().addNode(mol("C"));
    expect(s.getState().future).toEqual([]);
    for (let k = 0; k < 10; k++) s.getState().undo();
    expect(ids(s)).toEqual([]);
  });

  it("undoes a wire's removal, a template or file, and Clear", () => {
    const { s, a, box } = chain();
    s.getState().removeEdges([s.getState().edges[0].id]);
    s.getState().undo();
    expect(s.getState().edges).toHaveLength(1);
    const saved = s.getState().serialize();
    s.getState().load({ version: 1, nodes: [], edges: [] }, { name: "t" });
    expect(s.getState().fileName).toBe("t");
    s.getState().undo();
    expect(ids(s)).toEqual([a, box]);
    s.getState().clear();
    s.getState().undo();
    expect(ids(s)).toEqual([a, box]);
    // Restoring a kept flow is not an Undo step.
    const before = s.getState().past.length;
    s.getState().load(saved, { history: false });
    expect(s.getState().past).toHaveLength(before);
    // Clearing an empty flow is not one either.
    const t = createFlowStore();
    t.getState().clear();
    expect(t.getState().past).toEqual([]);
  });

  it("makes typing in one field a single step, and another field a new one", () => {
    const { s, a } = chain();
    const steps = s.getState().past.length;
    s.getState().updateParams(a, { smiles: "C" } as Partial<FlowParams>);
    s.getState().updateParams(a, { smiles: "CC" } as Partial<FlowParams>);
    s.getState().updateParams(a, { smiles: "CCO" } as Partial<FlowParams>);
    expect(s.getState().past).toHaveLength(steps + 1);
    s.getState().updateParams(a, { name: "x" } as Partial<FlowParams>);
    expect(s.getState().past).toHaveLength(steps + 2);
    s.getState().undo();
    s.getState().undo();
    expect((s.getState().nodes[0].data.params as { smiles: string }).smiles).toBe("O");
    s.getState().checkpoint();
    expect(s.getState().past).toHaveLength(steps + 1);
  });

  it("keeps results Undo does not touch and marks the rest stale", async () => {
    const { s, a, box } = chain();
    await s.getState().run(fakeDeps());
    s.getState().updateParams(box, { values: { density: 0.5 } } as Partial<FlowParams>);
    s.getState().undo();
    expect(s.getState().runs[a].status).toBe("done");
    expect(s.getState().runs[box].status).toBe("stale");
    // Undoing the wire leaves the box's result stale; undoing the box drops it.
    s.setState({ viewNodeId: box });
    s.getState().undo();
    expect(s.getState().edges).toEqual([]);
    expect(s.getState().runs[box].status).toBe("stale");
    s.getState().undo();
    expect(ids(s)).toEqual([a]);
    expect(s.getState().runs[box]).toBeUndefined();
    expect(s.getState().runs[a].status).toBe("done");
    expect(s.getState().viewNodeId).toBeNull();
  });

  it("keeps at most the history limit", () => {
    const s = createFlowStore();
    for (let k = 0; k < FLOW_HISTORY_LIMIT + 5; k++) s.getState().addNode(mol());
    expect(s.getState().past).toHaveLength(FLOW_HISTORY_LIMIT);
  });

  it("leaves the graph alone while a run is in progress", () => {
    const { s, a } = chain();
    s.setState({ running: new AbortController() });
    s.getState().removeNodes([a]);
    s.getState().removeEdges([s.getState().edges[0].id]);
    expect(s.getState().nodes).toHaveLength(2);
    expect(s.getState().edges).toHaveLength(1);
    const before = s.getState().nodes;
    s.getState().undo();
    expect(s.getState().nodes).toBe(before);
    s.setState({ running: null });
    s.getState().undo();
    s.getState().redo();
    s.setState({ running: new AbortController() });
    s.getState().redo();
    expect(s.getState().future).toHaveLength(0);
  });
});

describe("the pinned document", () => {
  it("reads the document the flow's result replaced, while that result is open", async () => {
    const s = createFlowStore();
    const doc = s.getState().addNode({ type: "document" });
    const base = { data: waterData("before"), key: "doc-1" };
    const adopted = { data: waterData("result"), key: "doc-2" };
    expect(s.getState().readDocument(adopted)).toBe(adopted);
    s.getState().setPinnedDocument({ adoptedDocKey: "doc-2", base });
    expect(s.getState().readDocument(adopted)).toBe(base);
    expect(s.getState().readDocument(null)).toBeNull();
    const other = { data: waterData("edited"), key: "doc-3" };
    expect(s.getState().readDocument(other)).toBe(other);

    // A run reads through the pin, and so does the staleness check.
    let current = adopted;
    const outcome = await s.getState().run(fakeDeps({ document: () => current }));
    expect(outcome).toBe("finished");
    expect(s.getState().runs[doc].data!.name).toBe("before");
    s.getState().documentChanged("doc-2");
    expect(s.getState().runs[doc].status).toBe("done");
    current = other;
    s.getState().documentChanged("doc-3");
    expect(s.getState().runs[doc].status).toBe("stale");

    // A new flow forgets it.
    s.getState().load(s.getState().serialize());
    expect(s.getState().pinnedDocument).toBeNull();
  });

  it("says a run that could not start was busy", async () => {
    const s = createFlowStore();
    s.setState({ running: new AbortController() });
    expect(await s.getState().run(fakeDeps())).toBe("busy");
    s.getState().cancel();
    expect(s.getState().stopping).toBe(true);
    s.getState().clear();
    expect(s.getState().stopping).toBe(false);
    s.getState().cancel();
    expect(s.getState().stopping).toBe(false);
  });
});

describe("applying a generated flow", () => {
  /** The chain's flow with the molecule's SMILES changed. */
  function edited(s: StoreApi<FlowStore>, smiles: string): ReturnType<FlowStore["serialize"]> {
    const flow = s.getState().serialize();
    return {
      ...flow,
      nodes: flow.nodes.map((n) =>
        n.params.type === "molecule" ? { ...n, params: { ...n.params, smiles } } : n,
      ),
    };
  }

  it("keeps the results of unchanged blocks and marks changed ones stale", async () => {
    const { s, a, box } = chain();
    await s.getState().run(fakeDeps());
    const before = s.getState().nodes;

    s.getState().applyGenerated(s.getState().serialize());
    expect(s.getState().runs[a].status).toBe("done");
    expect(s.getState().runs[box].status).toBe("done");
    // An unchanged block keeps its params object, so nothing reads as edited.
    expect(s.getState().nodes[0].data.params).toBe(before[0].data.params);

    s.getState().applyGenerated(edited(s, "CO"));
    expect(s.getState().runs[a].status).toBe("stale");
    expect(s.getState().runs[box].status).toBe("stale");
    expect((s.getState().nodes[0].data.params as { smiles: string }).smiles).toBe("CO");
  });

  it("drops the results of blocks the new flow leaves out, and keeps the selection", async () => {
    const { s, a, box } = chain();
    await s.getState().run(fakeDeps());
    s.getState().selectNode(a);
    const flow = s.getState().serialize();
    s.getState().applyGenerated({
      ...flow,
      nodes: flow.nodes.filter((n) => n.id === a),
      edges: [],
    });
    expect(s.getState().nodes.map((n) => n.id)).toEqual([a]);
    expect(s.getState().nodes[0].selected).toBe(true);
    expect(s.getState().runs[box]).toBeUndefined();
    expect(s.getState().viewNodeId).toBeNull();
  });

  it("keeps the link to the Manual document and the file name, unlike load", () => {
    const { s } = chain();
    s.getState().setAdoptedKey("k");
    const pin = { adoptedDocKey: "d2", base: { data: waterData(), key: "d1" } };
    s.getState().setPinnedDocument(pin);
    s.getState().load(s.getState().serialize(), { name: "mine.megane-flow.json" });
    s.getState().setAdoptedKey("k");
    s.getState().setPinnedDocument(pin);
    s.getState().applyGenerated(s.getState().serialize());
    expect(s.getState().adoptedKey).toBe("k");
    expect(s.getState().pinnedDocument).toBe(pin);
    expect(s.getState().fileName).toBe("mine.megane-flow.json");
  });

  it("is one Undo step per request, tagged with its checkpoint", () => {
    const { s, box } = chain();
    const original = s.getState().nodes;
    const id = s.getState().applyGenerated(edited(s, "CO"));
    expect(id).toEqual(expect.any(Number));
    expect(s.getState().past.at(-1)?.generated).toBe(id);
    // A repair round's fix replaces the graph inside the same step.
    expect(s.getState().applyGenerated(edited(s, "CCO"), { checkpoint: false })).toBeNull();
    expect(s.getState().past.at(-1)?.generated).toBe(id);

    expect(s.getState().undoGenerated(id! + 1)).toBe(false);
    expect(s.getState().undoGenerated(id!)).toBe(true);
    expect(s.getState().nodes).toBe(original);
    expect(s.getState().nodes.map((n) => n.id)).toContain(box);
    // Nothing left to undo for that checkpoint.
    expect(s.getState().undoGenerated(id!)).toBe(false);
  });

  it("hands out a new checkpoint each request, and loses it to a later change", () => {
    const { s, a } = chain();
    const first = s.getState().applyGenerated(edited(s, "CO"))!;
    const second = s.getState().applyGenerated(edited(s, "CCO"))!;
    expect(second).toBeGreaterThan(first);
    s.getState().updateParams(a, { name: "x" } as Partial<FlowParams>);
    expect(s.getState().undoGenerated(second)).toBe(false);
  });

  it("stops a run in progress, and will not undo during one", async () => {
    const { s } = chain();
    let release: () => void = () => {};
    const deps = fakeDeps({
      embedSmiles: () =>
        new Promise((resolve) => {
          release = () => resolve(waterData().snapshot);
        }),
    });
    const id = s.getState().applyGenerated(edited(s, "CO"))!;
    const running = s.getState().run(deps);
    expect(s.getState().running).not.toBeNull();
    expect(s.getState().undoGenerated(id)).toBe(false);

    const controller = s.getState().running!;
    s.getState().applyGenerated(edited(s, "CCO"));
    expect(controller.signal.aborted).toBe(true);
    expect(s.getState().running).toBeNull();
    release();
    expect(await running).toBe("cancelled");
  });
});
