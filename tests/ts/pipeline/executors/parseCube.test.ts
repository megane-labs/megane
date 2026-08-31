import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCube, BOHR_TO_ANGSTROM } from "@/pipeline/executors/parseCube";

/** Minimal valid CUBE file with a 2×2×2 grid and one atom. */
function makeCube(nx = 2, ny = 2, nz = 2, nAtoms = 1, dataValues?: number[]): string {
  const lines: string[] = [
    "Comment line 1",
    "Comment line 2",
    // natoms origin (all in Bohr)
    `${nAtoms}  0.000000  0.000000  0.000000`,
    // Grid axes (1 Bohr step each)
    `${nx}  1.000000  0.000000  0.000000`,
    `${ny}  0.000000  1.000000  0.000000`,
    `${nz}  0.000000  0.000000  1.000000`,
  ];
  // Atom lines: Z=6 (carbon), charge=0, pos=(1,1,1) Bohr
  for (let a = 0; a < nAtoms; a++) {
    lines.push(`6  0.000000  1.000000  1.000000  1.000000`);
  }
  // Data values
  const total = nx * ny * nz;
  const vals = dataValues ?? Array.from({ length: total }, (_, i) => i * 0.1);
  // 6 per line as in the real format
  for (let i = 0; i < total; i += 6) {
    lines.push(vals.slice(i, i + 6).join("  "));
  }
  return lines.join("\n") + "\n";
}

/**
 * MO-style CUBE: negative NAtoms + DSET_IDS record, `nSets` values per grid
 * point (innermost index over data sets).
 */
function makeMoCube(nSets: number, ids: number[], perPointValues: number[][]): string {
  const lines: string[] = [
    "Comment line 1",
    "Comment line 2",
    `-1  0.000000  0.000000  0.000000`,
    `2  1.000000  0.000000  0.000000`,
    `2  0.000000  1.000000  0.000000`,
    `2  0.000000  0.000000  1.000000`,
    `6  0.000000  1.000000  1.000000  1.000000`,
    `${nSets}  ${ids.join("  ")}`,
  ];
  const flat = perPointValues.flat();
  for (let i = 0; i < flat.length; i += 6) {
    lines.push(flat.slice(i, i + 6).join("  "));
  }
  return lines.join("\n") + "\n";
}

