import { describe, it, expect } from "vitest";
import {
  COLOR_SCHEME_LABELS,
  computeBfactorRange,
  computeChainSerials,
  getAtomColorForScheme,
  type ColorContext,
  type ColorScheme,
} from "@/colorSchemes";
import type { Snapshot } from "@/types";
import { getColor } from "@/constants";

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

describe("getAtomColorForScheme — illustrative", () => {
  // Ground truth produced by running molstar 5.11.0's own mol-util/color code:
  // Color.lighten(ColorLists['many-distinct'][i], 0.8) for each palette entry.
  // Mol*'s rule (mol-theme/color/illustrative.ts) is that EVERY atom takes the
  // entity color and only carbon is lightened — non-carbon atoms keep it as-is.
  const MOLSTAR_CARBON = [
    "#4fc69c", "#ff8532", "#9c95db", "#ff5cb0", "#8ece48", "#ffd23f", "#d09b43",
    "#8a8a8a", "#ff513e", "#64a3e0", "#76d76f", "#c073cb", "#ffa639", "#ffff63",
    "#d17a4a", "#ffa9e7", "#c0c0c0", "#8eebcc", "#ffb487", "#b4c7f4", "#ffb1eb",
    "#cfff7b", "#ffff5d", "#ffecbb", "#dbdbdb",
  ];
  const MOLSTAR_BASE = [
    "#1b9e77", "#d95f02", "#7570b3", "#e7298a", "#66a61e", "#e6ab02", "#a6761d",
    "#666666", "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#ffff33",
    "#a65628", "#f781bf", "#999999", "#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3",
    "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3",
  ];

  const hex = (c: [number, number, number]) =>
    "#" +
    c
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");

  function chainSnapshot(element: number, nChains = MOLSTAR_BASE.length): Snapshot {
    return makeSnapshot({
      elements: new Uint8Array(nChains).fill(element),
      atomChainIds: new Uint8Array(Array.from({ length: nChains }, (_, i) => 65 + i)),
    });
  }

  function ctxFor(snap: Snapshot): ColorContext {
    return { scheme: "illustrative", atomLabels: null, chainSerials: computeChainSerials(snap) };
  }

  it("matches Mol* bit-for-bit on carbon across the whole many-distinct palette", () => {
    const snap = chainSnapshot(6);
    const ctx = ctxFor(snap);
    for (let i = 0; i < MOLSTAR_CARBON.length; i++) {
      expect(hex(getAtomColorForScheme(i, snap, ctx))).toBe(MOLSTAR_CARBON[i]);
    }
  });

  it("gives non-carbon the unlightened entity color, not a CPK color", () => {
    // The regression this locks down: an earlier implementation used CPK for
    // non-carbon, which is Mol*'s separate element-symbol theme and makes a
    // protein read as red/blue confetti instead of one body per chain.
    const snap = chainSnapshot(8); // oxygen
    const ctx = ctxFor(snap);
    for (let i = 0; i < MOLSTAR_BASE.length; i++) {
      expect(hex(getAtomColorForScheme(i, snap, ctx))).toBe(MOLSTAR_BASE[i]);
    }
    expect(hex(getAtomColorForScheme(0, snap, ctx))).not.toBe(hex(getColor(8)));
  });

  it("cycles the palette once the chain count passes its length", () => {
    const n = MOLSTAR_BASE.length + 3;
    const snap = chainSnapshot(8, n);
    const ctx = ctxFor(snap);
    for (let i = 0; i < 3; i++) {
      expect(hex(getAtomColorForScheme(MOLSTAR_BASE.length + i, snap, ctx))).toBe(MOLSTAR_BASE[i]);
    }
  });

  it("numbers chains by first appearance, not by their letter", () => {
    // Mol* assigns entity serials in order of appearance; keying on the ASCII
    // letter would give an antibody's H/L chains palette slots 7 and 11.
    const snap = makeSnapshot({
      elements: new Uint8Array([8, 8]),
      atomChainIds: new Uint8Array([72, 76]), // 'H', 'L'
    });
    const ctx = ctxFor(snap);
    expect(hex(getAtomColorForScheme(0, snap, ctx))).toBe(MOLSTAR_BASE[0]);
    expect(hex(getAtomColorForScheme(1, snap, ctx))).toBe(MOLSTAR_BASE[1]);
  });

  it("applies Mol*'s water override to solvent residues", () => {
    // The illustrative preset passes overrideWater: true.
    const snap = makeSnapshot({
      elements: new Uint8Array([8, 6]),
      atomChainIds: new Uint8Array([65, 65]),
    });
    const ctx: ColorContext = {
      ...ctxFor(snap),
      atomLabels: ["HOH1", "ALA2"],
    };
    expect(hex(getAtomColorForScheme(0, snap, ctx))).toBe("#ff0d0d");
    expect(hex(getAtomColorForScheme(1, snap, ctx))).not.toBe("#ff0d0d");
  });

  it("falls back to Mol*'s unresolved-entity color without chain data", () => {
    const snap = makeSnapshot({ elements: new Uint8Array([8]), atomChainIds: null });
    expect(hex(getAtomColorForScheme(0, snap, ctxFor(snap)))).toBe("#fafafa");
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
