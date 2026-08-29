/**
 * Color scheme definitions and per-atom color computation.
 *
 * Supported schemes:
 *   byElement  – CPK/VESTA element colors (default, existing behaviour)
 *   byResidue  – Shapely-style amino-acid coloring keyed on residue name
 *   byChain    – Categorical palette cycling over chain ID
 *   byBFactor  – Continuous cool→hot viridis-like scale keyed on B-factor
 *   byProperty – Arbitrary per-atom numeric array with user-supplied range
 *   illustrative – Mol*-style: carbon takes a lightened chain color, every
 *                  other element keeps its CPK color
 */

import type { Snapshot } from "./types";
import { getColor, ILLUSTRATIVE_CARBON_LIGHTNESS } from "./constants";

export type ColorScheme =
  | "byElement"
  | "byResidue"
  | "byChain"
  | "byBFactor"
  | "byProperty"
  | "illustrative";

export const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  byElement: "Element",
  byResidue: "Residue",
  byChain: "Chain",
  byBFactor: "B-Factor",
  byProperty: "Property",
  illustrative: "Illustrative",
};

// ─── Residue colors (Shapely palette) ────────────────────────────────────────

const RESIDUE_COLORS: Record<string, [number, number, number]> = {
  // Hydrophobic
  ALA: [0.78, 0.78, 0.78],
  VAL: [0.58, 0.58, 0.58],
  ILE: [0.58, 0.58, 0.58],
  LEU: [0.58, 0.58, 0.58],
  MET: [0.85, 0.8, 0.02],
  PHE: [0.22, 0.22, 0.75],
  TRP: [0.22, 0.22, 0.75],
  PRO: [0.58, 0.58, 0.58],
  // Polar uncharged
  SER: [0.95, 0.65, 0.3],
  THR: [0.95, 0.65, 0.3],
  CYS: [0.9, 0.9, 0.02],
  TYR: [0.22, 0.22, 0.75],
  ASN: [0.53, 0.78, 0.53],
  GLN: [0.53, 0.78, 0.53],
  // Charged positive
  LYS: [0.22, 0.44, 0.85],
  ARG: [0.22, 0.44, 0.85],
  HIS: [0.22, 0.44, 0.85],
  // Charged negative
  ASP: [0.85, 0.22, 0.22],
  GLU: [0.85, 0.22, 0.22],
  // Glycine
  GLY: [1.0, 1.0, 1.0],
  // Nucleotides
  DA: [0.64, 0.16, 0.16],
  DC: [0.24, 0.8, 0.24],
  DG: [0.8, 0.8, 0.24],
  DT: [0.24, 0.8, 0.8],
  A: [0.64, 0.16, 0.16],
  C: [0.24, 0.8, 0.24],
  G: [0.8, 0.8, 0.24],
  U: [0.8, 0.24, 0.8],
};

const DEFAULT_RESIDUE_COLOR: [number, number, number] = [0.65, 0.65, 0.65];

// ─── Chain colors (categorical palette) ──────────────────────────────────────

const CHAIN_COLORS: [number, number, number][] = [
  [0.22, 0.55, 0.85], // blue
  [0.85, 0.33, 0.22], // red
  [0.22, 0.73, 0.33], // green
  [0.85, 0.73, 0.12], // yellow
  [0.6, 0.22, 0.85], // purple
  [0.22, 0.78, 0.78], // cyan
  [0.85, 0.5, 0.22], // orange
  [0.85, 0.22, 0.65], // pink
  [0.45, 0.75, 0.22], // lime
  [0.75, 0.45, 0.22], // brown
  [0.22, 0.45, 0.6], // teal
  [0.6, 0.6, 0.22], // olive
];

// ─── B-factor color scale (viridis-like: blue→cyan→green→yellow→red) ─────────

function bfactorToColor(value: number, minB: number, maxB: number): [number, number, number] {
  const range = maxB - minB;
  const t = range < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (value - minB) / range));

  // 5-stop gradient: blue(0) → cyan(0.25) → green(0.5) → yellow(0.75) → red(1)
  const stops: [number, number, number][] = [
    [0.07, 0.11, 0.58], // blue
    [0.07, 0.65, 0.85], // cyan
    [0.22, 0.8, 0.33], // green
    [0.97, 0.9, 0.12], // yellow
    [0.85, 0.1, 0.1], // red
  ];
  const n = stops.length - 1;
  const seg = t * n;
  const i = Math.min(Math.floor(seg), n - 1);
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
}

// ─── Residue name extraction (shared with selection.ts logic) ─────────────────

function parseResidueName(label: string): string {
  // atomLabels have the form "ALA42" — extract the leading alpha characters.
  let end = 0;
  while (end < label.length && !/\d/.test(label[end])) end++;
  return label.slice(0, end).toUpperCase();
}

// ─── Chain ID → palette index ─────────────────────────────────────────────────

/** Atomic number of carbon — the element the illustrative scheme lightens. */
const CARBON_Z = 6;

// ─── Mol* illustrative palette and lightening (verified against molstar 5.11.0) ──

