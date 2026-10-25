import { describe, it, expect } from "vitest";
import {
  evaluateSelection,
  evaluateBondSelection,
  validateQuery,
  computeMoleculeIds,
} from "@/pipeline/selection";
import type { Snapshot } from "@/types";

/** Helper to build a small Snapshot for testing. */
function makeSnapshot(opts: {
  nAtoms: number;
  positions: number[];
  elements: number[];
  bonds?: number[];
  bondOrders?: number[];
  box?: number[];
}): Snapshot {
  return {
    nAtoms: opts.nAtoms,
    nBonds: (opts.bonds?.length ?? 0) / 2,
    nFileBonds: (opts.bonds?.length ?? 0) / 2,
    positions: new Float32Array(opts.positions),
    elements: new Uint8Array(opts.elements),
    bonds: new Uint32Array(opts.bonds ?? []),
    bondOrders: opts.bondOrders ? new Uint8Array(opts.bondOrders) : null,
    box: opts.box ? new Float32Array(opts.box) : null,
  };
}

// A small system: C(0), N(1), O(2), H(3), H(4)
// Positions: each at (index, 0, 0) for easy coordinate testing
const testSnapshot = makeSnapshot({
  nAtoms: 5,
  positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0],
  elements: [6, 7, 8, 1, 1], // C, N, O, H, H
});

const testLabels = ["ALA1", "ALA1", "GLY2", "GLY2", "GLY2"];

// Two water molecules plus one isolated Na ion (no bonds), 7 atoms total.
// Layout: 0=O,1=H,2=H (mol A); 3=O,4=H,5=H (mol B); 6=Na (isolated)
const moleculeSnapshot = makeSnapshot({
  nAtoms: 7,
  positions: [0, 0, 0, 1, 0, 0, -1, 0, 0, 5, 0, 0, 6, 0, 0, 4, 0, 0, 10, 0, 0],
  elements: [8, 1, 1, 8, 1, 1, 11], // O, H, H, O, H, H, Na
  bonds: [0, 1, 0, 2, 3, 4, 3, 5],
});

describe("evaluateSelection", () => {
  it("returns null for empty query", () => {
    expect(evaluateSelection("", testSnapshot, null)).toBeNull();
  });

  it("returns null for 'all'", () => {
    expect(evaluateSelection("all", testSnapshot, null)).toBeNull();
  });

  it("returns empty set for 'none'", () => {
    const result = evaluateSelection("none", testSnapshot, null);
    expect(result).toBeInstanceOf(Set);
    expect(result!.size).toBe(0);
  });

  it("filters by element == 'C'", () => {
    const result = evaluateSelection('element == "C"', testSnapshot, null);
    expect(result).toEqual(new Set([0]));
  });

  it("filters by element != 'H'", () => {
    const result = evaluateSelection('element != "H"', testSnapshot, null);
    expect(result).toEqual(new Set([0, 1, 2]));
  });

  it("filters by index > 2", () => {
    const result = evaluateSelection("index > 2", testSnapshot, null);
    expect(result).toEqual(new Set([3, 4]));
  });

  it("filters by index <= 1", () => {
    const result = evaluateSelection("index <= 1", testSnapshot, null);
    expect(result).toEqual(new Set([0, 1]));
  });

  it("filters by x coordinate", () => {
    const result = evaluateSelection("x >= 3", testSnapshot, null);
    expect(result).toEqual(new Set([3, 4]));
  });

  it("filters by mass > 14 (oxygen=16, nitrogen=14.007)", () => {
    const result = evaluateSelection("mass > 14.5", testSnapshot, null);
    expect(result).toEqual(new Set([2])); // only oxygen (mass 15.999)
  });

  it("filters elements past uranium by symbol and mass", () => {
    // U, Np, Pu, Og: the parsers resolve all of them, so queries must too.
    const heavy = makeSnapshot({
      nAtoms: 4,
      positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0],
      elements: [92, 93, 94, 118],
    });
    expect(evaluateSelection('element == "Np"', heavy, null)).toEqual(new Set([1]));
    expect(evaluateSelection('element == "Og"', heavy, null)).toEqual(new Set([3]));
    expect(evaluateSelection("mass > 240", heavy, null)).toEqual(new Set([2, 3]));
  });

  it("filters by resname", () => {
    const result = evaluateSelection('resname == "ALA"', testSnapshot, testLabels);
    expect(result).toEqual(new Set([0, 1]));
  });

  it("handles 'and' operator", () => {
    const result = evaluateSelection('element == "H" and index > 3', testSnapshot, null);
    expect(result).toEqual(new Set([4]));
  });

  it("handles 'or' operator", () => {
    const result = evaluateSelection('element == "C" or element == "N"', testSnapshot, null);
    expect(result).toEqual(new Set([0, 1]));
  });

  it("handles 'not' operator", () => {
    const result = evaluateSelection('not element == "H"', testSnapshot, null);
    expect(result).toEqual(new Set([0, 1, 2]));
  });

  it("handles parenthesized grouping", () => {
    const result = evaluateSelection(
      '(element == "C" or element == "N") and x < 2',
      testSnapshot,
      null,
    );
    expect(result).toEqual(new Set([0, 1]));
  });

  it("handles nested not/and/or", () => {
    const result = evaluateSelection('not (element == "H" or element == "O")', testSnapshot, null);
    expect(result).toEqual(new Set([0, 1])); // C, N
  });

  it("returns null for whitespace-only query", () => {
    expect(evaluateSelection("   ", testSnapshot, null)).toBeNull();
  });
});

