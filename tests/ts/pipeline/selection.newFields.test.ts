import { describe, it, expect } from "vitest";
import {
  evaluateSelection,
  validateQuery,
  parseResid,
  labelMatchesResname,
} from "@/pipeline/selection";
import type { Snapshot } from "@/types";

/** Build a small Snapshot, including optional chain IDs, for testing. */
function makeSnapshot(opts: {
  nAtoms: number;
  positions: number[];
  elements: number[];
  bonds?: number[];
  atomChainIds?: number[];
}): Snapshot {
  return {
    nAtoms: opts.nAtoms,
    nBonds: (opts.bonds?.length ?? 0) / 2,
    nFileBonds: (opts.bonds?.length ?? 0) / 2,
    positions: new Float32Array(opts.positions),
    elements: new Uint8Array(opts.elements),
    bonds: new Uint32Array(opts.bonds ?? []),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: opts.atomChainIds ? new Uint8Array(opts.atomChainIds) : null,
    atomBFactors: null,
  };
}

describe("parseResid", () => {
  it("extracts the trailing residue number", () => {
    expect(parseResid("ALA42")).toBe(42);
    expect(parseResid("GLY1")).toBe(1);
    expect(parseResid("HIS103")).toBe(103);
  });

  it("returns NaN when the label has no trailing number", () => {
    expect(parseResid("HOH")).toBeNaN();
    expect(parseResid("")).toBeNaN();
  });

  it("reads the LAST run of digits", () => {
    // A label like a serial+resname+resid uses the final number as the resid.
    expect(parseResid("A12ALA42")).toBe(42);
  });
});

describe("selection field: chain", () => {
  // chains: A A B B (atom 4 has no chain → code 0)
  const snap = makeSnapshot({
    nAtoms: 5,
    positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0],
    elements: [6, 6, 6, 6, 6],
    atomChainIds: [65, 65, 66, 66, 0], // 'A','A','B','B', none
  });

  it("selects atoms on chain A", () => {
    expect(evaluateSelection('chain == "A"', snap, null)).toEqual(new Set([0, 1]));
  });

  it("selects atoms on chain B", () => {
    expect(evaluateSelection('chain == "B"', snap, null)).toEqual(new Set([2, 3]));
  });

  it("treats a missing chain code as empty string", () => {
    expect(evaluateSelection('chain == ""', snap, null)).toEqual(new Set([4]));
    expect(evaluateSelection('chain != "A"', snap, null)).toEqual(new Set([2, 3, 4]));
  });

  it("selects nothing for chain when the snapshot has no chain data", () => {
    const noChain = makeSnapshot({
      nAtoms: 2,
      positions: [0, 0, 0, 1, 0, 0],
      elements: [6, 6],
    });
    // Both atoms compare as "" (no chain info).
    expect(evaluateSelection('chain == "A"', noChain, null)).toEqual(new Set());
    expect(evaluateSelection('chain == ""', noChain, null)).toEqual(new Set([0, 1]));
  });
});

describe("selection field: resid", () => {
  const snap = makeSnapshot({
    nAtoms: 4,
    positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0],
    elements: [7, 6, 8, 6],
  });
  const labels = ["ALA1", "ALA1", "GLY2", "GLY2"];

  it("selects atoms by residue number", () => {
    expect(evaluateSelection("resid == 1", snap, labels)).toEqual(new Set([0, 1]));
    expect(evaluateSelection("resid == 2", snap, labels)).toEqual(new Set([2, 3]));
  });

  it("supports numeric ranges on resid", () => {
    expect(evaluateSelection("resid >= 2", snap, labels)).toEqual(new Set([2, 3]));
  });

  it("matches nothing when labels are absent (resid → NaN)", () => {
    expect(evaluateSelection("resid == 1", snap, null)).toEqual(new Set());
  });
});

