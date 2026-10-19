/** The Polymer chain block's SMILES chemistry: repeat units, chains, residue labels. */

import { describe, it, expect } from "vitest";
import {
  MAX_POLYMER_UNITS,
  POLYMER_PRESETS,
  chainSmiles,
  parseRepeatUnit,
  polymerLabels,
  residueName,
} from "@/builder/flow/polymer";

describe("parseRepeatUnit", () => {
  it("reads the unit between the two * and counts its heavy atoms", () => {
    expect(parseRepeatUnit("*CC*")).toEqual({ body: "CC", heavyAtoms: 2 });
    expect(parseRepeatUnit("*CC(c1ccccc1)*")).toEqual({ body: "CC(c1ccccc1)", heavyAtoms: 8 });
    expect(parseRepeatUnit("*CC(Cl)*").heavyAtoms).toBe(3);
    expect(parseRepeatUnit("*CC([NH3+])*").heavyAtoms).toBe(3);
  });

  it("accepts bracketed and mapped attachment points, spaces and explicit single bonds", () => {
    expect(parseRepeatUnit(" [*]CC[*:2] ").body).toBe("CC");
    expect(parseRepeatUnit("*-CCO-*").body).toBe("CCO");
  });

  it("refuses what cannot be chained by concatenation", () => {
    expect(() => parseRepeatUnit("  ")).toThrow(/Enter the repeat unit/);
    expect(() => parseRepeatUnit("CC")).toThrow(/one \* at the start/);
    expect(() => parseRepeatUnit("*CC")).toThrow(/one \* at the start/);
    expect(() => parseRepeatUnit("*C*C*")).toThrow(/one \* at the start/);
    expect(() => parseRepeatUnit("*=CC=*")).toThrow(/Only single bonds/);
    expect(() => parseRepeatUnit("*CC(C*")).toThrow(/main chain/);
    expect(() => parseRepeatUnit("*CC)C(*")).toThrow(/main chain/);
    expect(() => parseRepeatUnit("*C1CC*")).toThrow(/ring must close/);
    expect(() => parseRepeatUnit("**")).toThrow(/no atoms/);
  });
});

describe("chainSmiles", () => {
  it("repeats the unit, leaving the ends to RDKit's hydrogens", () => {
    expect(chainSmiles("*CC*", 3).smiles).toBe("CCCCCC");
    expect(chainSmiles("*CC(C)*", 2).smiles).toBe("CC(C)CC(C)");
    expect(chainSmiles("*c1ccc(cc1)*", 2).smiles).toBe("c1ccc(cc1)c1ccc(cc1)");
  });

  it("bounds the length and the size of the chain", () => {
    expect(() => chainSmiles("*CC*", 0)).toThrow(/whole number/);
    expect(() => chainSmiles("*CC*", 2.5)).toThrow(/whole number/);
    expect(() => chainSmiles("*CC*", MAX_POLYMER_UNITS + 1)).toThrow(/whole number/);
    expect(() => chainSmiles("*OCCOC(=O)c1ccc(cc1)C(=O)*", 100)).toThrow(/too long a chain/);
  });

  it("chains every preset", () => {
    for (const p of POLYMER_PRESETS) {
      expect(chainSmiles(p.repeatUnit, 5).smiles.length).toBeGreaterThan(0);
      expect(p.name.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("residueName", () => {
  it("keeps up to four letters or digits, upper case", () => {
    expect(residueName("water")).toBe("WATE");
    expect(residueName("Pt-fcc(111)")).toBe("PTFC");
    expect(residueName("--", "POL")).toBe("POL");
    expect(residueName("")).toBe("MOL");
  });
});

describe("polymerLabels", () => {
  // Ethane-like dimer of *C*: C0 C1, then three H on each carbon.
  const elements = [6, 6, 1, 1, 1, 1, 1, 1];
  const bonds = [0, 1, 0, 2, 0, 3, 0, 4, 1, 5, 1, 6, 1, 7];
  const unit = { body: "C", heavyAtoms: 1 };

  it("numbers heavy atoms by unit and gives each hydrogen its carbon's unit", () => {
    expect(polymerLabels(elements, bonds, unit, 2, "PE")).toEqual([
      "PE1",
      "PE2",
      "PE1",
      "PE1",
      "PE1",
      "PE2",
      "PE2",
      "PE2",
    ]);
  });

  it("gives up when the embedded structure is not laid out unit by unit", () => {
    expect(polymerLabels([6], [], unit, 2, "PE")).toBeNull();
    expect(polymerLabels([1, 6, 6], [], unit, 2, "PE")).toBeNull();
    expect(polymerLabels([6, 6, 1], [], unit, 2, "PE")).toBeNull();
  });
});
