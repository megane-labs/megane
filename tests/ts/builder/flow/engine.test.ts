/**
 * Flow mode's engine: graph order, cache keys, and running blocks — molecules
 * from SMILES and the library, the Manual structure, and tool calls answered
 * with the reference server's recorded results.
 */

import { describe, it, expect, vi } from "vitest";
import {
  downstream,
  incoming,
  inputProblem,
  libraryMoleculeSnapshot,
  nodeKey,
  runBlock,
  runFlow,
  stableStringify,
  topoOrder,
  wouldCycle,
  type FlowGraph,
} from "@/builder/flow/engine";
import { initialToolParams } from "@/builder/flow/ports";
import { IDLE_RUN, type FlowParams, type NodeRun } from "@/builder/flow/types";
import { LIB_WATER, fakeDeps, recorded, tools, water, waterData } from "./helpers";

const smiles = (s: string, name = ""): FlowParams => ({
  type: "molecule",
  source: "smiles",
  smiles: s,
  libraryId: "",
  name,
});

function graph(nodes: [string, FlowParams][], edges: [string, string, string][] = []): FlowGraph {
  return {
    nodes: nodes.map(([id, params]) => ({ id, data: { params } })),
    edges: edges.map(([source, target, targetHandle]) => ({
      id: `${source}-${target}-${targetHandle}`,
      source,
      target,
      targetHandle,
    })),
  };
}

function liquidBox(rows: Record<string, number> = {}): FlowParams {
  const params = initialToolParams(tools.liquid_box);
  return {
    ...params,
    values: { ...params.values, seed: 7 },
    rows: {
      components: Object.fromEntries(Object.entries(rows).map(([id, count]) => [id, { count }])),
    },
  };
}

async function run(g: FlowGraph, deps = fakeDeps(), previous: Record<string, NodeRun> = {}) {
  const updates: [string, NodeRun][] = [];
  const runs = await runFlow(g, deps, previous, {
    signal: new AbortController().signal,
    onUpdate: (id, r) => updates.push([id, r]),
  });
  return { runs, updates, deps };
}

describe("stableStringify / nodeKey", () => {
  it("sorts object keys and drops undefined", () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(
      '{"a":[1,{"d":2}],"b":1}',
    );
    expect(stableStringify(undefined)).toBe("null");
  });

  it("gives equal keys for equal params whatever their key order", () => {
    const a = nodeKey(smiles("CCO"), { x: ["k1"] });
    const b = nodeKey(
      { name: "", libraryId: "", smiles: "CCO", source: "smiles", type: "molecule" },
      {
        x: ["k1"],
      },
    );
    expect(a).toBe(b);
    expect(nodeKey(smiles("CCO"), { x: ["k2"] })).not.toBe(a);
    expect(nodeKey(smiles("CCO"), {}, "doc-1")).not.toBe(nodeKey(smiles("CCO"), {}, "doc-2"));
  });
});

describe("graph helpers", () => {
  const g = graph(
    [
      ["a", smiles("O")],
      ["b", smiles("C")],
      ["c", liquidBox()],
    ],
    [
      ["a", "c", "components"],
      ["b", "c", "components"],
    ],
  );

  it("lists upstream ids per input in wire order", () => {
    expect(incoming(g, "c")).toEqual({ components: ["a", "b"] });
    expect(incoming(g, "a")).toEqual({});
    const noHandle: FlowGraph = { nodes: g.nodes, edges: [{ id: "e", source: "a", target: "c" }] };
    expect(incoming(noHandle, "c")).toEqual({ in: ["a"] });
  });

  it("orders blocks after their inputs and finds loops", () => {
    const order = topoOrder(g)!;
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
    const loop = graph(
      [
        ["a", smiles("O")],
        ["b", smiles("C")],
      ],
      [
        ["a", "b", "x"],
        ["b", "a", "x"],
      ],
    );
    expect(topoOrder(loop)).toBeNull();
  });

  it("ignores wires to blocks that are gone", () => {
    const dangling = graph([["a", smiles("O")]], [["a", "zz", "x"]]);
    expect(topoOrder(dangling)).toEqual(["a"]);
  });

  it("finds what is downstream and what would loop", () => {
    expect([...downstream(g, "a")].sort()).toEqual(["a", "c"]);
    expect(wouldCycle(g, "c", "a")).toBe(true);
    expect(wouldCycle(g, "a", "b")).toBe(false);
  });
});

