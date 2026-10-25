import { describe, it, expect } from "vitest";
import { inferBondsVdwJS, DEFAULT_VDW_BOND_FACTOR, maxDenseCells } from "@/parsers/inferBondsJS";

describe("inferBondsVdwJS", () => {
  it("returns empty array for 0 atoms", () => {
    const result = inferBondsVdwJS(new Float32Array(0), new Uint8Array(0), 0);
    expect(result.length).toBe(0);
  });

  it("returns empty array for 1 atom", () => {
    const positions = new Float32Array([0, 0, 0]);
    const elements = new Uint8Array([6]); // carbon
    const result = inferBondsVdwJS(positions, elements, 1);
    expect(result.length).toBe(0);
  });

  it("finds O-H bonds in a water molecule", () => {
    // Water: O at origin, H1 at ~0.96 Å, H2 at ~0.96 Å
    const angle = (104.5 / 2) * (Math.PI / 180);
    const oh = 0.96;
    const positions = new Float32Array([
      0,
      0,
      0, // O
      oh * Math.sin(angle),
      oh * Math.cos(angle),
      0, // H1
      -oh * Math.sin(angle),
      oh * Math.cos(angle),
      0, // H2
    ]);
    const elements = new Uint8Array([8, 1, 1]); // O, H, H

    const bonds = inferBondsVdwJS(positions, elements, 3);

    // Should find at least 2 bonds (O-H1, O-H2)
    expect(bonds.length).toBeGreaterThanOrEqual(4); // 2 bonds × 2 indices each

    // Verify bond pairs exist (order: smaller index first)
    const bondPairs: [number, number][] = [];
    for (let i = 0; i < bonds.length; i += 2) {
      bondPairs.push([bonds[i], bonds[i + 1]]);
    }

    expect(bondPairs).toContainEqual([0, 1]); // O-H1
    expect(bondPairs).toContainEqual([0, 2]); // O-H2
  });

  it("does not bond atoms that are too far apart", () => {
    // Two carbons 10 Å apart — well beyond VDW threshold
    const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2);
    expect(bonds.length).toBe(0);
  });

  it("does not bond atoms closer than MIN_BOND_DIST", () => {
    // Two atoms at 0.3 Å — below MIN_BOND_DIST (0.4)
    const positions = new Float32Array([0, 0, 0, 0.3, 0, 0]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2);
    expect(bonds.length).toBe(0);
  });

  it("handles multiple water molecules", () => {
    // 3 water molecules well separated
    const spacing = 5.0;
    const angle = (104.5 / 2) * (Math.PI / 180);
    const oh = 0.96;

    const positions = new Float32Array([
      // Molecule 1
      0,
      0,
      0,
      oh * Math.sin(angle),
      oh * Math.cos(angle),
      0,
      -oh * Math.sin(angle),
      oh * Math.cos(angle),
      0,
      // Molecule 2
      spacing,
      0,
      0,
      spacing + oh * Math.sin(angle),
      oh * Math.cos(angle),
      0,
      spacing - oh * Math.sin(angle),
      oh * Math.cos(angle),
      0,
      // Molecule 3
      0,
      spacing,
      0,
      oh * Math.sin(angle),
      spacing + oh * Math.cos(angle),
      0,
      -oh * Math.sin(angle),
      spacing + oh * Math.cos(angle),
      0,
    ]);
    const elements = new Uint8Array([8, 1, 1, 8, 1, 1, 8, 1, 1]);

    const bonds = inferBondsVdwJS(positions, elements, 9);

    // Each water should have 2 O-H bonds = 6 total
    expect(bonds.length / 2).toBe(6);
  });

  it("exposes a default VDW factor of 0.6", () => {
    expect(DEFAULT_VDW_BOND_FACTOR).toBe(0.6);
  });

  it("tightening the threshold removes borderline bonds", () => {
    // Two carbons at 1.9 Å: bonded at the default 0.6 ((1.7+1.7)*0.6 = 2.04),
    // but not at a tighter 0.5 scale ((1.7+1.7)*0.5 = 1.7).
    const positions = new Float32Array([0, 0, 0, 1.9, 0, 0]);
    const elements = new Uint8Array([6, 6]);

    expect(inferBondsVdwJS(positions, elements, 2, 0.6).length).toBe(2);
    expect(inferBondsVdwJS(positions, elements, 2, 0.5).length).toBe(0);
  });

  it("loosening the threshold adds bonds beyond the default range", () => {
    // Two carbons at 2.3 Å: not bonded at 0.6 (threshold 2.04) but bonded at
    // a looser 0.8 scale ((1.7+1.7)*0.8 = 2.72).
    const positions = new Float32Array([0, 0, 0, 2.3, 0, 0]);
    const elements = new Uint8Array([6, 6]);

    expect(inferBondsVdwJS(positions, elements, 2, 0.6).length).toBe(0);
    expect(inferBondsVdwJS(positions, elements, 2, 0.8).length).toBe(2);
  });

  it("bonds carbon atoms at covalent-like distance", () => {
    // Two carbons at 1.5 Å — within VDW threshold (1.7+1.7)*0.6 = 2.04
    const positions = new Float32Array([0, 0, 0, 1.5, 0, 0]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2);
    expect(bonds.length).toBe(2); // 1 bond pair
    expect(bonds[0]).toBe(0);
    expect(bonds[1]).toBe(1);
  });
});

