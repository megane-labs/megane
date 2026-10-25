import { describe, it, expect } from "vitest";
import { executeFilter } from "@/pipeline/executors/filter";
import type { FilterParams, ParticleData, BondData, PipelineData } from "@/pipeline/types";
import type { Snapshot } from "@/types";

// Two water molecules (O-H-H each): atoms 0-2 = mol 0, atoms 3-5 = mol 1.
function makeSnapshot(): Snapshot {
  return {
    nAtoms: 6,
    nBonds: 4,
    nFileBonds: 4,
    positions: new Float32Array(18),
    elements: new Uint8Array([8, 1, 1, 8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]),
    bondOrders: null,
    box: null,
  } as unknown as Snapshot;
}

function makeParticle(opts: Partial<ParticleData> = {}): ParticleData {
  return {
    type: "particle",
    source: makeSnapshot(),
    sourceNodeId: "src",
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
    ...opts,
  };
}

function makeBond(opts: Partial<BondData> = {}): BondData {
  return {
    type: "bond",
    sourceNodeId: "src",
    bondIndices: new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]),
    bondOrders: null,
    nBonds: 4,
    scale: 1.0,
    opacity: 1.0,
    positions: null,
    elements: null,
    nAtoms: 6,
    atomElements: new Uint8Array([8, 1, 1, 8, 1, 1]),
    selectedBondIndices: null,
    bondOpacityOverrides: null,
    ...opts,
  };
}

function inputs(data: PipelineData): Map<string, PipelineData[]> {
  return new Map([["in", [data]]]);
}

function baseParams(extra: Partial<FilterParams> = {}): FilterParams {
  return { type: "filter", query: "", ...extra };
}

describe("executeFilter — no input", () => {
  it("returns no output when there is no input", () => {
    const out = executeFilter(baseParams(), new Map(), null);
    expect(out.size).toBe(0);
  });
});

describe("executeFilter — particle stream", () => {
  it("passes through unchanged when query is empty", () => {
    const particle = makeParticle();
    const out = executeFilter(baseParams(), inputs(particle), null);
    expect(out.get("out")).toBe(particle);
  });

  it("sets indices to atoms matching molecule_id == 0", () => {
    const out = executeFilter(
      baseParams({ query: "molecule_id == 0" }),
      inputs(makeParticle()),
      null,
    );
    const result = out.get("out") as ParticleData;
    expect(Array.from(result.indices!)).toEqual([0, 1, 2]);
  });

  it("intersects with pre-existing indices", () => {
    const particle = makeParticle({ indices: new Uint32Array([1, 2, 3, 4]) });
    const out = executeFilter(baseParams({ query: "molecule_id == 0" }), inputs(particle), null);
    const result = out.get("out") as ParticleData;
    expect(Array.from(result.indices!)).toEqual([1, 2]);
  });

  it("passes through unchanged on an invalid query", () => {
    const particle = makeParticle();
    const out = executeFilter(baseParams({ query: "not a valid query" }), inputs(particle), null);
    expect(out.get("out")).toBe(particle);
  });
});

describe("executeFilter — bond stream", () => {
  it("passes through unchanged when bond_query is empty", () => {
    const bond = makeBond();
    const out = executeFilter(baseParams(), inputs(bond), null);
    expect(out.get("out")).toBe(bond);
  });

  it("selects bonds within the first molecule using molecule_id", () => {
    const out = executeFilter(
      baseParams({ bond_query: "molecule_id == 0" }),
      inputs(makeBond()),
      null,
    );
    const result = out.get("out") as BondData;
    expect(result.selectedBondIndices).not.toBeNull();
    expect(Array.from(result.selectedBondIndices!)).toEqual([0, 1]);
  });

  it("selects bonds by element query", () => {
    const out = executeFilter(
      baseParams({ bond_query: 'element == "O"' }),
      inputs(makeBond()),
      null,
    );
    const result = out.get("out") as BondData;
    expect(Array.from(result.selectedBondIndices!)).toEqual([0, 1, 2, 3]);
  });

  // Regression: a bond query used to replace an upstream bond selection
  // instead of narrowing it, unlike chained atom filters.
  it("intersects with a pre-existing bond selection", () => {
    const upstream = makeBond({ selectedBondIndices: new Uint32Array([0, 1]) });
    const out = executeFilter(baseParams({ bond_query: 'element == "O"' }), inputs(upstream), null);
    expect(Array.from((out.get("out") as BondData).selectedBondIndices!)).toEqual([0, 1]);

    const disjoint = executeFilter(
      baseParams({ bond_query: "molecule_id == 1" }),
      inputs(upstream),
      null,
    );
    expect(Array.from((disjoint.get("out") as BondData).selectedBondIndices!)).toEqual([]);
  });

  it("passes through unchanged on an invalid bond_query", () => {
    const bond = makeBond();
    const out = executeFilter(baseParams({ bond_query: "not a valid query" }), inputs(bond), null);
    expect(out.get("out")).toBe(bond);
  });

  it("passes through unchanged when atomElements is null", () => {
    const bond = makeBond({ atomElements: null });
    const out = executeFilter(baseParams({ bond_query: "molecule_id == 0" }), inputs(bond), null);
    expect(out.get("out")).toBe(bond);
  });
});