describe("libraryMoleculeSnapshot", () => {
  it("keeps elements, positions and bond orders", () => {
    const snap = libraryMoleculeSnapshot({ ...LIB_WATER, bondOrders: [1, 2] });
    expect(snap.nAtoms).toBe(3);
    expect(Array.from(snap.elements)).toEqual([8, 1, 1]);
    expect(Array.from(snap.bondOrders!)).toEqual([1, 2]);
    expect(snap.box).toBeNull();
  });
});

describe("runBlock", () => {
  const ctx = (deps = fakeDeps()) => ({
    sources: {},
    inputs: {},
    deps,
    signal: new AbortController().signal,
    onProgress: () => {},
  });

  it("embeds a SMILES molecule and names it", async () => {
    const deps = fakeDeps();
    const r = await runBlock(smiles(" CCO ", ""), ctx(deps));
    expect(deps.embedSmiles).toHaveBeenCalledWith("CCO");
    expect(r.data.name).toBe("CCO");
    const named = await runBlock(smiles("CCO", "ethanol"), ctx(deps));
    expect(named.data.name).toBe("ethanol");
  });

  it("runs a built-in block with its wired inputs", async () => {
    const r = await runBlock(
      {
        type: "crystal",
        structure: "fcc",
        elements: ["Au", "", ""],
        a: 4.08,
        covera: 1,
        cubic: true,
      },
      ctx(),
    );
    expect(r).toMatchObject({ data: { name: "Au-fcc" }, warnings: [], summary: null });
    expect(r.data.snapshot.nAtoms).toBe(4);
    const big = await runBlock(
      { type: "supercell", repeat: [2, 2, 2] },
      { ...ctx(), sources: { structure: ["c"] }, inputs: { c: r.data } },
    );
    expect(big.data.snapshot.nAtoms).toBe(32);
  });

  it("refuses a block type it does not know", async () => {
    await expect(runBlock({ type: "nope" } as unknown as FlowParams, ctx())).rejects.toThrow(
      "Unknown block.",
    );
  });

  it("refuses an empty SMILES", async () => {
    await expect(runBlock(smiles("  "), ctx())).rejects.toThrow("Enter a SMILES string.");
  });

  it("takes a library molecule, and refuses a missing one", async () => {
    const params: FlowParams = {
      type: "molecule",
      source: "library",
      smiles: "",
      libraryId: "preset:water",
      name: "",
    };
    const r = await runBlock(params, ctx());
    expect(r.data.name).toBe("water");
    expect(r.data.snapshot.nAtoms).toBe(3);
    const renamed = await runBlock({ ...params, name: "SOL" }, ctx());
    expect(renamed.data.name).toBe("SOL");
    await expect(runBlock({ ...params, libraryId: "user:gone" }, ctx())).rejects.toThrow(
      "Choose a molecule",
    );
  });

  it("uses the Manual structure, and refuses without one", async () => {
    await expect(runBlock({ type: "document" }, ctx())).rejects.toThrow("no structure open");
    const deps = fakeDeps({ document: () => ({ data: waterData("doc"), key: "doc-1" }) });
    const r = await runBlock({ type: "document" }, ctx(deps));
    expect(r.data.name).toBe("doc");
  });

  it("asks for a server that offers the tool", async () => {
    const deps = fakeDeps({ tool: () => null });
    await expect(runBlock(liquidBox(), ctx(deps))).rejects.toThrow(
      "Connect to a tool server that offers Liquid box.",
    );
    const nameOnly = { ...(liquidBox() as Extract<FlowParams, { type: "tool" }>), label: "" };
    await expect(runBlock(nameOnly, ctx(deps))).rejects.toThrow("offers liquid_box.");
  });

  it("asks for a required input", async () => {
    await expect(runBlock(liquidBox(), ctx())).rejects.toThrow(
      "Connect at least one block to Components.",
    );
    const solvate = initialToolParams(tools.solvate);
    await expect(runBlock(solvate, ctx())).rejects.toThrow("Connect a block to");
  });

  it("refuses a tool whose form needs the 3D selection", async () => {
    const tool = {
      ...tools.solvate,
      fields: [
        ...tools.solvate.fields!,
        {
          kind: "widget" as const,
          widget: "selection" as const,
          key: "atoms",
          label: "Atoms",
          help: null,
          required: true,
          default: undefined,
          example: undefined,
          of: null,
          unit: null,
        },
      ],
    };
    const deps = fakeDeps({ tool: () => tool });
    await expect(runBlock(initialToolParams(tool), ctx(deps))).rejects.toThrow("Manual mode");
  });

  it("reports a form problem before calling", async () => {
    const deps = fakeDeps();
    const params = liquidBox({ a: 0 });
    await expect(
      runBlock(params, {
        ...ctx(deps),
        sources: { components: ["a"] },
        inputs: { a: waterData() },
      }),
    ).rejects.toThrow("Count must be at least 1.");
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("reports the tool's own error", async () => {
    const deps = fakeDeps({ call: async () => ({ ok: false, error: "packmol failed" }) });
    await expect(
      runBlock(liquidBox({ a: 10 }), {
        ...ctx(deps),
        sources: { components: ["a"] },
        inputs: { a: waterData() },
      }),
    ).rejects.toThrow("packmol failed");
  });

  it("adds an insert tool's atoms to the structure wired in", async () => {
    const solvate = initialToolParams(tools.solvate);
    const deps = fakeDeps();
    const doc = {
      ...waterData("slab"),
      snapshot: { ...water(), box: new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]) },
    };
    const r = await runBlock(solvate, {
      ...ctx(deps),
      sources: { document: ["d"], solvent: ["s"] },
      inputs: { d: doc, s: waterData("water") },
    });
    const added = recorded("solvate");
    const n = added.ok ? added.result.structure.elements.length : 0;
    expect(r.data.snapshot.nAtoms).toBe(3 + n);
    expect(r.data.name).toBe("slab");
    expect(r.data.labels).toHaveLength(3 + n);
    expect(r.data.labels![0]).toBe("UNK1");
    expect(deps.calls[0].args.document).toMatchObject({ elements: [8, 1, 1] });
    expect(deps.calls[0].args.solvent).toMatchObject({ name: "water" });
  });

  it("refuses an insert tool without the structure to add to", async () => {
    const bare = {
      ...tools.solvate,
      fields: tools.solvate.fields!.map((f) =>
        f.key === "document" ? { ...f, required: false } : f,
      ),
    };
    const deps = fakeDeps({ tool: () => bare });
    await expect(
      runBlock(initialToolParams(bare), {
        ...ctx(deps),
        sources: { solvent: ["s"] },
        inputs: { s: waterData() },
      }),
    ).rejects.toThrow("Connect the structure to add to.");
  });
});

