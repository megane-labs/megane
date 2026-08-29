import { describe, it, expect } from "vitest";
import {
  collectEdgeTypeErrors,
  collectOverlapErrors,
  collectRuntimeErrors,
  collectSelfCheckErrors,
  type SelfCheckContext,
} from "@/ai/selfCheck";
import type { SerializedPipeline } from "@/pipeline/types";
import type { Snapshot } from "@/types";

/** Build a minimal Snapshot for testing. Carbon=6, Hydrogen=1, Oxygen=8. */
function makeSnapshot(elements: number[], opts: Partial<Snapshot> = {}): Snapshot {
  const nAtoms = elements.length;
  return {
    nAtoms,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(elements),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    atomChainIds: null,
    atomBFactors: null,
    ...opts,
  };
}

type Node = SerializedPipeline["nodes"][number];
type Edge = SerializedPipeline["edges"][number];

function pipeline(nodes: Node[], edges: Edge[]): SerializedPipeline {
  return { version: 3, nodes, edges };
}

const LOADER: Node = {
  id: "l1",
  type: "load_structure",
  position: { x: 0, y: 0 },
} as Node;
const VIEWPORT: Node = { id: "v1", type: "viewport", position: { x: 0, y: 620 } } as Node;

function filterNode(id: string, query: string, y = 310): Node {
  return { id, type: "filter", position: { x: 0, y }, query } as Node;
}

function edge(source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return { source, target, sourceHandle, targetHandle };
}

/** loader -> filter(query) -> viewport, plus any extra nodes/edges. */
function filteredPipeline(query: string): SerializedPipeline {
  return pipeline(
    [LOADER, filterNode("f1", query), VIEWPORT],
    [edge("l1", "particle", "f1", "in"), edge("f1", "out", "v1", "particle")],
  );
}

describe("collectEdgeTypeErrors", () => {
  it("accepts a well-typed graph", () => {
    expect(collectEdgeTypeErrors(filteredPipeline('element == "C"'))).toEqual([]);
  });

  it("flags an edge that plugs a particle output into a bond input", () => {
    const p = pipeline(
      [LOADER, VIEWPORT],
      // load_structure has no `bond` output, and the viewport's `bond` input
      // only takes bond data — the executor would drop this edge silently.
      [edge("l1", "particle", "v1", "bond")],
    );
    const errors = collectEdgeTypeErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"l1".particle -> "v1".bond');
    expect(errors[0]).toContain("incompatible ports");
  });

  it("names the ports each side actually offers", () => {
    const p = pipeline([LOADER, VIEWPORT], [edge("l1", "not_a_port", "v1", "particle")]);
    expect(collectEdgeTypeErrors(p)[0]).toContain("particle (particle)");
  });

  it("ignores edges whose endpoints are unknown (the schema check reports those)", () => {
    const p = pipeline([VIEWPORT], [edge("ghost", "particle", "v1", "particle")]);
    expect(collectEdgeTypeErrors(p)).toEqual([]);
  });
});

