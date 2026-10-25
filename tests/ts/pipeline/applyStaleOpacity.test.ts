/**
 * Turning a Modify node's opacity back to 1 while its scale stays must drop
 * the per-atom opacities it wrote earlier.
 *
 * The Modify node emits `opacityOverrides: null` at opacity 1. When the merged
 * stream still carried scale overrides, applying it only replaced the scale
 * and reset the global opacity, so the old per-atom alphas (and the renderer's
 * record of them) stayed: atoms kept alpha 0.3 on an opaque material (washed
 * out on the alpha canvas), and atoms once at opacity 0 stayed unpickable.
 */

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { StructureLayer } from "@/renderer/StructureLayer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { applyViewportState } from "@/pipeline/apply";
import { DEFAULT_VIEWPORT_STATE, type ParticleData } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function snap(n: number): Snapshot {
  return {
    nAtoms: n,
    nBonds: 0,
    positions: new Float32Array(n * 3),
    elements: new Uint8Array(n).fill(6),
    bonds: new Uint32Array(),
    bondOrders: null,
  } as unknown as Snapshot;
}

function particle(
  s: Snapshot,
  sourceNodeId: string,
  scale: number[] | null,
  opacity: number[] | null,
): ParticleData {
  return {
    type: "particle",
    source: s,
    sourceNodeId,
    indices: null,
    scaleOverrides: scale ? new Float32Array(scale) : null,
    opacityOverrides: opacity ? new Float32Array(opacity) : null,
    colorOverrides: null,
    representationOverride: null,
  };
}

/** The per-atom buffers and material flags of an impostor atom mesh. */
function meshState(mesh: ImpostorAtomMesh) {
  const m = mesh as unknown as {
    opacityOverrideBuf: Float32Array;
    scaleOverrideBuf: Float32Array;
    material: THREE.ShaderMaterial;
  };
  return {
    opacity: Array.from(m.opacityOverrideBuf.subarray(0, 3)),
    scale: Array.from(m.scaleOverrideBuf.subarray(0, 3)),
    transparent: m.material.transparent,
  };
}

/** A renderer with its primary atom mesh but no WebGL scene. */
function primaryRenderer() {
  const renderer = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.scene = new THREE.Scene();
  internals.swapRenderers();
  const s = snap(3);
  internals.snapshot = s;
  internals.atomRenderer.loadSnapshot(s);
  // Only the atom-override calls are real; the rest of the viewport state
  // needs a mounted scene.
  const overrides = new Set([
    "setAtomScale",
    "setAtomOpacity",
    "setAtomScaleOverrides",
    "setAtomOpacityOverrides",
    "clearAtomOverrides",
    "applyAtomColorOverrides",
  ]);
  const stub = new Proxy(
    {},
    {
      get: (_target, key) =>
        overrides.has(key as string)
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (renderer as any)[key].bind(renderer)
          : () => undefined,
    },
  ) as MoleculeRenderer;
  return { renderer, internals, s, stub };
}

describe("applyViewportState — Modify opacity back to 1 with scale kept", () => {
  it("drops the old per-atom opacities on the primary structure", () => {
    const { internals, s, stub } = primaryRenderer();
    applyViewportState(
      stub,
      {
        ...DEFAULT_VIEWPORT_STATE,
        particles: [particle(s, "load", [0.5, 0.5, 0.5], [0.3, 0.3, 0.3])],
      },
      null,
    );
    expect(meshState(internals.atomRenderer).opacity).toEqual([0.3, 0.3, 0.3].map(Math.fround));
    expect(meshState(internals.atomRenderer).transparent).toBe(true);

    applyViewportState(
      stub,
      { ...DEFAULT_VIEWPORT_STATE, particles: [particle(s, "load", [0.5, 0.5, 0.5], null)] },
      null,
    );
    const after = meshState(internals.atomRenderer);
    expect(after.opacity).toEqual([1, 1, 1]);
    expect(after.scale).toEqual([0.5, 0.5, 0.5]);
    expect(after.transparent).toBe(false);
    // Picking reads this record: an atom once at opacity 0 must be pickable again.
    expect(internals.atomLayers.state.opacityOverrides).toBeNull();
    expect(internals.atomLayers.state.scaleOverrides).not.toBeNull();
  });

  it("drops the old per-atom scales when only opacity remains", () => {
    const { internals, s, stub } = primaryRenderer();
    applyViewportState(
      stub,
      {
        ...DEFAULT_VIEWPORT_STATE,
        particles: [particle(s, "load", [0.5, 0.5, 0.5], [0.3, 0.3, 0.3])],
      },
      null,
    );
    applyViewportState(
      stub,
      { ...DEFAULT_VIEWPORT_STATE, particles: [particle(s, "load", null, [0.3, 0.3, 0.3])] },
      null,
    );
    const after = meshState(internals.atomRenderer);
    expect(after.scale).toEqual([1, 1, 1]);
    expect(after.opacity).toEqual([0.3, 0.3, 0.3].map(Math.fround));
    expect(internals.atomLayers.state.scaleOverrides).toBeNull();
  });

  it("drops the old per-atom opacities on a secondary structure layer", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("second", scene);
    const s = snap(3);
    layer.loadSnapshot(s);
    const stub = {
      getOrCreateLayer: () => layer,
      removeInactiveLayers: () => undefined,
    };
    const state = (p: ParticleData) => ({
      ...DEFAULT_VIEWPORT_STATE,
      // The first source is the primary; the second goes to a layer.
      particles: [particle(snap(1), "first", null, null), p],
    });
    const proxy = new Proxy(stub, {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    }) as unknown as MoleculeRenderer;
    applyViewportState(proxy, state(particle(s, "second", [0.5, 0.5, 0.5], [0.3, 0.3, 0.3])), null);
    applyViewportState(proxy, state(particle(s, "second", [0.5, 0.5, 0.5], null)), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = layer as any;
    const after = meshState(internals.atomRenderer);
    expect(after.opacity).toEqual([1, 1, 1]);
    expect(after.scale).toEqual([0.5, 0.5, 0.5]);
    expect(internals.currentOpacityOverrides).toBeNull();
  });
});
