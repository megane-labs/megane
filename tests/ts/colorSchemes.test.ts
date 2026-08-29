import { describe, it, expect } from "vitest";
import {
  COLOR_SCHEME_LABELS,
  computeBfactorRange,
  getAtomColorForScheme,
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
  it("gives carbon a lightened chain color and leaves other elements CPK", () => {
    // Two chains ('A', 'B') of C/N so the carbon tint differs per chain while
    // the nitrogen keeps its CPK blue, as in Mol*'s illustrative color theme.
    const snap = makeSnapshot({
      elements: new Uint8Array([6, 7, 6, 7]),
      atomChainIds: new Uint8Array([65, 65, 66, 66]),
    });
    const ctx: ColorContext = { scheme: "illustrative", atomLabels: null };
    const chainCtx: ColorContext = { scheme: "byChain", atomLabels: null };

    const carbonA = getAtomColorForScheme(0, snap, ctx);
    const carbonB = getAtomColorForScheme(2, snap, ctx);
    expect(carbonA).not.toEqual(carbonB);

    // Non-carbon keeps the plain CPK color.
    expect(getAtomColorForScheme(1, snap, ctx)).toEqual(getColor(7));
    expect(getAtomColorForScheme(3, snap, ctx)).toEqual(getColor(7));

    // Carbon is the chain color blended toward white, so each channel sits
    // between the raw chain color and 1.
    const rawA = getAtomColorForScheme(0, snap, chainCtx);
    for (let c = 0; c < 3; c++) {
      expect(carbonA[c]).toBeGreaterThan(rawA[c] - 1e-6);
      expect(carbonA[c]).toBeLessThanOrEqual(1);
    }
    expect(carbonA).not.toEqual(rawA);
  });

  it("lightens carbon by exactly ILLUSTRATIVE_CARBON_LIGHTNESS", () => {
    const snap = makeSnapshot({
      elements: new Uint8Array([6]),
      atomChainIds: new Uint8Array([65]),
    });
    const raw = getAtomColorForScheme(0, snap, { scheme: "byChain", atomLabels: null });
    const lit = getAtomColorForScheme(0, snap, { scheme: "illustrative", atomLabels: null });
    for (let c = 0; c < 3; c++) {
      expect(lit[c]).toBeCloseTo(raw[c] + (1 - raw[c]) * ILLUSTRATIVE_CARBON_LIGHTNESS, 6);
    }
  });

  it("falls back to chain 'A' when the structure carries no chain IDs", () => {
    const withIds = makeSnapshot({
      elements: new Uint8Array([6]),
      atomChainIds: new Uint8Array([65]),
    });
    const without = makeSnapshot({ elements: new Uint8Array([6]), atomChainIds: null });
    const ctx: ColorContext = { scheme: "illustrative", atomLabels: null };
    expect(getAtomColorForScheme(0, without, ctx)).toEqual(getAtomColorForScheme(0, withIds, ctx));
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
