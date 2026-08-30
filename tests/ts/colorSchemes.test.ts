import { describe, it, expect } from "vitest";
import {
  COLOR_SCHEME_LABELS,
  computeBfactorRange,
  computeChainSerials,
  getAtomColorForScheme,
  lightenLab,
  rgbToLab,
  type ColorContext,
  type ColorScheme,
} from "@/colorSchemes";
import type { Snapshot } from "@/types";
import { getColor, ILLUSTRATIVE_CARBON_LIGHTNESS } from "@/constants";

function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    nAtoms: over.elements?.length ?? 3,
    nBonds: 0,
    nFileBonds: 0,
    positions: over.positions ?? new Float32Array(9),
    elements: over.elements ?? new Uint8Array([6, 7, 8]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    atomChainIds: over.atomChainIds ?? null,
    atomBFactors: over.atomBFactors ?? null,
  };
}

const hexOf = (c: [number, number, number]) =>
  "#" +
  c
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

describe("COLOR_SCHEME_LABELS", () => {
  it("provides a label for every scheme", () => {
    const schemes: ColorScheme[] = [
      "byElement",
      "byResidue",
      "byChain",
      "byBFactor",
      "byProperty",
      "illustrative",
    ];
    for (const s of schemes) {
      expect(COLOR_SCHEME_LABELS[s]).toBeTypeOf("string");
      expect(COLOR_SCHEME_LABELS[s].length).toBeGreaterThan(0);
    }
  });
});

describe("getAtomColorForScheme — byElement", () => {
  it("returns CPK colors keyed on the element atomic number", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6, 8]) });
    const ctx: ColorContext = { scheme: "byElement", atomLabels: null };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual(getColor(6));
    expect(getAtomColorForScheme(1, snap, ctx)).toEqual(getColor(8));
  });
});

describe("getAtomColorForScheme — byResidue", () => {
  it("uses Shapely palette keyed on the leading residue prefix in the label", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6, 6, 6]) });
    const ctx: ColorContext = {
      scheme: "byResidue",
      atomLabels: ["ALA42", "GLY1", "LYS200"],
    };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.78, 0.78, 0.78]);
    expect(getAtomColorForScheme(1, snap, ctx)).toEqual([1.0, 1.0, 1.0]);
    expect(getAtomColorForScheme(2, snap, ctx)).toEqual([0.22, 0.44, 0.85]);
  });

  it("falls back to a neutral grey for unknown residue names", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6]) });
    const ctx: ColorContext = { scheme: "byResidue", atomLabels: ["ZZZ1"] };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.65, 0.65, 0.65]);
  });

  it("treats a missing atomLabels array as an empty residue name", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6]) });
    const ctx: ColorContext = { scheme: "byResidue", atomLabels: null };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.65, 0.65, 0.65]);
  });

  it("uppercases lowercase residue names so 'ala42' matches 'ALA'", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6]) });
    const ctx: ColorContext = { scheme: "byResidue", atomLabels: ["ala42"] };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.78, 0.78, 0.78]);
  });
});

describe("getAtomColorForScheme — byChain", () => {
  it("indexes the categorical palette by chain byte", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6, 6, 6, 6]),
      atomChainIds: new Uint8Array([65, 66, 97, 48]), // 'A', 'B', 'a', '0'
    });
    const ctx: ColorContext = { scheme: "byChain", atomLabels: null };
    // 'A' → 0, 'a' → 0 (same slot per implementation)
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual(getAtomColorForScheme(2, snap, ctx));
    // 'B' → 1
    expect(getAtomColorForScheme(1, snap, ctx)).not.toEqual(getAtomColorForScheme(0, snap, ctx));
    // '0' → palette index 52 → wraps modulo palette length
    const c0 = getAtomColorForScheme(3, snap, ctx);
    expect(c0).toHaveLength(3);
    for (const v of c0) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("defaults the chain to 'A' when atomChainIds is missing", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomChainIds: null,
    });
    const ctx: ColorContext = { scheme: "byChain", atomLabels: null };
    const fallback = getAtomColorForScheme(0, snap, ctx);
    const explicitA = getAtomColorForScheme(
      0,
      makeSnapshot({
        elements: new Uint8Array([6]),
        atomChainIds: new Uint8Array([65]),
      }),
      ctx,
    );
    expect(fallback).toEqual(explicitA);
  });

  it("maps a non-letter, non-digit byte to palette slot 0", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomChainIds: new Uint8Array([0x20]), // space
    });
    const ctx: ColorContext = { scheme: "byChain", atomLabels: null };
    const slot0 = getAtomColorForScheme(0, snap, ctx);
    const sameAsA = getAtomColorForScheme(
      0,
      makeSnapshot({
        elements: new Uint8Array([6]),
        atomChainIds: new Uint8Array([65]),
      }),
      ctx,
    );
    expect(slot0).toEqual(sameAsA);
  });
});

