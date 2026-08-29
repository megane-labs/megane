/**
 * Periodic atom images must mirror the structural atoms' representation.
 *
 * The ghost atoms a Drawing Boundary generates are drawn by their own
 * ImpostorAtomMesh, so every appearance knob the representation sets has to be
 * forwarded — and re-applied whenever the image set is rebuilt, which happens on
 * every boundary change and trajectory frame. Otherwise the ghosts stay small
 * and lit while the real atoms turn into flat spacefill spheres.
 */

import { describe, it, expect } from "vitest";
import { DrawingBoundaryAtomRenderer } from "@/renderer/CellBoundaryAtomRenderer";
import { BALL_STICK_ATOM_SCALE, SPACEFILL_ATOM_SCALE, getRadius } from "@/constants";
import type { Snapshot } from "@/types";
import type { PeriodicAtomImageData } from "@/pipeline/types";

function makeSource(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array(),
    bondOrders: null,
  } as Snapshot;
}

/** One image of each source atom, shifted a lattice vector along +a. */
function makeImages(): PeriodicAtomImageData {
  return {
    positions: new Float32Array([5, 0, 0, 6, 0, 0]),
    elements: new Uint8Array([6, 8]),
    sourceIndices: new Uint32Array([0, 1]),
    latticeShifts: new Int32Array([1, 0, 0, 1, 0, 0]),
  };
}

function internals(r: DrawingBoundaryAtomRenderer): {
  radiusBuf: Float32Array;
  illustrative: number;
} {
  const atoms = (r as unknown as { atoms: unknown }).atoms as {
    radiusBuf: Float32Array;
    material: { uniforms: { uIllustrative: { value: number } } };
  };
  return { radiusBuf: atoms.radiusBuf, illustrative: atoms.material.uniforms.uIllustrative.value };
}

describe("DrawingBoundaryAtomRenderer — illustrative representation", () => {
  it("grows the images to the full vdW radius", () => {
    const r = new DrawingBoundaryAtomRenderer();
    r.loadImages(makeSource(), makeImages());
    r.setRadiusScale(SPACEFILL_ATOM_SCALE);

    const { radiusBuf } = internals(r);
    expect(radiusBuf[0]).toBeCloseTo(getRadius(6), 6);
    expect(radiusBuf[1]).toBeCloseTo(getRadius(8), 6);
  });

  it("toggles the flat-shading uniform on the image mesh", () => {
    const r = new DrawingBoundaryAtomRenderer();
    r.loadImages(makeSource(), makeImages());
    expect(internals(r).illustrative).toBe(0);
    r.setIllustrative(true);
    expect(internals(r).illustrative).toBe(1);
    r.setIllustrative(false);
    expect(internals(r).illustrative).toBe(0);
  });

  it("re-applies the representation after the image set is rebuilt", () => {
    const r = new DrawingBoundaryAtomRenderer();
    const source = makeSource();
    r.loadImages(source, makeImages());
    r.setRadiusScale(SPACEFILL_ATOM_SCALE);
    r.setIllustrative(true);

    // A boundary change / new frame rebuilds the images from scratch.
    r.loadImages(source, makeImages());

    const { radiusBuf, illustrative } = internals(r);
    expect(radiusBuf[0]).toBeCloseTo(getRadius(6), 6);
    expect(illustrative).toBe(1);
  });

  it("returns the images to ball-and-stick when the representation switches back", () => {
    const r = new DrawingBoundaryAtomRenderer();
    r.loadImages(makeSource(), makeImages());
    r.setRadiusScale(SPACEFILL_ATOM_SCALE);
    r.setIllustrative(true);
    r.setRadiusScale(BALL_STICK_ATOM_SCALE);
    r.setIllustrative(false);

    const { radiusBuf, illustrative } = internals(r);
    expect(radiusBuf[0]).toBeCloseTo(getRadius(6) * BALL_STICK_ATOM_SCALE, 6);
    expect(illustrative).toBe(0);
  });

  it("keeps the radius state when no images are loaded yet", () => {
    // setRadiusScale can land before loadImages (the representation node runs
    // before the boundary node emits); the scale must survive to the first load.
    const r = new DrawingBoundaryAtomRenderer();
    r.setRadiusScale(SPACEFILL_ATOM_SCALE);
    r.setIllustrative(true);
    r.loadImages(makeSource(), makeImages());

    const { radiusBuf, illustrative } = internals(r);
    expect(radiusBuf[0]).toBeCloseTo(getRadius(6), 6);
    expect(illustrative).toBe(1);
  });
});