/**
 * Mol*'s `many-distinct` qualitative color list, verbatim
 * (`mol-util/color/lists.ts`): Dark2 + Set1 + Set2 concatenated. It is the
 * default palette of the `chain-id` and `entity-id` themes the illustrative
 * theme builds on, and is indexed by a serial, cycling with `i % length`.
 */
const MANY_DISTINCT: readonly number[] = [
  // dark-2
  0x1b9e77, 0xd95f02, 0x7570b3, 0xe7298a, 0x66a61e, 0xe6ab02, 0xa6761d, 0x666666,
  // set-1
  0xe41a1c, 0x377eb8, 0x4daf4a, 0x984ea3, 0xff7f00, 0xffff33, 0xa65628, 0xf781bf, 0x999999,
  // set-2
  0x66c2a5, 0xfc8d62, 0x8da0cb, 0xe78ac3, 0xa6d854, 0xffd92f, 0xe5c494, 0xb3b3b3,
];

/** Mol* `EntityIdColorTheme` fallback for an atom with no resolvable entity. */
const ILLUSTRATIVE_DEFAULT_COLOR = 0xfafafa;

/** Mol* `EntityIdColorTheme.waterColor`, applied because the preset sets `overrideWater`. */
const ILLUSTRATIVE_WATER_COLOR = 0xff0d0d;

/** Residue names megane treats as water for the illustrative water override. */
const WATER_RESIDUES: ReadonlySet<string> = new Set([
  "HOH",
  "WAT",
  "SOL",
  "TIP",
  "TIP3",
  "TIP4",
  "H2O",
  "DOD",
  "D2O",
]);

