import { describe, it, expect } from "vitest";
import { executeFilter } from "@/pipeline/executors/filter";
import { executeAddBond } from "@/pipeline/executors/addBond";
import { evaluateSelection } from "@/pipeline/selection";

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

// Regression: a bond query used to read ghost / image endpoints (index >=
// nAtoms) against the structure's own elements, so a boundary-crossing O–H
// drawn as two half-bonds had an element-0 endpoint and `element == "H"`
// picked only the H half. Both halves now stand for the same O–H bond.
describe("executeFilter — bond queries on PBC half-bonds", () => {
  // O0–H1 is an ordinary bond; O0–H2 crosses the 4 Å cell, drawn as
  // (O0 → ghost H2 = 3) and (H2 → ghost O0 = 4).
  function pbcBond(): BondData {
    const snapshot: Snapshot = {
      nAtoms: 3,
      nBonds: 2,
      nFileBonds: 2,
      positions: new Float32Array([0.5, 2, 2, 1.4, 2, 2, 3.6, 2, 2]),
      elements: new Uint8Array([8, 1, 1]),
      bonds: new Uint32Array([0, 1, 0, 2]),
      bondOrders: null,
      box: new Float32Array([4, 0, 0, 0, 4, 0, 0, 0, 4]),
      boxOrigin: null,
      atomChainIds: null,
      atomBFactors: null,
    };
    const particle = makeParticle({ source: snapshot });
    const bond = executeAddBond(
      { type: "add_bond", bondSource: "structure" },
      new Map<string, PipelineData[]>([["particle", [particle]]]),
    ).get("bond") as BondData;
    expect(Array.from(bond.bondIndices)).toEqual([0, 1, 0, 3, 2, 4]);
    return bond;
  }

  function selected(query: string): number[] {
    const out = executeFilter(baseParams({ bond_query: query }), inputs(pbcBond()), null);
    return Array.from((out.get("out") as BondData).selectedBondIndices!);
  }

  it("reads a ghost endpoint's element from its source atom", () => {
    expect(selected('element == "H"')).toEqual([0, 1, 2]);
    expect(selected('both element == "H"')).toEqual([]);
    expect(selected('element == "X"')).toEqual([]);
  });

  it("reads a ghost endpoint's atom_index as its source atom", () => {
    // Both halves of O0–H2 name atom 2; the plain O0–H1 bond does not.
    expect(selected("atom_index == 2")).toEqual([1, 2]);
    expect(selected("both atom_index <= 2")).toEqual([0, 1, 2]);
  });

  it("keeps the source mapping inside and / or / not", () => {
    expect(selected('element == "H" and not atom_index == 1')).toEqual([1, 2]);
    expect(selected("atom_index == 1 or atom_index == 2")).toEqual([0, 1, 2]);
  });
});

// Regression: a bond query's molecule_id used to be computed on the drawn
// bond graph, where a bond crossing the periodic boundary is two half-bonds
// to ghost atoms. The molecule it crossed in split in two, and the numbering
// no longer matched the atom query's molecule_id.
describe("executeFilter — bond molecule_id on a periodic cell", () => {
  // Water A (O0, H1, H2) has O0–H2 crossing the 4 Å cell; water B (O3, H4,
  // H5) lies inside it. Drawn bonds: 0 = O0–H1, 1 = O0→ghost H2,
  // 2 = H2→ghost O0, 3 = O3–H4, 4 = O3–H5.
  const snapshot: Snapshot = {
    nAtoms: 6,
    nBonds: 4,
    nFileBonds: 4,
    positions: new Float32Array([
      0.5, 1, 1, 1.4, 1, 1, 3.6, 1, 1, 1.5, 3, 3, 2.4, 3, 3, 1.5, 3.9, 3,
    ]),
    elements: new Uint8Array([8, 1, 1, 8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]),
    bondOrders: null,
    box: new Float32Array([4, 0, 0, 0, 4, 0, 0, 0, 4]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };

  function selected(query: string): number[] {
    const bond = executeAddBond(
      { type: "add_bond", bondSource: "structure" },
      new Map<string, PipelineData[]>([["particle", [makeParticle({ source: snapshot })]]]),
    ).get("bond") as BondData;
    expect(Array.from(bond.bondIndices)).toEqual([0, 1, 0, 6, 2, 7, 3, 4, 3, 5]);
    const out = executeFilter(baseParams({ bond_query: query }), inputs(bond), null);
    return Array.from((out.get("out") as BondData).selectedBondIndices!);
  }

  it("keeps both halves of a crossing bond in their molecule", () => {
    expect(selected("molecule_id == 0")).toEqual([0, 1, 2]);
  });

  it("numbers molecules like the atom query", () => {
    expect([...evaluateSelection("molecule_id == 1", snapshot, null)!]).toEqual([3, 4, 5]);
    expect(selected("molecule_id == 1")).toEqual([3, 4]);
    expect(selected("molecule_id == 2")).toEqual([]);
  });
});
