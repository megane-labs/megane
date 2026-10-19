/** Flow mode's store: wiring rules, stale results, runs, and saved flows. */

import { describe, it, expect } from "vitest";
import {
  createFlowStore,
  flowViewData,
  parseSerializedFlow,
  type FlowStore,
} from "@/builder/flow/store";
import { initialToolParams } from "@/builder/flow/ports";
import type { FlowParams } from "@/builder/flow/types";
import type { StoreApi } from "zustand";
import { fakeDeps, tools } from "./helpers";

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