describe("getAtomColorForScheme — byBFactor", () => {
  it("clamps below the minimum to the cool end of the gradient", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomBFactors: new Float32Array([-10]),
    });
    const ctx: ColorContext = {
      scheme: "byBFactor",
      atomLabels: null,
      bfactorRange: [0, 100],
    };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.07, 0.11, 0.58]);
  });

  it("clamps above the maximum to the hot end of the gradient", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomBFactors: new Float32Array([1000]),
    });
    const ctx: ColorContext = {
      scheme: "byBFactor",
      atomLabels: null,
      bfactorRange: [0, 100],
    };
    const c = getAtomColorForScheme(0, snap, ctx);
    expect(c[0]).toBeCloseTo(0.85, 5);
    expect(c[1]).toBeCloseTo(0.1, 5);
    expect(c[2]).toBeCloseTo(0.1, 5);
  });

  it("interpolates within a gradient segment", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomBFactors: new Float32Array([25]), // 0.25 of [0,100] → cyan stop
    });
    const ctx: ColorContext = {
      scheme: "byBFactor",
      atomLabels: null,
      bfactorRange: [0, 100],
    };
    const c = getAtomColorForScheme(0, snap, ctx);
    expect(c[0]).toBeCloseTo(0.07, 5);
    expect(c[1]).toBeCloseTo(0.65, 5);
    expect(c[2]).toBeCloseTo(0.85, 5);
  });

  it("returns the green stop color when the range collapses to a single value", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomBFactors: new Float32Array([5]),
    });
    const ctx: ColorContext = {
      scheme: "byBFactor",
      atomLabels: null,
      bfactorRange: [5, 5],
    };
    const c = getAtomColorForScheme(0, snap, ctx);
    // collapsed range → t = 0.5 → segment 2 stop (green)
    expect(c[0]).toBeCloseTo(0.22, 5);
    expect(c[1]).toBeCloseTo(0.8, 5);
    expect(c[2]).toBeCloseTo(0.33, 5);
  });

  it("falls back to a default range and zero B-factor when data is missing", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomBFactors: null,
    });
    const ctx: ColorContext = { scheme: "byBFactor", atomLabels: null };
    // value=0, range=[0,100] → blue end
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.07, 0.11, 0.58]);
  });
});

describe("getAtomColorForScheme — byProperty", () => {
  it("uses the supplied propertyValues array and range", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6, 6]) });
    const ctx: ColorContext = {
      scheme: "byProperty",
      atomLabels: null,
      propertyValues: new Float32Array([-1, 1]),
      propertyRange: [-1, 1],
    };
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.07, 0.11, 0.58]);
    const c1 = getAtomColorForScheme(1, snap, ctx);
    expect(c1[0]).toBeCloseTo(0.85, 5);
    expect(c1[1]).toBeCloseTo(0.1, 5);
    expect(c1[2]).toBeCloseTo(0.1, 5);
  });

  it("falls back to default range/zero when propertyValues is missing", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([6]) });
    const ctx: ColorContext = {
      scheme: "byProperty",
      atomLabels: null,
      propertyValues: null,
    };
    // value=0, default range=[0,1] → blue end
    expect(getAtomColorForScheme(0, snap, ctx)).toEqual([0.07, 0.11, 0.58]);
  });
});

