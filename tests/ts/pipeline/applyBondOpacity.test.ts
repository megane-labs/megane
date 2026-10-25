/**
 * The bond opacity the renderer ends up drawing for a sequence of viewport
 * states: the shader multiplies the global opacity by the per-bond values
 * while those are set, and the Modify node folds the stream's global opacity
 * into the per-bond values, so the global one must be 1 while they are set —
 * whatever was applied before.
 */

import { describe, it, expect } from "vitest";
import { applyViewportState } from "@/pipeline/apply";
import { DEFAULT_VIEWPORT_STATE, type BondData, type ParticleData } from "@/pipeline/types";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { Snapshot } from "@/types";

const snapshot = {
  nAtoms: 4,
  nBonds: 2,
  positions: new Float32Array(12),
  elements: new Uint8Array([8, 1, 6, 1]),
  bonds: new Uint32Array([0, 1, 2, 3]),
  bondOrders: null,
} as unknown as Snapshot;

function particle(sourceNodeId: string): ParticleData {
  return {
    type: "particle",
    source: snapshot,
    sourceNodeId,
    indices: null,
    scaleOverrides: null,
    opacityOverrides: null,
    colorOverrides: null,
    representationOverride: null,
  };
}

function bond(sourceNodeId: string, opacity: number, overrides: number[] | null): BondData {
  return {
    type: "bond",
    sourceNodeId,
    bondIndices: snapshot.bonds,
    bondOrders: null,
    nBonds: 2,
    scale: 1,
    opacity,
    positions: null,
    elements: null,
    nAtoms: 4,
    atomElements: snapshot.elements,
    selectedBondIndices: overrides ? new Uint32Array([1]) : null,
    bondOpacityOverrides: overrides ? new Float32Array(overrides) : null,
  };
}

/** Bond opacity state of a bond renderer, drawn the way the shader does. */
function bondSink() {
  const state = { global: 1, perBond: null as Float32Array | null };
  return {
    state,
    drawn: () => [0, 1].map((i) => state.global * (state.perBond ? state.perBond[i] : 1)),
    setBondOpacity: (o: number) => {
      state.global = o;
    },
    setBondOpacityOverrides: (o: Float32Array) => {
      state.perBond = o;
    },
    clearBondOpacityOverrides: () => {
      state.perBond = null;
    },
  };
}

/** A renderer whose bond opacity calls reach `sink`; every other call is a no-op. */
function stubRenderer(sink: ReturnType<typeof bondSink>, layer?: ReturnType<typeof bondSink>) {
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === "getOrCreateLayer") {
          return () =>
            new Proxy({}, { get: (_l, k) => (layer as never)?.[k] ?? (() => undefined) });
        }
        return (sink as never)[key] ?? (() => undefined);
      },
    },
  ) as unknown as MoleculeRenderer;
}

function state(...bonds: BondData[]) {
  const ids = [...new Set(bonds.map((b) => b.sourceNodeId))];
  return { ...DEFAULT_VIEWPORT_STATE, particles: ids.map(particle), bonds };
}

describe("applyViewportState — bond opacity", () => {
  it("draws the per-bond values as they are, not times a global one left from before", () => {
    const sink = bondSink();
    const renderer = stubRenderer(sink);
    // A global fade first, then a selective modify folds it in: [0.5, 0].
    const faded = state(bond("load", 0.5, null));
    applyViewportState(renderer, faded, null);
    expect(sink.drawn()).toEqual([0.5, 0.5]);
    const selective = state(bond("load", 0.5, [0.5, 0]));
    applyViewportState(renderer, selective, faded);
    expect(sink.drawn()).toEqual([0.5, 0]);

    // Back to the global fade alone, and then a different one.
    const back = state(bond("load", 0.5, null));
    applyViewportState(renderer, back, selective);
    expect(sink.drawn()).toEqual([0.5, 0.5]);
    const lighter = state(bond("load", 0.8, null));
    applyViewportState(renderer, lighter, back);
    expect(sink.drawn()).toEqual([0.8, 0.8]);

    // A fresh renderer state (no previous) with per-bond values only.
    const fresh = bondSink();
    fresh.state.global = 0.3; // left from an earlier file
    applyViewportState(stubRenderer(fresh), selective, null);
    expect(fresh.drawn()).toEqual([0.5, 0]);
  });

  it("does the same on a secondary structure layer", () => {
    const primary = bondSink();
    const layer = bondSink();
    layer.state.global = 0.3;
    const renderer = stubRenderer(primary, layer);
    applyViewportState(
      renderer,
      state(bond("load", 1, null), bond("other", 0.5, [0.5, 0])),
      null,
      "load",
    );
    expect(layer.drawn()).toEqual([0.5, 0]);
    applyViewportState(
      renderer,
      state(bond("load", 1, null), bond("other", 0.6, null)),
      null,
      "load",
    );
    expect(layer.drawn()).toEqual([0.6, 0.6]);
  });
});
