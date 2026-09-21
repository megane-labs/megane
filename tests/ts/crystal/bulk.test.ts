import { describe, it, expect } from "vitest";
import {
  BULK_EXAMPLES,
  BULK_STRUCTURES,
  bulkName,
  bulkSnapshot,
  bulkStructureInfo,
  elementFromSymbol,
} from "@/crystal/bulk";
import { ORACLE, bulkOf, expectSameAtoms, type OracleBulkInput } from "./oracle";

describe("bulkSnapshot vs ASE bulk()", () => {
  for (const c of ORACLE.cases.filter((c) => c.kind === "bulk")) {
    it(c.name, () => {
      const snap = bulkOf(c.input as unknown as OracleBulkInput);
      expectSameAtoms(snap, c.expected);
      expect(snap.nBonds).toBe(0);
      expect(snap.boxOrigin).toBeNull();
    });
  }
});

describe("bulkSnapshot", () => {
  it("builds every prototype from the examples list with a valid cell", () => {
    for (const ex of BULK_EXAMPLES) {
      const snap = bulkSnapshot(ex.spec);
      expect(snap.nAtoms).toBeGreaterThan(0);
      expect(snap.box).toHaveLength(9);
      expect(snap.elements.length).toBe(snap.nAtoms);
    }
  });

  it("perovskite is ABX3 with B at the body centre and X on the faces", () => {
    const snap = bulkSnapshot({ structure: "perovskite", elements: [38, 22, 8], a: 4 });
    expect(Array.from(snap.elements)).toEqual([38, 22, 8, 8, 8]);
    expect(Array.from(snap.positions.slice(3, 6))).toEqual([2, 2, 2]);
    expect(Array.from(snap.positions.slice(6, 9))).toEqual([2, 2, 0]);
  });

  it("primitive and cubic cells of the same prototype hold the expected atom counts", () => {
    expect(bulkSnapshot({ structure: "fcc", elements: [29], a: 3.6 }).nAtoms).toBe(1);
    expect(bulkSnapshot({ structure: "fcc", elements: [29], a: 3.6, cubic: true }).nAtoms).toBe(4);
    expect(bulkSnapshot({ structure: "fluorite", elements: [20, 9], a: 5.4 }).nAtoms).toBe(3);
    expect(
      bulkSnapshot({ structure: "fluorite", elements: [20, 9], a: 5.4, cubic: true }).nAtoms,
    ).toBe(12);
    // `cubic` is ignored where no conventional cell exists.
    expect(bulkSnapshot({ structure: "hcp", elements: [12], a: 3.2, cubic: true }).nAtoms).toBe(2);
  });

  it("uses the ideal c/a when none is given", () => {
    const snap = bulkSnapshot({ structure: "hcp", elements: [12], a: 3 });
    expect(snap.box![8]).toBeCloseTo(3 * Math.sqrt(8 / 3), 6);
  });

  it("rejects bad input", () => {
    expect(() => bulkSnapshot({ structure: "fcc", elements: [29], a: 0 })).toThrow(/positive/);
    expect(() => bulkSnapshot({ structure: "hcp", elements: [12], a: 3, covera: -1 })).toThrow(
      /c\/a/,
    );
    expect(() => bulkSnapshot({ structure: "rocksalt", elements: [11], a: 5 })).toThrow(
      /Species B/,
    );
    expect(() => bulkSnapshot({ structure: "fcc", elements: [200], a: 5 })).toThrow(/Species A/);
  });

  it("names documents after the species and prototype", () => {
    expect(bulkName({ structure: "rocksalt", elements: [11, 17, 99], a: 5 })).toBe("NaCl-rocksalt");
    expect(bulkName({ structure: "fcc", elements: [29], a: 3.6 })).toBe("Cu-fcc");
  });

  it("describes every structure once", () => {
    const values = BULK_STRUCTURES.map((s) => s.value);
    expect(new Set(values).size).toBe(values.length);
    expect(bulkStructureInfo("wurtzite").hexagonal).toBe(true);
    expect(bulkStructureInfo("fcc").cubic).toBe(true);
    expect(bulkStructureInfo("perovskite").species).toBe(3);
  });

  it("looks elements up by symbol, case-insensitively", () => {
    expect(elementFromSymbol("cu")).toBe(29);
    expect(elementFromSymbol(" Na ")).toBe(11);
    expect(elementFromSymbol("")).toBeNull();
    expect(elementFromSymbol("Xx")).toBeNull();
  });
});
