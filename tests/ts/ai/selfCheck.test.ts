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

/** A `modify` that changes how its atoms are drawn (opacity < 1 or scale != 1). */
function modifyNode(id: string, opacity: number, y = 460): Node {
  return { id, type: "modify", position: { x: 0, y }, scale: 1, opacity } as Node;
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

  // The construction that hides a species: the unfiltered structure and a
  // faded selection both reach the viewport. The Viewport merges per-atom
  // overrides onto the one loaded structure, so the base contributes nothing
  // and the fade wins for the atoms it covers. Every filter reference in
  // bench/llm/golden is built this way, and removing the base from one of
  // them changed 0.0000% of pixels. Reporting it would send the model to
  // "repair" a pipeline that is already right.
  it("accepts an unfiltered base beside a filtered branch that fades its atoms", () => {
    const p = pipeline(
      [LOADER, filterNode("f1", 'element == "C"'), modifyNode("m1", 0), VIEWPORT],
      [
        edge("l1", "particle", "f1", "in"),
        edge("f1", "out", "m1", "in"),
        edge("m1", "out", "v1", "particle"),
        edge("l1", "particle", "v1", "particle"),
      ],
    );
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  // Two branches that select without changing anything ask the Viewport for
  // nothing either way — the crystal-distance-bonds reference carries exactly
  // this (the raw stream beside a drawing_boundary), and both draw the same.
  it("accepts overlapping branches that only select", () => {
    const p = pipeline(
      [LOADER, filterNode("f1", 'element == "C"'), VIEWPORT],
      [
        edge("l1", "particle", "f1", "in"),
        edge("f1", "out", "v1", "particle"),
        edge("l1", "particle", "v1", "particle"),
      ],
    );
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  it("flags an unfiltered branch that changes the drawing beside a filtered one that does too", () => {
    const p = pipeline(
      [
        LOADER,
        filterNode("f1", 'element == "C"'),
        modifyNode("fade", 0),
        modifyNode("shrink", 0.5, 150),
        VIEWPORT,
      ],
      [
        edge("l1", "particle", "f1", "in"),
        edge("f1", "out", "fade", "in"),
        edge("fade", "out", "v1", "particle"),
        // The whole structure at half opacity, on top of the carbons at zero.
        edge("l1", "particle", "shrink", "in"),
        edge("shrink", "out", "v1", "particle"),
      ],
    );
    const errors = collectOverlapErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("which change wins is unspecified");
    expect(errors[0]).toContain("not filtered");
  });

  it("accepts a single particle branch", () => {
    const p = pipeline([LOADER, VIEWPORT], [edge("l1", "particle", "v1", "particle")]);
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  it("does not flag branches fed by different loaders", () => {
    const second = { id: "l2", type: "load_structure", position: { x: 400, y: 0 } } as Node;
    const p = pipeline(
      [LOADER, second, modifyNode("a", 0.5), modifyNode("b", 0.2, 150), VIEWPORT],
      [
        edge("l1", "particle", "a", "in"),
        edge("a", "out", "v1", "particle"),
        edge("l2", "particle", "b", "in"),
        edge("b", "out", "v1", "particle"),
      ],
    );
    expect(collectOverlapErrors(p)).toEqual([]);
  });

  /** loader -> filter(a) -> modify -> viewport, loader -> filter(b) -> modify -> viewport. */
  function twoTreatedBranches(queryA: string, queryB: string): SerializedPipeline {
    return pipeline(
      [
        LOADER,
        filterNode("a", queryA),
        filterNode("b", queryB, 150),
        modifyNode("ma", 0.5),
        modifyNode("mb", 0.2, 460),
        VIEWPORT,
      ],
      [
        edge("l1", "particle", "a", "in"),
        edge("l1", "particle", "b", "in"),
        edge("a", "out", "ma", "in"),
        edge("b", "out", "mb", "in"),
        edge("ma", "out", "v1", "particle"),
        edge("mb", "out", "v1", "particle"),
      ],
    );
  }

  it("counts the shared atoms exactly when a structure is loaded", () => {
    // Both branches select carbon and each fades it differently, so for all
    // three carbons which opacity applies is unspecified.
    const p = twoTreatedBranches('element == "C"', "mass > 5");
    const ctx: SelfCheckContext = { snapshot: makeSnapshot([6, 6, 6, 1, 1]) };
    const errors = collectOverlapErrors(p, ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("overlap by 3 atom(s)");
    expect(errors[0]).toContain("which change wins is unspecified");
  });

  it("stays quiet when the loaded structure makes the branches disjoint", () => {
    const p = twoTreatedBranches('element == "C"', 'element == "H"');
    expect(collectOverlapErrors(p, { snapshot: makeSnapshot([6, 6, 1]) })).toEqual([]);
  });

  it("does not guess at a branch whose query cannot be parsed", () => {
    const p = twoTreatedBranches("chain A", 'element == "C"');
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

  it("reports a node whose output reaches no viewport", () => {
    // The scorer grades this as a structural defect ("all nodes reach a
    // viewport"), and the executor never runs the node, so the model must hear
    // about it — even though validatePipeline files it as a warning.
    const p = pipeline(
      [
        LOADER,
        { id: "t1", type: "load_trajectory", position: { x: 200, y: 155 } } as Node,
        VIEWPORT,
      ],
      [edge("l1", "particle", "t1", "particle"), edge("l1", "particle", "v1", "particle")],
    );
    const errors = collectRuntimeErrors(p);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('node "t1"');
    expect(errors[0]).toContain("reaches nothing");
  });

  it("accepts a chain that legitimately ends at a non-viewport sink", () => {
    // spectrum_plot has no output ports and draws into its own node body, so
    // load_spectrum -> spectrum_plot arrives somewhere; flagging either node
    // would ask the model for something impossible.
    const p = pipeline(
      [
        { id: "s1", type: "load_spectrum", position: { x: 0, y: 0 } } as Node,
        { id: "p1", type: "spectrum_plot", position: { x: 0, y: 155 } } as Node,
        LOADER,
        VIEWPORT,
      ],
      [edge("s1", "spectrum", "p1", "spectrum"), edge("l1", "particle", "v1", "particle")],
    );
    expect(collectRuntimeErrors(p)).toEqual([]);
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
      [
        LOADER,
        filterNode("f1", 'element == "C"'),
        modifyNode("m1", 0),
        modifyNode("m2", 0.5, 150),
        VIEWPORT,
      ],
      [
        edge("l1", "particle", "f1", "in"),
        edge("f1", "out", "m1", "in"),
        edge("m1", "out", "v1", "particle"),
        edge("l1", "particle", "m2", "in"),
        edge("m2", "out", "v1", "particle"),
        edge("l1", "particle", "v1", "bond"),
      ],
    );
    const errors = collectSelfCheckErrors(p);
    expect(errors.some((e) => e.includes("incompatible ports"))).toBe(true);
    expect(errors.some((e) => e.includes("which change wins is unspecified"))).toBe(true);
  });
});

describe("collectSelfCheckErrors — one structure per loader", () => {
  const water = makeSnapshot([8, 1, 1]);
  const methane = makeSnapshot([6, 1, 1, 1, 1]);
  /** The editor: loader-1 holds water (also the primary structure), loader-2 methane. */
  const ctx: SelfCheckContext = {
    snapshot: water,
    nodeSnapshots: {
      "loader-1": { snapshot: water, frames: null, meta: null, labels: ["HOH", "HOH", "HOH"] },
      "loader-2": { snapshot: methane, frames: null, meta: null, labels: Array(5).fill("MET1") },
    },
    loaderIds: ["loader-1", "loader-2"],
  };
  const loader = (id: string, x = 0): Node =>
    ({ id, type: "load_structure", position: { x, y: 0 } }) as Node;

  /** Both loaders drawn; `branch` hangs off loader-2. */
  function twoLoaders(branch: Node[], branchEdges: Edge[]): SerializedPipeline {
    return pipeline(
      [loader("loader-1"), loader("loader-2", 300), ...branch, VIEWPORT],
      [edge("loader-1", "particle", "v1", "particle"), ...branchEdges],
    );
  }

  it("runs a kept loader's filter against that loader's own structure", () => {
    for (const query of ['element == "C"', 'resname == "MET"']) {
      const p = twoLoaders(
        [filterNode("f1", query), modifyNode("m1", 0.5)],
        [
          edge("loader-2", "particle", "f1", "in"),
          edge("f1", "out", "m1", "in"),
          edge("m1", "out", "v1", "particle"),
        ],
      );
      expect(collectSelfCheckErrors(p, ctx)).toEqual([]);
    }
    // A query that is wrong for methane is still reported.
    const wrong = twoLoaders(
      [filterNode("f1", 'element == "O"')],
      [edge("loader-2", "particle", "f1", "in"), edge("f1", "out", "v1", "particle")],
    );
    expect(collectSelfCheckErrors(wrong, ctx).join("\n")).toContain("Filter returned 0 atoms");
  });

  it("evaluates a loader's overlapping branches against its own structure", () => {
    // On methane, O selects nothing, so the two treatments share no atom; on
    // water (the primary structure) they would share atom 0.
    const p = twoLoaders(
      [
        filterNode("fa", 'element == "O"'),
        modifyNode("ma", 0.5),
        filterNode("fb", "index == 0"),
        modifyNode("mb", 0),
      ],
      [
        edge("loader-2", "particle", "fa", "in"),
        edge("fa", "out", "ma", "in"),
        edge("ma", "out", "v1", "particle"),
        edge("loader-2", "particle", "fb", "in"),
        edge("fb", "out", "mb", "in"),
        edge("mb", "out", "v1", "particle"),
      ],
    );
    const errors = collectOverlapErrors(p, ctx);
    expect(errors).toEqual([]);
  });

  it("keys the structures by loader without a graph order, and survives a pipeline it cannot load", () => {
    const p = twoLoaders(
      [filterNode("f1", 'element == "C"'), modifyNode("m1", 0.5)],
      [
        edge("loader-2", "particle", "f1", "in"),
        edge("f1", "out", "m1", "in"),
        edge("m1", "out", "v1", "particle"),
      ],
    );
    expect(collectSelfCheckErrors(p, { ...ctx, loaderIds: undefined })).toEqual([]);
    const broken = pipeline([{ id: "x", type: "warp", position: { x: 0, y: 0 } } as Node], []);
    expect(collectOverlapErrors(broken, ctx)).toEqual([]);
  });

  it("gives a rebuilt graph's first new loader the primary structure, as applying it would", () => {
    const p = pipeline(
      [loader("fresh"), filterNode("f1", 'resname == "HOH"'), VIEWPORT],
      [edge("fresh", "particle", "f1", "in"), edge("f1", "out", "v1", "particle")],
    );
    expect(collectSelfCheckErrors(p, ctx)).toEqual([]);
  });
});