describe("lightenLab — Mol* Color.lighten parity", () => {
  // Ground truth generated by running molstar 5.11.0's own mol-util/color code:
  // Color.lighten(ColorLists['many-distinct'][i], 0.8). megane no longer uses
  // that palette, but it does use Mol*'s lightening math, so this pins the CIE
  // Lab port — including the 8-bit rounding on the way back.
  const INPUT = [0x1b9e77, 0xd95f02, 0x7570b3, 0xe7298a, 0x66a61e, 0xff7f00, 0xffff33, 0x666666];
  const EXPECTED = [
    "#4fc69c",
    "#ff8532",
    "#9c95db",
    "#ff5cb0",
    "#8ece48",
    "#ffa639",
    "#ffff63",
    "#8a8a8a",
  ];

  const toRgb = (hex: number): [number, number, number] => [
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
  ];

  it("matches Mol* bit-for-bit at its default carbonLightness of 0.8", () => {
    for (let i = 0; i < INPUT.length; i++) {
      expect(hexOf(lightenLab(toRgb(INPUT[i]), 0.8))).toBe(EXPECTED[i]);
    }
  });

  it("leaves chroma alone, unlike a blend toward white", () => {
    const [, a0, b0] = rgbToLab(toRgb(0x1b9e77));
    const [l1, a1, b1] = rgbToLab(lightenLab(toRgb(0x1b9e77), 0.8));
    expect(l1).toBeGreaterThan(rgbToLab(toRgb(0x1b9e77))[0]);
    expect(a1).toBeCloseTo(a0, 0);
    expect(b1).toBeCloseTo(b0, 0);
  });
});