describe("evaluateSelection: molecule_id field", () => {
  it("assigns molecule_id 0 to the component containing atom 0", () => {
    const result = evaluateSelection("molecule_id == 0", moleculeSnapshot, null);
    expect(result).toEqual(new Set([0, 1, 2]));
  });

  it("assigns molecule_id 1 to the second water molecule", () => {
    const result = evaluateSelection("molecule_id == 1", moleculeSnapshot, null);
    expect(result).toEqual(new Set([3, 4, 5]));
  });

  it("gives an isolated atom its own molecule_id", () => {
    const result = evaluateSelection("molecule_id == 2", moleculeSnapshot, null);
    expect(result).toEqual(new Set([6]));
  });

  it("supports 'not' on molecule_id", () => {
    const result = evaluateSelection("not molecule_id == 0", moleculeSnapshot, null);
    expect(result).toEqual(new Set([3, 4, 5, 6]));
  });

  it("supports 'or' across molecule_id values", () => {
    const result = evaluateSelection(
      "molecule_id == 0 or molecule_id == 2",
      moleculeSnapshot,
      null,
    );
    expect(result).toEqual(new Set([0, 1, 2, 6]));
  });

  it("treats every atom as its own molecule when there are no bonds", () => {
    const result = evaluateSelection("molecule_id == 3", testSnapshot, null);
    expect(result).toEqual(new Set([3]));
  });
});

describe("computeMoleculeIds", () => {
  it("numbers components by smallest contained atom index", () => {
    const ids = computeMoleculeIds(moleculeSnapshot.bonds, moleculeSnapshot.nAtoms);
    expect([...ids]).toEqual([0, 0, 0, 1, 1, 1, 2]);
  });

  it("assigns a unique molecule id per atom when there are no bonds", () => {
    const ids = computeMoleculeIds(testSnapshot.bonds, testSnapshot.nAtoms);
    expect([...ids]).toEqual([0, 1, 2, 3, 4]);
  });

  it("memoizes results per bond-array identity", () => {
    const bonds = new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]);
    const a = computeMoleculeIds(bonds, 7);
    const b = computeMoleculeIds(bonds, 7);
    expect(a).toBe(b); // same instance: cache hit

    const bondsCopy = new Uint32Array(bonds); // same content, different identity
    const c = computeMoleculeIds(bondsCopy, 7);
    expect(c).not.toBe(a);
    expect([...c]).toEqual([...a]);
  });
});