describe("runFlow", () => {
  const chain = () =>
    graph(
      [
        ["mol", smiles("O", "water")],
        ["box", liquidBox({ mol: 100 })],
      ],
      [["mol", "box", "components"]],
    );

  it("builds a liquid box from a SMILES molecule", async () => {
    const { runs, deps, updates } = await run(chain());
    expect(runs.mol.status).toBe("done");
    expect(runs.box.status).toBe("done");
    expect(runs.box.data!.snapshot.nAtoms).toBe(300);
    expect(runs.box.data!.labels![0]).toBe("WATE1");
    expect(runs.box.summary).toBe("liquid_box done.");
    const args = deps.calls[0].args as {
      components: { count: number; molecule: { name: string } }[];
      seed: number;
    };
    expect(args.seed).toBe(7);
    expect(args.components).toHaveLength(1);
    expect(args.components[0].count).toBe(100);
    expect(args.components[0].molecule.name).toBe("water");
    expect(updates.map(([id, r]) => `${id}:${r.status}`)).toEqual([
      "mol:running",
      "mol:done",
      "box:running",
      "box:done",
    ]);
  });

  it("reuses cached results whose key did not change", async () => {
    const first = await run(chain());
    const deps = fakeDeps();
    const second = await run(chain(), deps, first.runs);
    expect(deps.embedSmiles).not.toHaveBeenCalled();
    expect(deps.call).not.toHaveBeenCalled();
    expect(second.runs.box.data).toBe(first.runs.box.data);

    // A stale result whose key comes back the same is reused too.
    const stale = { ...first.runs, box: { ...first.runs.box, status: "stale" as const } };
    const third = await run(chain(), fakeDeps(), stale);
    expect(third.runs.box.status).toBe("done");

    // A changed count re-runs the box only.
    const changed = chain();
    changed.nodes[1].data.params = liquidBox({ mol: 50 });
    const deps2 = fakeDeps();
    await run(changed, deps2, first.runs);
    expect(deps2.embedSmiles).not.toHaveBeenCalled();
    expect(deps2.calls[0].args.components).toMatchObject([{ count: 50 }]);
  });

  it("re-runs the Manual structure block when the document changes", async () => {
    let key = "doc-1";
    const deps = fakeDeps({ document: () => ({ data: waterData("doc"), key }) });
    const g = graph([["d", { type: "document" }]]);
    const first = await run(g, deps);
    key = "doc-2";
    const { updates } = await run(g, deps, first.runs);
    expect(updates.map(([, r]) => r.status)).toEqual(["running", "done"]);
  });

  it("stops a block whose input failed", async () => {
    const deps = fakeDeps({ embedSmiles: async () => Promise.reject(new Error("bad SMILES")) });
    const { runs } = await run(chain(), deps);
    expect(runs.mol).toMatchObject({ status: "error", error: "bad SMILES" });
    // The error names the input block and passes on its own.
    expect(runs.box).toMatchObject({
      status: "error",
      error: "Input “Molecule: water” failed: bad SMILES",
    });
    expect(deps.call).not.toHaveBeenCalled();
  });

  it("refuses a loop", async () => {
    const loop = graph(
      [
        ["a", liquidBox()],
        ["b", liquidBox()],
      ],
      [
        ["a", "b", "components"],
        ["b", "a", "components"],
      ],
    );
    await expect(run(loop)).rejects.toThrow("loop");
  });

  it("runs only what the targets need", async () => {
    const g = graph([
      ["a", smiles("O")],
      ["b", smiles("C")],
    ]);
    const deps = fakeDeps();
    const runs = await runFlow(
      g,
      deps,
      {},
      {
        signal: new AbortController().signal,
        onUpdate: () => {},
        targets: ["b"],
      },
    );
    expect(runs.a).toBeUndefined();
    expect(runs.b.status).toBe("done");
  });

  it("reports tool progress while it runs", async () => {
    const seen: (number | null)[] = [];
    const deps = fakeDeps({
      call: async (tool, _args, { onProgress }) => {
        onProgress?.(0.5, "packing");
        return recorded(tool.name);
      },
    });
    await runFlow(
      chain(),
      deps,
      {},
      {
        signal: new AbortController().signal,
        onUpdate: (id, r) => {
          if (id === "box" && r.status === "running") seen.push(r.fraction);
        },
      },
    );
    expect(seen).toEqual([null, 0.5]);
  });

  it("keeps the previous state of blocks when stopped", async () => {
    const controller = new AbortController();
    const deps = fakeDeps({
      call: vi.fn(async () => {
        controller.abort();
        return { ok: false as const, error: "Cancelled." };
      }),
    });
    const runs = await runFlow(
      chain(),
      deps,
      {},
      { signal: controller.signal, onUpdate: () => {} },
    );
    expect(runs.mol.status).toBe("done");
    expect(runs.box.status).toBe("idle");

    // Aborted after a block succeeded: its result is dropped too.
    const c2 = new AbortController();
    const deps2 = fakeDeps({
      embedSmiles: async () => {
        c2.abort();
        return water();
      },
    });
    const runs2 = await runFlow(chain(), deps2, {}, { signal: c2.signal, onUpdate: () => {} });
    expect(runs2.mol.status).toBe("idle");
    expect(runs2.box).toBeUndefined();
  });
});

