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

/** Blend a color toward white by `t` (0 = unchanged, 1 = white). */
function lighten(rgb: [number, number, number], t: number): [number, number, number] {
  return [rgb[0] + (1 - rgb[0]) * t, rgb[1] + (1 - rgb[1]) * t, rgb[2] + (1 - rgb[2]) * t];
}

/** Atomic number of carbon — the element the illustrative scheme recolors. */
const CARBON_Z = 6;

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
      // Mol*'s illustrative color theme: carbon carries the chain (entity)
      // color so each chain reads as one body, while every other element keeps
      // its CPK color so heteroatoms still stand out. The chain color is
      // lightened for carbon, otherwise the CPK reds/blues disappear into it.
      // Structures without chain IDs fall back to chain 'A' — every carbon then
      // shares one tint, which is still the intended Goodsell-style look.
      if (snapshot.elements[atomIdx] !== CARBON_Z) {
        return getColor(snapshot.elements[atomIdx]);
      }
      const chainByte = snapshot.atomChainIds?.[atomIdx] ?? 65; // default 'A'
      const idx = chainIdToIndex(chainByte) % CHAIN_COLORS.length;
      return lighten(CHAIN_COLORS[idx], ILLUSTRATIVE_CARBON_LIGHTNESS);
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