describe("validateQuery", () => {
  it("returns valid for empty query", () => {
    expect(validateQuery("")).toEqual({ valid: true });
  });

  it("returns valid for 'all'", () => {
    expect(validateQuery("all")).toEqual({ valid: true });
  });

  it("returns valid for 'none'", () => {
    expect(validateQuery("none")).toEqual({ valid: true });
  });

  it("returns valid for well-formed query", () => {
    expect(validateQuery('element == "C" and index > 5')).toEqual({ valid: true });
  });

  it("returns invalid for unknown identifier", () => {
    const result = validateQuery("foo == 1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unknown identifier");
  });

  it("returns invalid for unterminated string", () => {
    const result = validateQuery('element == "C');
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unterminated string");
  });

  it("returns invalid for missing value", () => {
    const result = validateQuery("element ==");
    expect(result.valid).toBe(false);
  });

  it("returns invalid for unexpected character", () => {
    const result = validateQuery("element == @");
    expect(result.valid).toBe(false);
  });

  it("returns valid for molecule_id query", () => {
    expect(validateQuery("molecule_id == 0")).toEqual({ valid: true });
  });
});

// Bond connectivity for moleculeSnapshot: bonds 0,1 -> mol A; bonds 2,3 -> mol B
const bondIndices = new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]);
const bondElements = new Uint8Array([8, 1, 1, 8, 1, 1, 11]); // O,H,H,O,H,H,Na

describe("evaluateBondSelection: molecule_id field", () => {
  it("selects bonds within the first molecule", () => {
    const result = evaluateBondSelection("molecule_id == 0", bondIndices, bondElements, 4, 7);
    expect(result).toEqual(new Set([0, 1]));
  });

  it("selects bonds within the second molecule", () => {
    const result = evaluateBondSelection("molecule_id == 1", bondIndices, bondElements, 4, 7);
    expect(result).toEqual(new Set([2, 3]));
  });

  it("treats 'both molecule_id == N' the same as without 'both'", () => {
    const withBoth = evaluateBondSelection(
      "both molecule_id == 0",
      bondIndices,
      bondElements,
      4,
      7,
    );
    const withoutBoth = evaluateBondSelection("molecule_id == 0", bondIndices, bondElements, 4, 7);
    expect(withBoth).toEqual(withoutBoth);
  });

  it("falls back to deriving atom count from bondIndices when nAtoms is omitted", () => {
    const result = evaluateBondSelection("molecule_id == 0", bondIndices, bondElements, 4);
    expect(result).toEqual(new Set([0, 1]));
  });

  it("uses the structural topology when the drawn bonds have ghost endpoints", () => {
    // Structure: O0–H1, O0–H2 (mol 0), O3–H4 (mol 1); 5 structural atoms.
    const structural = new Uint32Array([0, 1, 0, 2, 3, 4]);
    const elements = new Uint8Array([8, 1, 1, 8, 1]);
    // Drawn: O0–H1, O0→ghost5, ghost6→H2 (ghost first), O3–H4, and a bond
    // between two ghosts (7, 8) that has no structural endpoint.
    const drawn = new Uint32Array([0, 1, 0, 5, 6, 2, 3, 4, 7, 8]);
    const query = (q: string) => evaluateBondSelection(q, drawn, elements, 5, 9, structural);
    expect(query("molecule_id == 0")).toEqual(new Set([0, 1, 2]));
    expect(query("molecule_id == 1")).toEqual(new Set([3]));
    // A bond with no structural endpoint belongs to no molecule.
    expect(query("molecule_id < 0")).toEqual(new Set([4]));
    // The topology reaches comparisons nested in not / and / or.
    expect(query("not molecule_id == 0")).toEqual(new Set([3, 4]));
    expect(query("molecule_id == 0 and bond_index > 0")).toEqual(new Set([1, 2]));
    expect(query("molecule_id == 1 or molecule_id < 0")).toEqual(new Set([3, 4]));
  });
});