/** Collect bonds as an unordered set of "a-b" keys (a < b). */
function bondSet(bonds: Uint32Array): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < bonds.length; i += 2) {
    const a = bonds[i];
    const b = bonds[i + 1];
    set.add(a < b ? `${a}-${b}` : `${b}-${a}`);
  }
  return set;
}

describe("inferBondsVdwJS — periodic boundary conditions (Issue #558)", () => {
  // Orthorhombic 10 Å cube. min(|a|,|b|,|c|)/CELL_SIZE = 5 cells per axis,
  // so all axes have ≥ 2 cells and the cell-list (non-brute-force) path runs.
  const box10 = new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]);

  it("detects a covalent bond that crosses a cell face (cell-list path)", () => {
    // Two carbons 1.0 Å apart straddling the x = 1 face: one at fractional 0.95
    // (x = 9.5), its partner at fractional 1.05 (x = 10.5, i.e. outside the home
    // cell — exactly what crystal symmetry expansion produces). Before the fix
    // the neighbor-cell shift disagreed with the unwrapped coordinate and the
    // bond was computed ~1 box too long, so no bond was emitted.
    const positions = new Float32Array([
      9.5,
      5,
      5, // C0  frac 0.95
      10.5,
      5,
      5, // C1  frac 1.05
    ]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2, DEFAULT_VDW_BOND_FACTOR, box10);
    expect(bondSet(bonds)).toEqual(new Set(["0-1"]));
  });

  it("keeps a whole molecule bonded when its image straddles a face", () => {
    // Linear C3 chain (1.4 Å spacing) whose middle/last atoms poke past x = 1.
    // Expect the same two bonds as the identical chain placed wholly inside the
    // cell.
    const elements = new Uint8Array([6, 6, 6]);
    const straddling = new Float32Array([
      9.0,
      5,
      5, // frac 0.90
      10.4,
      5,
      5, // frac 1.04
      11.8,
      5,
      5, // frac 1.18
    ]);
    const inside = new Float32Array([4.0, 5, 5, 5.4, 5, 5, 6.8, 5, 5]);

    const straddleBonds = bondSet(
      inferBondsVdwJS(straddling, elements, 3, DEFAULT_VDW_BOND_FACTOR, box10),
    );
    const insideBonds = bondSet(
      inferBondsVdwJS(inside, elements, 3, DEFAULT_VDW_BOND_FACTOR, box10),
    );

    expect(straddleBonds).toEqual(new Set(["0-1", "1-2"]));
    expect(straddleBonds).toEqual(insideBonds);
  });

  it("bonds two atoms sitting near opposite faces via minimum image", () => {
    // Carbons at fractional 0.05 (x = 0.5) and 0.90 (x = 9.0): direct span 8.5 Å,
    // but the minimum-image distance across the x face is 1.5 Å < 2.04 Å.
    const positions = new Float32Array([0.5, 5, 5, 9.0, 5, 5]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2, DEFAULT_VDW_BOND_FACTOR, box10);
    expect(bondSet(bonds)).toEqual(new Set(["0-1"]));
  });

  it("does not create spurious bonds across a face when atoms are far", () => {
    // Minimum-image separation is 2.5 Å (10 − 7.5), beyond the 2.04 Å threshold.
    const positions = new Float32Array([
      0.5,
      5,
      5, // frac 0.05
      8.0,
      5,
      5, // frac 0.80
    ]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2, DEFAULT_VDW_BOND_FACTOR, box10);
    expect(bonds.length).toBe(0);
  });

  it("detects a face-crossing bond in a tiny box (brute-force branch)", () => {
    // 3 Å cube → floor(3/2) = 1 cell per axis (< 2), exercising the per-pair
    // minimum-image fallback rather than the cell-list path.
    const box3 = new Float32Array([3, 0, 0, 0, 3, 0, 0, 0, 3]);
    const positions = new Float32Array([
      2.7,
      1.5,
      1.5, // frac 0.90
      3.3,
      1.5,
      1.5, // frac 1.10 (0.6 Å away across the face)
    ]);
    const elements = new Uint8Array([6, 6]);

    const bonds = inferBondsVdwJS(positions, elements, 2, DEFAULT_VDW_BOND_FACTOR, box3);
    expect(bondSet(bonds)).toEqual(new Set(["0-1"]));
  });

  it("is idempotent for a molecule already inside the cell", () => {
    // A water molecule wholly inside a 20 Å box yields the same bonds with or
    // without the periodic box — the fix must not regress the common case.
    const angle = (104.5 / 2) * (Math.PI / 180);
    const oh = 0.96;
    const cx = 10;
    const positions = new Float32Array([
      cx,
      10,
      10,
      cx + oh * Math.sin(angle),
      10 + oh * Math.cos(angle),
      10,
      cx - oh * Math.sin(angle),
      10 + oh * Math.cos(angle),
      10,
    ]);
    const elements = new Uint8Array([8, 1, 1]);
    const box20 = new Float32Array([20, 0, 0, 0, 20, 0, 0, 0, 20]);

    const withBox = bondSet(
      inferBondsVdwJS(positions, elements, 3, DEFAULT_VDW_BOND_FACTOR, box20),
    );
    const withoutBox = bondSet(inferBondsVdwJS(positions, elements, 3));

    expect(withBox).toEqual(new Set(["0-1", "0-2"]));
    expect(withBox).toEqual(withoutBox);
  });
});

