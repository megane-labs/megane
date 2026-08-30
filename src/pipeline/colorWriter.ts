/**
 * Helpers for the Modify node's per-atom color section. The writer factory
 * builds a closure that paints a single atom's RGB triplet into a buffer
 * given the active mode (uniform / byElement / by*); the executor calls it in
 * a tight loop over the upstream selection so the per-atom case stays in
 * inner-loop hot path without re-resolving the mode every iteration.
 */

import type { ParticleData, ColorMode } from "./types";
import {
  type ColorContext,
  type ColorScheme,
  computeBfactorRange,
  computeChainSerials,
  getAtomColorForScheme,
} from "../colorSchemes";

export const NO_OVERRIDE = Number.NaN;

const HEX_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/**
 * Parse a CSS-style hex color into a normalised [r,g,b] triplet in [0,1].
 * Falls back to white on parse error so a malformed `uniformColor` from a
 * legacy serialized pipeline cannot crash the executor.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const match = hex.match(HEX_RE);
  if (!match) return [1, 1, 1];
  let body = match[1];
  if (body.length === 3) {
    body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
  }
  const r = parseInt(body.slice(0, 2), 16) / 255;
  const g = parseInt(body.slice(2, 4), 16) / 255;
  const b = parseInt(body.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export type ColorWriter = (buf: Float32Array, atomIdx: number) => void;

/**
 * Build a color writer for the given mode. Mode-specific context (palette
 * lookup tables, B-factor range, atom labels) is captured in the closure so
 * the per-atom path is just an array store.
 */
export function makeColorWriter(
  mode: ColorMode,
  uniformColor: string,
  particle: ParticleData,
  atomLabels: string[] | null,
  range: [number, number] | undefined,
): ColorWriter {
  if (mode === "uniform") {
    const [r, g, b] = hexToRgb(uniformColor);
    return (buf, i) => {
      const i3 = i * 3;
      buf[i3] = r;
      buf[i3 + 1] = g;
      buf[i3 + 2] = b;
    };
  }

  const ctx: ColorContext = {
    scheme: mode satisfies ColorScheme,
    atomLabels,
    bfactorRange: range ?? computeBfactorRange(particle.source),
    propertyValues: null,
    propertyRange: range,
    // Mol* indexes its palette by entity serial, i.e. order of first
    // appearance — precomputed here so the per-atom path stays a lookup.
    chainSerials: mode === "illustrative" ? computeChainSerials(particle.source) : undefined,
  };
  return (buf, i) => {
    const [r, g, b] = getAtomColorForScheme(i, particle.source, ctx);
    const i3 = i * 3;
    buf[i3] = r;
    buf[i3 + 1] = g;
    buf[i3 + 2] = b;
  };
}

/**
 * Initialise (or copy) a colorOverrides buffer for the given particle. When
 * the upstream stream already carries one, the result is a copy so the
 * executor never mutates input. Otherwise a fresh `nAtoms*3` buffer filled
 * with the NaN sentinel is returned.
 */
export function ensureColorOverridesBuffer(particle: ParticleData): Float32Array {
  const nAtoms = particle.source.nAtoms;
  if (particle.colorOverrides) {
    return new Float32Array(particle.colorOverrides);
  }
  const buf = new Float32Array(nAtoms * 3);
  buf.fill(NO_OVERRIDE);
  return buf;
}