describe("parseCube", () => {
  it("parses a minimal 2×2×2 CUBE file", () => {
    const result = parseCube(makeCube());
    expect(result.type).toBe("volumetric");
    expect(result.nx).toBe(2);
    expect(result.ny).toBe(2);
    expect(result.nz).toBe(2);
    expect(result.data.length).toBe(8);
  });

  it("converts origin from Bohr to Angstroms", () => {
    const result = parseCube(makeCube());
    // Origin is 0,0,0 in this fixture.
    expect(result.origin[0]).toBeCloseTo(0);
    expect(result.origin[1]).toBeCloseTo(0);
    expect(result.origin[2]).toBeCloseTo(0);
  });

  it("keeps ghost atoms (negative Z) as element 0 instead of a real element", () => {
    const text = makeCube().replace(
      "6  0.000000  1.000000  1.000000  1.000000",
      "-6  0.000000  1.000000  1.000000  1.000000",
    );
    const result = parseCube(text);
    expect(result.nAtoms).toBe(1);
    expect(result.elements[0]).toBe(0);
    // Coordinates of the ghost site are still read.
    expect(result.positions[0]).toBeCloseTo(BOHR_TO_ANGSTROM);
  });

  it("reads the DSET_IDS record of a negative-NAtoms cube and keeps the first data set", () => {
    // 8 grid points x 2 sets; per point the first set is i, the second 100+i.
    const perPoint = Array.from({ length: 8 }, (_, i) => [i, 100 + i]);
    const result = parseCube(makeMoCube(2, [1, 2], perPoint));
    expect(result.nAtoms).toBe(1);
    expect(Array.from(result.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.dataMax).toBe(7);
  });

  it("handles a DSET_IDS id list wrapping onto following lines", () => {
    const perPoint = Array.from({ length: 8 }, (_, i) => [i * 0.5]);
    const text = makeMoCube(
      2,
      [7],
      perPoint.map((v) => [...v, ...v]),
    ).replace("2  7", "2\n7  8");
    const result = parseCube(text);
    expect(result.data[2]).toBeCloseTo(1.0);
  });

  it("rejects a DSET_IDS record with an invalid set count", () => {
    const perPoint = Array.from({ length: 8 }, (_, i) => [i]);
    const text = makeMoCube(1, [7], perPoint).replace("1  7", "0  7");
    expect(() => parseCube(text)).toThrow(/invalid DSET_IDS count/);
  });

  it("converts step vectors from Bohr to Angstroms", () => {
    const result = parseCube(makeCube());
    // stepX = (1 Bohr, 0, 0)
    expect(result.step[0]).toBeCloseTo(BOHR_TO_ANGSTROM);
    expect(result.step[1]).toBeCloseTo(0);
    expect(result.step[2]).toBeCloseTo(0);
    // stepY = (0, 1 Bohr, 0)
    expect(result.step[3]).toBeCloseTo(0);
    expect(result.step[4]).toBeCloseTo(BOHR_TO_ANGSTROM);
    // stepZ = (0, 0, 1 Bohr)
    expect(result.step[8]).toBeCloseTo(BOHR_TO_ANGSTROM);
  });

  it("parses atom positions from Bohr to Angstroms", () => {
    const result = parseCube(makeCube(2, 2, 2, 1));
    expect(result.nAtoms).toBe(1);
    expect(result.elements[0]).toBe(6);
    // position is (1, 1, 1) Bohr → × BOHR_TO_ANGSTROM
    expect(result.positions[0]).toBeCloseTo(BOHR_TO_ANGSTROM);
    expect(result.positions[1]).toBeCloseTo(BOHR_TO_ANGSTROM);
    expect(result.positions[2]).toBeCloseTo(BOHR_TO_ANGSTROM);
  });

  it("reads volumetric data values correctly", () => {
    const vals = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const result = parseCube(makeCube(2, 2, 2, 1, vals));
    for (let i = 0; i < 8; i++) {
      expect(result.data[i]).toBeCloseTo(vals[i]);
    }
  });

  it("computes dataMin and dataMax", () => {
    const vals = [0.1, -0.5, 0.3, 0.8, -1.0, 0.2, 0.6, 0.4];
    const result = parseCube(makeCube(2, 2, 2, 1, vals));
    expect(result.dataMin).toBeCloseTo(-1.0);
    expect(result.dataMax).toBeCloseTo(0.8);
  });

  it("handles multiple atoms", () => {
    const result = parseCube(makeCube(2, 2, 2, 3));
    expect(result.nAtoms).toBe(3);
    expect(result.elements.length).toBe(3);
    expect(result.positions.length).toBe(9);
  });

  it("handles a negative atom count (MO cube files)", () => {
    // Negative natoms = MO data; abs value is the atom count, and a DSET_IDS
    // record follows the atom block.
    const lines = [
      "Comment 1",
      "Comment 2",
      "-1  0.0  0.0  0.0",
      "2  1.0  0.0  0.0",
      "2  0.0  1.0  0.0",
      "2  0.0  0.0  1.0",
      "6  0.0  1.0  1.0  1.0",
      "1  2",
      "0.1  0.2  0.3  0.4  0.5  0.6  0.7  0.8",
    ];
    const result = parseCube(lines.join("\n"));
    expect(result.nAtoms).toBe(1);
    expect(result.nx).toBe(2);
    expect(result.data[7]).toBeCloseTo(0.8);
  });

  it("throws on insufficient data values", () => {
    const lines = [
      "C1",
      "C2",
      "1  0  0  0",
      "3  1  0  0",
      "3  0  1  0",
      "3  0  0  1",
      "6  0  1  1  1",
      "0.1  0.2", // only 2 values, need 27
    ];
    expect(() => parseCube(lines.join("\n"))).toThrow(/expected 27/i);
  });

  it("throws on malformed atom count", () => {
    const lines = ["C1", "C2", "X  0  0  0", "2  1  0  0", "2  0  1  0", "2  0  0  1"];
    expect(() => parseCube(lines.join("\n"))).toThrow();
  });

  it("throws on malformed grid axis", () => {
    const lines = [
      "C1",
      "C2",
      "1  0  0  0",
      "0  1  0  0",
      "2  0  1  0",
      "2  0  0  1",
      "6  0  1  1  1",
    ];
    expect(() => parseCube(lines.join("\n"))).toThrow();
  });

  it("throws on unexpected end of file", () => {
    expect(() => parseCube("")).toThrow(/unexpected end/i);
  });

  it("handles a 3×3×3 grid correctly", () => {
    const result = parseCube(makeCube(3, 3, 3));
    expect(result.nx).toBe(3);
    expect(result.ny).toBe(3);
    expect(result.nz).toBe(3);
    expect(result.data.length).toBe(27);
  });

  describe("caffeine_esp.cube fixture", () => {
    const text = readFileSync(resolve(__dirname, "../../../fixtures/caffeine_esp.cube"), "utf8");

    it("parses the grid and caffeine's 24 atoms", () => {
      const r = parseCube(text);
      expect(r.nAtoms).toBe(24);
      expect(r.data.length).toBe(r.nx * r.ny * r.nz);
      expect(r.elements.length).toBe(24);
      // Caffeine is C8H10N4O2.
      const counts = new Map<number, number>();
      for (const z of r.elements) counts.set(z, (counts.get(z) ?? 0) + 1);
      expect(counts.get(6)).toBe(8);
      expect(counts.get(1)).toBe(10);
      expect(counts.get(7)).toBe(4);
      expect(counts.get(8)).toBe(2);
    });

    it("carries a signed potential the ESP template's iso level sits inside", () => {
      const r = parseCube(text);
      // Dual-contour rendering needs both signs present, and the "esp"
      // template draws at ±0.02 Hartree/e — outside this range it would
      // render nothing.
      expect(r.dataMin).toBeLessThan(-0.02);
      expect(r.dataMax).toBeGreaterThan(0.02);
    });

    it("places the grid around the molecule, not beside it", () => {
      const r = parseCube(text);
      // Origin below every atom, far corner above every one: the box the
      // generator pads by 3.6 A on each side.
      for (let a = 0; a < r.nAtoms; a++) {
        for (let axis = 0; axis < 3; axis++) {
          const lo = r.origin[axis];
          const n = [r.nx, r.ny, r.nz][axis];
          const hi = lo + (n - 1) * r.step[axis * 3 + axis];
          expect(r.positions[a * 3 + axis]).toBeGreaterThan(lo);
          expect(r.positions[a * 3 + axis]).toBeLessThan(hi);
        }
      }
    });
  });
});