describe("inferBondsVdwJS — grid size stays bounded", () => {
  /** Jittered cubic carbon lattice 1.5 Å apart, deterministic. */
  function lattice(nSide: number): Float32Array {
    const out = new Float32Array(nSide * nSide * nSide * 3);
    let seed = 12345;
    const jitter = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (((seed >>> 16) % 1000) / 1000) * 0.2 - 0.1;
    };
    let k = 0;
    for (let x = 0; x < nSide; x++)
      for (let y = 0; y < nSide; y++)
        for (let z = 0; z < nSide; z++) {
          out[k++] = x * 1.5 + jitter();
          out[k++] = y * 1.5 + jitter();
          out[k++] = z * 1.5 + jitter();
        }
    return out;
  }

  it("bounds the dense grid by the atom count", () => {
    expect(maxDenseCells(0)).toBe(4096);
    expect(maxDenseCells(1000)).toBe(12096);
  });

  it("finds the same bonds, in the same order, with one far-away atom", () => {
    // 9999 Å on every axis would be ~1.25e11 dense cells.
    const base = lattice(8);
    const n = base.length / 3;
    const expected = inferBondsVdwJS(base, new Uint8Array(n).fill(6), n);
    expect(expected.length).toBeGreaterThan(n * 2);

    const withOutlier = new Float32Array(base.length + 3);
    withOutlier.set(base);
    withOutlier.set([9999, 9999, 9999], base.length);
    const elements = new Uint8Array(n + 1).fill(6);
    const got = inferBondsVdwJS(withOutlier, elements, n + 1);
    expect(Array.from(got)).toEqual(Array.from(expected));
  });

  it("still bonds atoms that share a far-away cell", () => {
    const positions = new Float32Array([0, 0, 0, 5000, 0, 0, 5001.2, 0, 0, 1e30, -1e30, 1e30]);
    const bonds = inferBondsVdwJS(positions, new Uint8Array([6, 6, 6, 6]), 4);
    expect(Array.from(bonds)).toEqual([1, 2]);
  });

  it("coarsens the cells of a huge, mostly empty periodic box", () => {
    // 4000 Å cube → 2000³ cells at 2 Å; the water must still bond across a face.
    const L = 4000;
    const box = new Float32Array([L, 0, 0, 0, L, 0, 0, 0, L]);
    const positions = new Float32Array([0.1, 0, 0, L - 0.8, 0, 0, 1.0, 0, 0]);
    const bonds = inferBondsVdwJS(positions, new Uint8Array([8, 1, 1]), 3, undefined, box);
    const pairs = new Set<string>();
    for (let i = 0; i < bonds.length; i += 2) pairs.add(`${bonds[i]}-${bonds[i + 1]}`);
    expect(pairs).toEqual(new Set(["0-1", "0-2"]));
  });
});
