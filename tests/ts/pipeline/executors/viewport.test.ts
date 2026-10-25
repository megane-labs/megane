import { describe, it, expect } from "vitest";
import { executeViewport } from "@/pipeline/executors/viewport";
import type {
  BondData,
  ParticleData,
  PipelineData,
  ViewportParams,
  RepresentationMode,
} from "@/pipeline/types";
import type { Snapshot } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    positions: new Float32Array(6),
    elements: new Uint8Array([6, 6]),
    bonds: new Uint32Array(),
    bondOrders: null,
  } as unknown as Snapshot;
}

function makeParticle(
  sourceNodeId: string,
  representationOverride: RepresentationMode | null = null,
  indices: Uint32Array | null = null,
): ParticleData {
  return {
    type: "particle",
    source: makeSnapshot(),
    sourceNodeId,
    indices,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride,
  };
}

const baseParams: ViewportParams = {
  type: "viewport",
  perspective: false,
  cellAxesVisible: true,
  pivotMarkerVisible: true,
};

function inputs(particles: ParticleData[]): Map<string, PipelineData[]> {
  return new Map([["particle", particles as PipelineData[]]]);
}

describe("executeViewport — representation pickup", () => {
  it('falls back to "atoms" when no particle stream carries an override', () => {
    const state = executeViewport(baseParams, inputs([makeParticle("a")]));
    expect(state.representationMode).toBe("atoms");
  });

  it("picks the first particle stream's override (Ovito-style)", () => {
    const state = executeViewport(
      baseParams,
      inputs([makeParticle("a", "cartoon"), makeParticle("b", "surface")]),
    );
    expect(state.representationMode).toBe("cartoon");
  });

  it("ignores null overrides and uses the first non-null one", () => {
    const state = executeViewport(
      baseParams,
      inputs([makeParticle("a", null), makeParticle("b", "surface")]),
    );
    expect(state.representationMode).toBe("surface");
  });

  it('returns "atoms" when there are no particle inputs at all', () => {
    const state = executeViewport(baseParams, new Map());
    expect(state.representationMode).toBe("atoms");
  });

  it("passes the licorice override through to the viewport state", () => {
    const state = executeViewport(baseParams, inputs([makeParticle("a", "licorice")]));
    expect(state.representationMode).toBe("licorice");
  });

  it("leaves representationByAtom null when the whole structure shares one mode", () => {
    const state = executeViewport(baseParams, inputs([makeParticle("a", "line")]));
    expect(state.representationMode).toBe("line");
    expect(state.representationByAtom).toBeNull();
  });

  it("builds a per-atom array for disjoint branches (water as lines)", () => {
    // 2-atom snapshot: atom 0 = line branch, atom 1 = plain (base "atoms").
    const lineBranch = makeParticle("a", "line", new Uint32Array([0]));
    const restBranch = makeParticle("a", null, new Uint32Array([1]));
    const state = executeViewport(baseParams, inputs([lineBranch, restBranch]));
    expect(state.representationByAtom).toEqual(["line", "atoms"]);
    // Global mesh mode is the non-line base for the rest of the structure.
    expect(state.representationMode).toBe("atoms");
  });

  it("uses the first non-line override as the base mesh mode in a mixed view", () => {
    const lineBranch = makeParticle("a", "line", new Uint32Array([0]));
    const licoriceBranch = makeParticle("a", "licorice", new Uint32Array([1]));
    const state = executeViewport(baseParams, inputs([lineBranch, licoriceBranch]));
    expect(state.representationMode).toBe("licorice");
    expect(state.representationByAtom).toEqual(["line", "licorice"]);
  });
});

describe("executeViewport — selections beat a global style", () => {
  it("lets a selection's representation win over a whole-structure one ahead of it", () => {
    const global = makeParticle("a", "licorice");
    const layer = makeParticle("a", "line", new Uint32Array([1]));
    const state = executeViewport(baseParams, inputs([global, layer]));
    expect(state.representationByAtom).toEqual(["licorice", "line"]);
    expect(state.representationMode).toBe("licorice");
  });
});

describe("executeViewport — bond pruning keeps per-bond channels aligned", () => {
  // Atoms: C0, C1, H2, H3. Bond 0 = H2–H3, bond 1 = C0–C1.
  function makeBond(overrides: Partial<BondData> = {}): BondData {
    return {
      type: "bond",
      sourceNodeId: "a",
      bondIndices: new Uint32Array([2, 3, 0, 1]),
      bondOrders: new Uint8Array([1, 2]),
      nBonds: 2,
      scale: 1,
      opacity: 1,
      positions: null,
      elements: null,
      nAtoms: 0,
      atomElements: new Uint8Array([6, 6, 1, 1]),
      selectedBondIndices: new Uint32Array([0]),
      bondOpacityOverrides: new Float32Array([0, 1]),
      ...overrides,
    };
  }

  function run(bond: BondData): BondData {
    const carbons = makeParticle("a", null, new Uint32Array([0, 1]));
    const state = executeViewport(
      baseParams,
      new Map<string, PipelineData[]>([
        ["particle", [carbons]],
        ["bond", [bond]],
      ]),
    );
    return state.bonds[0];
  }

  it("drops the opacity override of a pruned bond instead of shifting it onto a survivor", () => {
    const out = run(makeBond());
    expect(out.nBonds).toBe(1);
    expect(Array.from(out.bondIndices)).toEqual([0, 1]);
    expect(Array.from(out.bondOrders!)).toEqual([2]);
    // The surviving C–C bond keeps its own (opaque) override.
    expect(Array.from(out.bondOpacityOverrides!)).toEqual([1]);
  });

  it("renumbers the bond selection to the compacted bond list", () => {
    // Select only the C–C bond (old index 1) → new index 0.
    const out = run(makeBond({ selectedBondIndices: new Uint32Array([1]) }));
    expect(Array.from(out.selectedBondIndices!)).toEqual([0]);
    // A selection that only named pruned bonds becomes empty, not stale.
    expect(Array.from(run(makeBond()).selectedBondIndices!)).toEqual([]);
  });

  it("leaves absent per-bond channels absent", () => {
    const out = run(makeBond({ selectedBondIndices: null, bondOpacityOverrides: null }));
    expect(out.nBonds).toBe(1);
    expect(out.selectedBondIndices).toBeNull();
    expect(out.bondOpacityOverrides).toBeNull();
  });
});