describe("selection: within R of (...)", () => {
  // A line of atoms 2 Å apart along x: indices 0..4 at x = 0,2,4,6,8
  const line = makeSnapshot({
    nAtoms: 5,
    positions: [0, 0, 0, 2, 0, 0, 4, 0, 0, 6, 0, 0, 8, 0, 0],
    elements: [8, 6, 6, 6, 6], // O at index 0, rest C
  });

  it("includes the seed atoms themselves (distance 0)", () => {
    // within 1 of the O keeps just the O.
    expect(evaluateSelection('within 1 of (element == "O")', line, null)).toEqual(new Set([0]));
  });

  it("captures neighbors inside the radius", () => {
    // within 2 of the O reaches index 1 (2 Å away) but not index 2 (4 Å).
    expect(evaluateSelection('within 2 of (element == "O")', line, null)).toEqual(new Set([0, 1]));
  });

  it("captures a wider shell for a larger radius", () => {
    // within 4 of the O reaches indices 1 (2Å) and 2 (4Å).
    expect(evaluateSelection('within 4 of (element == "O")', line, null)).toEqual(
      new Set([0, 1, 2]),
    );
  });

  it("selects nothing when the inner selection is empty", () => {
    expect(evaluateSelection('within 5 of (element == "Xe")', line, null)).toEqual(new Set());
  });

  it("composes with boolean operators", () => {
    // Carbons within 2 Å of the oxygen: only index 1.
    expect(
      evaluateSelection('element == "C" and within 2 of (element == "O")', line, null),
    ).toEqual(new Set([1]));
    // Everything NOT within 2 Å of the oxygen.
    expect(evaluateSelection('not within 2 of (element == "O")', line, null)).toEqual(
      new Set([2, 3, 4]),
    );
  });

  it("accepts an unparenthesized inner comparison", () => {
    expect(evaluateSelection('within 2 of element == "O"', line, null)).toEqual(new Set([0, 1]));
  });
});

describe("validateQuery: new fields and within", () => {
  it("accepts chain / resid comparisons", () => {
    expect(validateQuery('chain == "A"').valid).toBe(true);
    expect(validateQuery("resid >= 10").valid).toBe(true);
  });

  it("accepts within expressions", () => {
    expect(validateQuery('within 5 of (resname == "HOH")').valid).toBe(true);
  });

  it("rejects within without a radius or 'of'", () => {
    expect(validateQuery('within of (element == "O")').valid).toBe(false);
    expect(validateQuery('within 5 (element == "O")').valid).toBe(false);
  });
});

describe("labelMatchesResname", () => {
  it("keeps exact leading-letter matching for alphabetic names", () => {
    expect(labelMatchesResname("ALA42", "ALA")).toBe(true);
    expect(labelMatchesResname("HOH", "HOH")).toBe(true);
    expect(labelMatchesResname("ALA42", "AL")).toBe(false);
    // "NA12" is sodium 12 — an alphabetic query never reaches the prefix rule.
    expect(labelMatchesResname("NA12", "NA")).toBe(true);
  });

  it("matches a name containing a digit as a prefix followed by the residue number", () => {
    expect(labelMatchesResname("MK1902", "MK1")).toBe(true);
    expect(labelMatchesResname("1PE101", "1PE")).toBe(true);
    expect(labelMatchesResname("MK1-3", "MK1")).toBe(true);
  });

  it("rejects a digit-bearing name that is not followed by a residue number", () => {
    expect(labelMatchesResname("MK1", "MK1")).toBe(false);
    expect(labelMatchesResname("MK1A2", "MK1")).toBe(false);
    expect(labelMatchesResname("XK2902", "MK1")).toBe(false);
  });
});

describe("resname comparisons on names that contain a digit", () => {
  // Indinavir (MK1 902) between an alanine and a water, as 1HSG labels them.
  const snap = makeSnapshot({
    nAtoms: 3,
    positions: [0, 0, 0, 1, 0, 0, 2, 0, 0],
    elements: [6, 6, 8],
  });
  const labels = ["ALA1", "MK1902", "HOH301"];

  it('selects the drug with resname == "MK1"', () => {
    expect(evaluateSelection('resname == "MK1"', snap, labels)).toEqual(new Set([1]));
  });

  it('excludes it with resname != "MK1"', () => {
    expect(evaluateSelection('resname != "MK1"', snap, labels)).toEqual(new Set([0, 2]));
  });

  it("works inside within", () => {
    expect(evaluateSelection('within 1.5 of (resname == "MK1")', snap, labels)).toEqual(
      new Set([0, 1, 2]),
    );
  });

  it("treats an atom with no label as an empty residue name", () => {
    expect(evaluateSelection('resname == ""', snap, null)).toEqual(new Set([0, 1, 2]));
    expect(evaluateSelection('resname != "MK1"', snap, null)).toEqual(new Set([0, 1, 2]));
  });
});
