import { describe, it, expect } from "vitest";
import { executeViewport } from "@/pipeline/executors/viewport";
import type {
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