function hexToRgbTriplet(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

// CIE Lab conversion constants, matching Mol*'s `mol-util/color/spaces/lab.ts`
// (itself adapted from chroma.js): D65 white point and the 6/29 breakpoints.
const LAB_XN = 0.95047;
const LAB_YN = 1;
const LAB_ZN = 1.08883;
const LAB_T0 = 0.137931034; // 4 / 29
const LAB_T1 = 0.206896552; // 6 / 29
const LAB_T2 = 0.12841855; // 3 * t1^2
const LAB_T3 = 0.008856452; // t1^3
/** Mol*'s `Lab.darken` step per unit amount; `lighten` is `darken(-amount)`. */
const LAB_KN = 18;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.00304 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function xyzToLabComponent(t: number): number {
  return t > LAB_T3 ? Math.cbrt(t) : t / LAB_T2 + LAB_T0;
}

function labToXyzComponent(t: number): number {
  return t > LAB_T1 ? t * t * t : LAB_T2 * (t - LAB_T0);
}

/**
 * Mol*'s `Color.lighten`: convert to CIE Lab, add `LAB_KN * amount` to L*, and
 * convert back. Chroma (a*, b*) is untouched, so the hue and saturation survive
 * — unlike a blend toward white, which washes the color out. The illustrative
 * theme uses this to lighten carbon relative to the rest of its entity.
 */
function lightenLab(rgb: [number, number, number], amount: number): [number, number, number] {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const x = xyzToLabComponent((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / LAB_XN);
  const y = xyzToLabComponent((0.2126729 * r + 0.7151522 * g + 0.072175 * b) / LAB_YN);
  const z = xyzToLabComponent((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / LAB_ZN);

  const l0 = 116 * y - 16;
  const l = Math.max(0, l0) + LAB_KN * amount;
  const aStar = 500 * (x - y);
  const bStar = 200 * (y - z);

  const yy = (l + 16) / 116;
  const xx = yy + aStar / 500;
  const zz = yy - bStar / 200;
  const xr = LAB_XN * labToXyzComponent(xx);
  const yr = LAB_YN * labToXyzComponent(yy);
  const zr = LAB_ZN * labToXyzComponent(zz);

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // Mol* rounds to 8-bit channels on the way back; match it so a megane color
  // is bit-identical to the one Mol* would produce for the same input.
  const quantize = (v: number) => Math.round(clamp01(linearToSrgb(v)) * 255) / 255;
  return [
    quantize(3.2404542 * xr - 1.5371385 * yr - 0.4985314 * zr),
    quantize(-0.969266 * xr + 1.8760108 * yr + 0.041556 * zr),
    quantize(0.0556434 * xr - 0.2040259 * yr + 1.0572252 * zr),
  ];
}

/**
 * Serial number per chain, assigned in order of first appearance — the way Mol*
 * numbers entities before indexing its palette. Indexed by the raw chain byte;
 * 0xffff marks a byte the structure never uses.
 */
/**
 * The illustrative theme's per-entity base color: Mol*'s palette cycled by the
 * chain serial. Structures with no chain information have no entity to key on,
 * so they take Mol*'s `DefaultColor` for an unresolvable entity.
 */
function illustrativeEntityColor(
  atomIdx: number,
  snapshot: Snapshot,
  ctx: ColorContext,
): [number, number, number] {
  const ids = snapshot.atomChainIds;
  if (!ids) return hexToRgbTriplet(ILLUSTRATIVE_DEFAULT_COLOR);
  const serial = ctx.chainSerials?.[ids[atomIdx]] ?? 0;
  const idx = (serial === 0xffff ? 0 : serial) % MANY_DISTINCT.length;
  return hexToRgbTriplet(MANY_DISTINCT[idx]);
}

export function computeChainSerials(snapshot: Snapshot): Uint16Array {
  const serials = new Uint16Array(256).fill(0xffff);
  const ids = snapshot.atomChainIds;
  if (!ids) return serials;
  let next = 0;
  for (let i = 0; i < snapshot.nAtoms && i < ids.length; i++) {
    const byte = ids[i];
    if (serials[byte] === 0xffff) serials[byte] = next++;
  }
  return serials;
}

function chainIdToIndex(chainByte: number): number {
  // Map ASCII 'A'-'Z' → 0-25, 'a'-'z' → 26-51, '0'-'9' → 52-61, else 0
  if (chainByte >= 65 && chainByte <= 90) return chainByte - 65;
  if (chainByte >= 97 && chainByte <= 122) return chainByte - 97;
  if (chainByte >= 48 && chainByte <= 57) return chainByte - 48 + 52;
  return 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ColorContext {
  scheme: ColorScheme;
  atomLabels: string[] | null;
  /** Pre-computed B-factor range for the current snapshot (avoids O(n) per atom). */
  bfactorRange?: [number, number];
  /** Arbitrary per-atom property values for byProperty scheme. */
  propertyValues?: Float32Array | null;
  /** Pre-computed property range for byProperty scheme. */
  propertyRange?: [number, number];
  /**
   * Pre-computed chain serials for the illustrative scheme (see
   * `computeChainSerials`). Omitted = fall back to the first palette entry.
   */
  chainSerials?: Uint16Array;
}

/**
 * Compute [r,g,b] in 0-1 range for a single atom under the given scheme.
 * Falls back to byElement when the required data is missing.
 */
export function getAtomColorForScheme(
  atomIdx: number,
  snapshot: Snapshot,
  ctx: ColorContext,
): [number, number, number] {
  switch (ctx.scheme) {
    case "byElement":
      return getColor(snapshot.elements[atomIdx]);

    case "byResidue": {
      const label = ctx.atomLabels?.[atomIdx] ?? "";
      const resname = parseResidueName(label);
      return RESIDUE_COLORS[resname] ?? DEFAULT_RESIDUE_COLOR;
    }

    case "byChain": {
      const chainByte = snapshot.atomChainIds?.[atomIdx] ?? 65; // default 'A'
      const idx = chainIdToIndex(chainByte) % CHAIN_COLORS.length;
      return CHAIN_COLORS[idx];
    }

    case "byBFactor": {
      const bf = snapshot.atomBFactors?.[atomIdx] ?? 0;
      const [minB, maxB] = ctx.bfactorRange ?? [0, 100];
      return bfactorToColor(bf, minB, maxB);
    }

    case "byProperty": {
      const val = ctx.propertyValues?.[atomIdx] ?? 0;
      const [minV, maxV] = ctx.propertyRange ?? [0, 1];
      return bfactorToColor(val, minV, maxV);
    }

    case "illustrative": {
      // Mol*'s illustrative theme (`mol-theme/color/illustrative.ts`):
      //
      //     const baseColor = styleColor(location, false);
      //     return typeSymbol === 'C' ? Color.lighten(baseColor, carbonLightness) : baseColor;
      //
      // EVERY atom takes the entity color; carbon is only a lightened shade of
      // that same color. Non-carbon atoms do NOT get CPK colors — that is the
      // separate `element-symbol` theme. Each entity therefore reads as one
      // flat body, which is the whole point of the Goodsell-style look.
      //
      // megane has no entity concept, so chain ID stands in for `label_entity_id`
      // (the closest analogue megane parses). The preset also turns on
      // `overrideWater`, so waters take the theme's water color.
      const label = ctx.atomLabels?.[atomIdx];
      if (label !== undefined && WATER_RESIDUES.has(parseResidueName(label))) {
        return hexToRgbTriplet(ILLUSTRATIVE_WATER_COLOR);
      }
      const base = illustrativeEntityColor(atomIdx, snapshot, ctx);
      return snapshot.elements[atomIdx] === CARBON_Z
        ? lightenLab(base, ILLUSTRATIVE_CARBON_LIGHTNESS)
        : base;
    }
  }
}

/**
 * Pre-compute the B-factor range for a snapshot (min/max over all atoms).
 * Returns [0, 100] when no B-factor data is available.
 */
export function computeBfactorRange(snapshot: Snapshot): [number, number] {
  const bfs = snapshot.atomBFactors;
  if (!bfs || bfs.length === 0) return [0, 100];
  let min = bfs[0];
  let max = bfs[0];
  for (let i = 1; i < bfs.length; i++) {
    if (bfs[i] < min) min = bfs[i];
    if (bfs[i] > max) max = bfs[i];
  }
  return [min, max === min ? min + 1 : max];
}
