import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { pickAtPixel, type AtomPickVisibility } from "@/renderer/Picking";
import type { Snapshot } from "@/types";
import type { PeriodicAtomImageData } from "@/pipeline/types";

/**
 * pickAtPixel must only hit atoms the renderer actually draws, so a
 * double-click never moves the orbit center onto an atom hidden with a
 * Modify node's opacity 0 (the documented way to hide a species).
 */

/** 100×100 container anchored at the client origin. */
const container = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
} as unknown as HTMLElement;

function orthoCamera(): THREE.OrthographicCamera {
  // Looking down -z: screen (50, 50) is the world origin, 5 px per unit.
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
  cam.position.set(0, 0, 50);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/** Atom 0 in front (z = 5), atom 1 behind it (z = -5), same screen spot. */
function stacked(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 5, 0, 0, -5]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array(0),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function pick(
  s: Snapshot,
  x: number,
  visibility: AtomPickVisibility | null,
  images: PeriodicAtomImageData | null = null,
) {
  return pickAtPixel(
    orthoCamera(),
    container,
    s,
    s.positions,
    1,
    x,
    50,
    null,
    images,
    0.5,
    visibility,
  );
}

describe("pickAtPixel visibility", () => {
  const visible: AtomPickVisibility = { globalOpacity: 1, opacity: null, scale: null };

  it("hits the front atom when everything is drawn", () => {
    const hit = pick(stacked(), 50, visible);
    expect(hit?.kind === "atom" && hit.atomIndex).toBe(0);
  });

  it("skips an atom faded out by a per-atom opacity override", () => {
    const hit = pick(stacked(), 50, { ...visible, opacity: new Float32Array([0, 1]) });
    expect(hit?.kind === "atom" && hit.atomIndex).toBe(1);
    expect(hit?.kind === "atom" && hit.position).toEqual([0, 0, -5]);
  });

  it("skips an atom scaled to zero", () => {
    const hit = pick(stacked(), 50, { ...visible, scale: new Float32Array([0, 1]) });
    expect(hit?.kind === "atom" && hit.atomIndex).toBe(1);
  });

  it("scales the pick radius with the per-atom scale override", () => {
    // C vdW 1.7 × 0.5 = 0.85 Å → 4.25 px; a click 3 px off still hits.
    const s = stacked();
    const offCenter = 53;
    expect(pick(s, offCenter, visible)?.kind).toBe("atom");
    // At scale 0.25 both radii shrink below 3 px and the click misses.
    const tiny = { ...visible, scale: new Float32Array([0.25, 0.25]) };
    expect(pick(s, offCenter, tiny)).toBeNull();
  });

  it("picks nothing when the global atom opacity is 0", () => {
    expect(pick(stacked(), 50, { ...visible, globalOpacity: 0 })).toBeNull();
  });

  it("applies the source atom's visibility to its periodic images", () => {
    const s = stacked();
    // One image of atom 0 drawn at x = +6 (screen x = 80).
    const images = {
      sourceIndices: new Uint32Array([0]),
      positions: new Float32Array([6, 0, 0]),
    } as unknown as PeriodicAtomImageData;
    const shown = pick(s, 80, visible, images);
    expect(shown?.kind === "atom" && shown.position).toEqual([6, 0, 0]);
    const hidden = pick(s, 80, { ...visible, opacity: new Float32Array([0, 1]) }, images);
    expect(hidden).toBeNull();
  });

  it("keeps the old behaviour when no visibility is passed", () => {
    const hit = pick(stacked(), 50, null);
    expect(hit?.kind === "atom" && hit.atomIndex).toBe(0);
  });
});

describe("MoleculeRenderer.raycastAtPixel visibility wiring", () => {
  it("does not hit atoms the Modify node faded out", async () => {
    const { MoleculeRenderer } = await import("@/renderer/MoleculeRenderer");
    const r = new MoleculeRenderer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = r as any;
    internals.container = container;
    internals.camera = orthoCamera();
    internals.snapshot = stacked();
    expect((r.raycastAtPixel(50, 50) as { atomIndex: number }).atomIndex).toBe(0);
    r.setAtomOpacityOverrides(new Float32Array([0, 1]));
    expect((r.raycastAtPixel(50, 50) as { atomIndex: number }).atomIndex).toBe(1);
    r.setAtomOpacity(0);
    expect(r.raycastAtPixel(50, 50)).toBeNull();
  });
});