describe("getAtomColorForScheme — illustrative", () => {
  function chainSnapshot(element: number, nChains: number): Snapshot {
    return makeSnapshot({
      elements: new Uint8Array(nChains).fill(element),
      atomChainIds: new Uint8Array(Array.from({ length: nChains }, (_, i) => 65 + i)),
    });
  }

  function ctxFor(snap: Snapshot): ColorContext {
    return { scheme: "illustrative", atomLabels: null, chainSerials: computeChainSerials(snap) };
  }

  it("softens megane's own chain palette rather than inventing colors", () => {
    // The palette is derived from CHAIN_COLORS in CIE LCh: hue is preserved
    // exactly, lightness rises and chroma drops. Asserting the relationship
    // rather than fixed hexes keeps the test meaningful if the strength moves.
    const snap = chainSnapshot(8, 12); // oxygen: unlightened base color
    const ctx = ctxFor(snap);
    const chainCtx: ColorContext = { scheme: "byChain", atomLabels: null };
    for (let i = 0; i < 12; i++) {
      const base = rgbToLab(getAtomColorForScheme(i, snap, chainCtx));
      const pastel = rgbToLab(getAtomColorForScheme(i, snap, ctx));
      expect(pastel[0]).toBeGreaterThan(base[0]); // lighter
      expect(Math.hypot(pastel[1], pastel[2])).toBeLessThan(Math.hypot(base[1], base[2])); // less chroma
      const hueOf = (lab: [number, number, number]) => Math.atan2(lab[2], lab[1]);
      expect(hueOf(pastel)).toBeCloseTo(hueOf(base), 1); // same hue
    }
  });

  it("gives non-carbon the entity color and carbon a lightened shade of it", () => {
    // Mol*'s rule: every atom takes the entity color, carbon is only lighter.
    // Colouring heteroatoms by element is Mol*'s separate element-symbol theme
    // and is what made a protein read as red/blue confetti.
    const oxygen = chainSnapshot(8, 3);
    const carbon = chainSnapshot(6, 3);
    for (let i = 0; i < 3; i++) {
      const base = getAtomColorForScheme(i, oxygen, ctxFor(oxygen));
      const c = getAtomColorForScheme(i, carbon, ctxFor(carbon));
      expect(hexOf(base)).not.toBe(hexOf(getColor(8))); // not CPK red
      expect(hexOf(c)).toBe(hexOf(lightenLab(base, ILLUSTRATIVE_CARBON_LIGHTNESS)));
      expect(rgbToLab(c)[0]).toBeGreaterThan(rgbToLab(base)[0]);
    }
  });

  it("cycles the palette once the chain count passes its length", () => {
    const snap = chainSnapshot(8, 15);
    const ctx = ctxFor(snap);
    expect(hexOf(getAtomColorForScheme(12, snap, ctx))).toBe(
      hexOf(getAtomColorForScheme(0, snap, ctx)),
    );
  });

  it("numbers chains by first appearance, not by their letter", () => {
    // Mol* assigns entity serials in order of appearance; keying on the ASCII
    // letter would give an antibody's H/L chains palette slots 7 and 11.
    const hl = makeSnapshot({
      elements: new Uint8Array([8, 8]),
      atomChainIds: new Uint8Array([72, 76]), // 'H', 'L'
    });
    const ab = chainSnapshot(8, 2); // 'A', 'B'
    expect(hexOf(getAtomColorForScheme(0, hl, ctxFor(hl)))).toBe(
      hexOf(getAtomColorForScheme(0, ab, ctxFor(ab))),
    );
    expect(hexOf(getAtomColorForScheme(1, hl, ctxFor(hl)))).toBe(
      hexOf(getAtomColorForScheme(1, ab, ctxFor(ab))),
    );
  });

  it("applies Mol*'s water override to solvent residues", () => {
    // The illustrative preset passes overrideWater: true.
    const snap = makeSnapshot({
      elements: new Uint8Array([8, 6]),
      atomChainIds: new Uint8Array([65, 65]),
    });
    const ctx: ColorContext = { ...ctxFor(snap), atomLabels: ["HOH1", "ALA2"] };
    const water = getAtomColorForScheme(0, snap, ctx);
    const solute = getAtomColorForScheme(1, snap, ctx);
    expect(hexOf(water)).not.toBe(hexOf(solute));
    // Softened like the rest of the palette: Mol*'s raw #ff0d0d is fully
    // saturated and swallows the solute in a solvent box.
    const raw: [number, number, number] = [1, 0x0d / 255, 0x0d / 255];
    expect(rgbToLab(water)[0]).toBeGreaterThan(rgbToLab(raw)[0]);
    expect(Math.hypot(...(rgbToLab(water).slice(1) as [number, number]))).toBeLessThan(
      Math.hypot(...(rgbToLab(raw).slice(1) as [number, number])),
    );
  });

  it("falls back to Mol*'s unresolved-entity color without chain data", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([8]), atomChainIds: null });
    expect(hexOf(getAtomColorForScheme(0, snap, ctxFor(snap)))).toBe("#fafafa");
  });
});

describe("computeBfactorRange", () => {
  it("returns [0,100] when no B-factor data is present", () => {
    const snap = makeSnapshot({ atomBFactors: null });
    expect(computeBfactorRange(snap)).toEqual([0, 100]);
  });

  it("returns [0,100] when the B-factor array is empty", () => {
    const snap = makeSnapshot({ atomBFactors: new Float32Array(0) });
    expect(computeBfactorRange(snap)).toEqual([0, 100]);
  });

  it("returns the actual min/max when there is variation", () => {
    const snap = makeSnapshot({
      atomBFactors: new Float32Array([3, 1, 4, 1, 5, 9, 2, 6]),
    });
    expect(computeBfactorRange(snap)).toEqual([1, 9]);
  });

  it("widens a constant B-factor range to avoid a degenerate gradient", () => {
    const snap = makeSnapshot({
      atomBFactors: new Float32Array([7, 7, 7]),
    });
    expect(computeBfactorRange(snap)).toEqual([7, 8]);
  });
});