describe("collectOverlapErrors", () => {
  it("accepts two disjoint filter branches", () => {
    const p = pipeline(
      [
        LOADER,
        filterNode("water", 'resname == "HOH"'),
        filterNode("rest", 'resname != "HOH"'),
        VIEWPORT,
      ],
      [
        edge("l1", "particle", "water", "in"),
        edge("l1", "particle", "rest", "in"),
        edge("water", "out", "v1", "particle"),
        edge("rest", "out", "v1", "particle"),
      ],
    );
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  it("flags an unfiltered branch running alongside a filtered one", () => {
    const p = pipeline(
      [LOADER, filterNode("f1", 'element == "C"'), VIEWPORT],
      [
        edge("l1", "particle", "f1", "in"),
        edge("f1", "out", "v1", "particle"),
        edge("l1", "particle", "v1", "particle"),
      ],
    );
    const errors = collectOverlapErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("drawn twice");
    expect(errors[0]).toContain("not filtered");
  });

  it("accepts a single particle branch", () => {
    const p = pipeline([LOADER, VIEWPORT], [edge("l1", "particle", "v1", "particle")]);
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  it("does not flag branches fed by different loaders", () => {
    const second = { id: "l2", type: "load_structure", position: { x: 400, y: 0 } } as Node;
    const p = pipeline(
      [LOADER, second, VIEWPORT],
      [edge("l1", "particle", "v1", "particle"), edge("l2", "particle", "v1", "particle")],
    );
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  it("counts the shared atoms exactly when a structure is loaded", () => {
    // Both branches select carbon, so all three carbons are drawn twice.
    const p = pipeline(
      [LOADER, filterNode("a", 'element == "C"'), filterNode("b", "mass > 5"), VIEWPORT],
      [
        edge("l1", "particle", "a", "in"),
        edge("l1", "particle", "b", "in"),
        edge("a", "out", "v1", "particle"),
        edge("b", "out", "v1", "particle"),
      ],
    );
    const ctx: SelfCheckContext = { snapshot: makeSnapshot([6, 6, 6, 1, 1]) };
    const errors = collectOverlapErrors(p, ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("overlap by 3 atom(s)");
  });

  it("stays quiet when the loaded structure makes the branches disjoint", () => {
    const p = pipeline(
      [LOADER, filterNode("a", 'element == "C"'), filterNode("b", 'element == "H"'), VIEWPORT],
      [
        edge("l1", "particle", "a", "in"),
        edge("l1", "particle", "b", "in"),
        edge("a", "out", "v1", "particle"),
        edge("b", "out", "v1", "particle"),
      ],
    );
    expect(collectOverlapErrors(p, { snapshot: makeSnapshot([6, 6, 1]) })).toEqual([]);
  });

  it("does not guess at a branch whose query cannot be parsed", () => {
    const p = pipeline(
      [LOADER, filterNode("a", "chain A"), filterNode("b", 'element == "C"'), VIEWPORT],
      [
        edge("l1", "particle", "a", "in"),
        edge("l1", "particle", "b", "in"),
        edge("a", "out", "v1", "particle"),
        edge("b", "out", "v1", "particle"),
      ],
    );
    expect(collectOverlapErrors(p, { snapshot: makeSnapshot([6, 1]) })).toEqual([]);
  });
});

describe("collectRuntimeErrors", () => {
  it("accepts a wired pipeline when nothing is loaded", () => {
    expect(collectRuntimeErrors(filteredPipeline('element == "C"'))).toEqual([]);
  });

  it("reports a node with nothing connected upstream", () => {
    const p = pipeline(
      [filterNode("f1", 'element == "C"'), VIEWPORT],
      [edge("f1", "out", "v1", "particle")],
    );
    expect(collectRuntimeErrors(p)).toEqual(['node "f1": No input connected']);
  });

  it("reports a cycle", () => {
    const p = pipeline(
      [LOADER, filterNode("a", "all"), filterNode("b", "all", 400), VIEWPORT],
      [
        edge("a", "out", "b", "in"),
        edge("b", "out", "a", "in"),
        edge("l1", "particle", "v1", "particle"),
      ],
    );
    expect(collectRuntimeErrors(p).some((e) => e.includes("Cycle detected"))).toBe(true);
  });

  it("reports a filter that matches no atoms in the loaded structure", () => {
    const ctx: SelfCheckContext = { snapshot: makeSnapshot([6, 6, 1]) };
    const errors = collectRuntimeErrors(filteredPipeline('element == "Fe"'), ctx);
    expect(errors.some((e) => e.includes("Filter returned 0 atoms"))).toBe(true);
  });

  it("does not report the filter as empty when it matches", () => {
    const ctx: SelfCheckContext = { snapshot: makeSnapshot([6, 6, 1]) };
    expect(collectRuntimeErrors(filteredPipeline('element == "C"'), ctx)).toEqual([]);
  });

  it("reports a replicate node used without a unit cell", () => {
    const p = pipeline(
      [
        LOADER,
        { id: "r1", type: "replicate", position: { x: 0, y: 310 }, nx: 2, ny: 1, nz: 1 } as Node,
        VIEWPORT,
      ],
      [edge("l1", "particle", "r1", "particle"), edge("r1", "particle", "v1", "particle")],
    );
    const errors = collectRuntimeErrors(p, { snapshot: makeSnapshot([6, 6]) });
    expect(errors.some((e) => e.includes("Replicate requires a unit cell"))).toBe(true);
  });

  it("stays quiet about files the user has not opened yet", () => {
    // load_volumetric has no file (the prompt tells the model to leave it
    // null), so neither it nor the isosurface downstream is the model's fault.
    const p = pipeline(
      [
        { id: "vol", type: "load_volumetric", position: { x: 0, y: 0 } } as Node,
        { id: "iso", type: "isosurface", position: { x: 0, y: 310 } } as Node,
        VIEWPORT,
      ],
      [edge("vol", "volumetric", "iso", "volumetric"), edge("iso", "mesh", "v1", "mesh")],
    );
    expect(collectRuntimeErrors(p, { snapshot: makeSnapshot([6]) })).toEqual([]);
  });

  it("ignores findings against nodes the deserializer injected", () => {
    // Deserialization normalizes the graph by adding an `add_bond` node when
    // the author left one out; on a bond-less structure it reports "No bonds
    // found", which the model can neither predict nor fix.
    const p = pipeline([LOADER, VIEWPORT], [edge("l1", "particle", "v1", "particle")]);
    expect(collectRuntimeErrors(p, { snapshot: makeSnapshot([6, 6]) })).toEqual([]);
  });

  it("still reports the same warning on an add_bond node the model wrote", () => {
    const p = pipeline(
      [LOADER, { id: "ab", type: "add_bond", position: { x: 0, y: 310 } } as Node, VIEWPORT],
      [
        edge("l1", "particle", "ab", "particle"),
        edge("ab", "bond", "v1", "bond"),
        edge("l1", "particle", "v1", "particle"),
      ],
    );
    const errors = collectRuntimeErrors(p, { snapshot: makeSnapshot([6, 6]) });
    expect(errors).toEqual(['node "ab": No bonds found (reported when the pipeline was run)']);
  });

  it("returns a single message when the pipeline cannot be deserialized", () => {
    const p = pipeline([{ id: "x", type: "nope", position: { x: 0, y: 0 } } as Node], []);
    const errors = collectRuntimeErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("could not be loaded");
  });
});

describe("collectSelfCheckErrors", () => {
  it("returns nothing for a correct pipeline", () => {
    expect(collectSelfCheckErrors(filteredPipeline('element == "C"'))).toEqual([]);
  });

  it("combines findings from every check", () => {
    const p = pipeline(
      [LOADER, filterNode("f1", 'element == "C"'), VIEWPORT],
      [
        edge("l1", "particle", "f1", "in"),
        edge("f1", "out", "v1", "particle"),
        edge("l1", "particle", "v1", "particle"),
        edge("l1", "particle", "v1", "bond"),
      ],
    );
    const errors = collectSelfCheckErrors(p);
    expect(errors.some((e) => e.includes("incompatible ports"))).toBe(true);
    expect(errors.some((e) => e.includes("drawn twice"))).toBe(true);
  });
});