describe("Stop while RDKit embeds", () => {
  it("ends the run at once, keeping the block's previous state", async () => {
    const controller = new AbortController();
    const deps = fakeDeps({ embedSmiles: () => new Promise(() => {}) });
    const g = graph([["m", smiles("CCO")]]);
    const pending = runFlow(g, deps, {}, { signal: controller.signal, onUpdate: () => {} });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const runs = await pending;
    expect(runs.m.status).toBe("idle");
  });

  it("stamps when a block started running", async () => {
    const seen: (number | undefined)[] = [];
    await runFlow(
      graph([["m", smiles("O")]]),
      fakeDeps(),
      {},
      {
        signal: new AbortController().signal,
        onUpdate: (_id, r) => {
          if (r.status === "running") seen.push(r.startedAt);
        },
      },
    );
    expect(typeof seen[0]).toBe("number");
  });
});

describe("inputProblem", () => {
  it("names the input block, its tool, and its error", () => {
    const g = graph([
      ["t", liquidBox({})],
      ["gone", smiles("O")],
    ]);
    expect(inputProblem(g, fakeDeps(), "t", { ...IDLE_RUN, status: "error", error: "x" })).toBe(
      "Input “Liquid box” failed: x",
    );
    expect(inputProblem(g, fakeDeps(), "gone", undefined)).toBe(
      "Input “Molecule: O” did not produce a structure.",
    );
    expect(inputProblem(g, fakeDeps(), "missing", undefined)).toBe(
      "Input “missing” did not produce a structure.",
    );
  });
});
