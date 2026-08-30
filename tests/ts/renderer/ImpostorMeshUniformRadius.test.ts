import { describe, it, expect } from "vitest";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import {
  BOND_SINGLE,
  BOND_DOUBLE,
  BOND_RADIUS,
  DOUBLE_BOND_RADIUS,
  LICORICE_RADIUS,
  SPACEFILL_ATOM_SCALE,
  ILLUSTRATIVE_AMBIENT_DARKENING,
  ILLUSTRATIVE_OUTLINE_WIDTH,
  getRadius,
  BALL_STICK_ATOM_SCALE,
} from "@/constants";
import type { Snapshot } from "@/types";

function makeSnapshot(bondOrder: number = BOND_SINGLE): Snapshot {
  return {
    // Carbon (Z=6) — Oxygen (Z=8): two different vdW radii.
    nAtoms: 2,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: bondOrder === BOND_SINGLE ? null : new Uint8Array([bondOrder]),
  } as Snapshot;
}

function atomRadii(mesh: ImpostorAtomMesh): Float32Array {
  return (mesh as unknown as { radiusBuf: Float32Array }).radiusBuf;
}

function bondRadii(mesh: ImpostorBondMesh): Float32Array {
  return (mesh as unknown as { radiusBuf: Float32Array }).radiusBuf;
}

describe("ImpostorAtomMesh.setRadiusScale", () => {
  it("scales every atom to its full vdW radius (spacefill)", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setRadiusScale(SPACEFILL_ATOM_SCALE, snap);

    const r = atomRadii(mesh);
    expect(r[0]).toBeCloseTo(getRadius(6), 6);
    expect(r[1]).toBeCloseTo(getRadius(8), 6);
  });

  it("survives a reload of the snapshot", () => {
    // loadSnapshot refills the radius buffer; it must honour the active scale
    // instead of silently reverting to ball-and-stick on the next frame.
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setRadiusScale(SPACEFILL_ATOM_SCALE, snap);
    mesh.loadSnapshot(snap);

    expect(atomRadii(mesh)[0]).toBeCloseTo(getRadius(6), 6);
  });

  it("yields to an active uniform radius", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setUniformRadius(LICORICE_RADIUS, snap);
    mesh.setRadiusScale(SPACEFILL_ATOM_SCALE, snap);

    expect(atomRadii(mesh)[0]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("applies the scale once the uniform radius is cleared", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setRadiusScale(SPACEFILL_ATOM_SCALE, snap);
    mesh.setUniformRadius(LICORICE_RADIUS, snap);
    mesh.setUniformRadius(null, snap);

    expect(atomRadii(mesh)[0]).toBeCloseTo(getRadius(6), 6);
  });
});

describe("ImpostorAtomMesh.setIllustrative", () => {
  it("toggles the flat-shading uniform", () => {
    const mesh = new ImpostorAtomMesh(8);
    const uniforms = (
      mesh as unknown as { material: { uniforms: { uIllustrative: { value: number } } } }
    ).material.uniforms;
    expect(uniforms.uIllustrative.value).toBe(0);
    mesh.setIllustrative(true);
    expect(uniforms.uIllustrative.value).toBe(1);
    mesh.setIllustrative(false);
    expect(uniforms.uIllustrative.value).toBe(0);
  });

  it("seeds the illustrative shading uniforms from the constants", () => {
    // The rim ramp stands in for Mol*'s SSAO pass, so a zero here would
    // silently return the mode to the flat look it is meant to replace.
    const mesh = new ImpostorAtomMesh(8);
    const uniforms = (
      mesh as unknown as {
        material: {
          uniforms: { uAmbientDarkening: { value: number }; uOutlineWidth: { value: number } };
        };
      }
    ).material.uniforms;
    expect(uniforms.uAmbientDarkening.value).toBeCloseTo(ILLUSTRATIVE_AMBIENT_DARKENING, 6);
    expect(uniforms.uAmbientDarkening.value).toBeGreaterThan(0);
    expect(uniforms.uOutlineWidth.value).toBeCloseTo(ILLUSTRATIVE_OUTLINE_WIDTH, 6);
  });
});

describe("ImpostorAtomMesh.setUniformRadius", () => {
  it("renders per-element vdW radii by default (ball-and-stick)", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);

    const r = atomRadii(mesh);
    expect(r[0]).toBeCloseTo(getRadius(6) * BALL_STICK_ATOM_SCALE, 6);
    expect(r[1]).toBeCloseTo(getRadius(8) * BALL_STICK_ATOM_SCALE, 6);
    // Different elements → different radii.
    expect(r[0]).not.toBeCloseTo(r[1], 6);
  });

  it("collapses every atom to a single licorice radius", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setUniformRadius(LICORICE_RADIUS, snap);

    const r = atomRadii(mesh);
    expect(r[0]).toBeCloseTo(LICORICE_RADIUS, 6);
    expect(r[1]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("reverts to vdW radii when radius is null", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setUniformRadius(LICORICE_RADIUS, snap);
    mesh.setUniformRadius(null, snap);

    const r = atomRadii(mesh);
    expect(r[0]).toBeCloseTo(getRadius(6) * BALL_STICK_ATOM_SCALE, 6);
    expect(r[1]).toBeCloseTo(getRadius(8) * BALL_STICK_ATOM_SCALE, 6);
  });

  it("keeps the licorice radius across a subsequent loadSnapshot", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    mesh.setUniformRadius(LICORICE_RADIUS, snap);

    // New structure load while licorice is active.
    mesh.loadSnapshot(makeSnapshot());
    const r = atomRadii(mesh);
    expect(r[0]).toBeCloseTo(LICORICE_RADIUS, 6);
    expect(r[1]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("flags the radius attribute for re-upload", () => {
    const mesh = new ImpostorAtomMesh(8);
    const snap = makeSnapshot();
    mesh.loadSnapshot(snap);
    const attr = (mesh as unknown as { radiusAttr: { version: number } }).radiusAttr;
    const before = attr.version;
    mesh.setUniformRadius(LICORICE_RADIUS, snap);
    expect(attr.version).toBeGreaterThan(before);
  });
});

describe("ImpostorBondMesh.setUniformRadius", () => {
  it("uses per-order default radii by default", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));
    expect(bondRadii(mesh)[0]).toBeCloseTo(BOND_RADIUS, 6);
  });

  it("collapses every visual instance to a single licorice radius", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_DOUBLE)); // → 2 visual instances
    mesh.setUniformRadius(LICORICE_RADIUS);

    const r = bondRadii(mesh);
    expect(r[0]).toBeCloseTo(LICORICE_RADIUS, 6);
    expect(r[1]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("reverts to per-order radii when radius is null", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_DOUBLE));
    mesh.setUniformRadius(LICORICE_RADIUS);
    mesh.setUniformRadius(null);

    const r = bondRadii(mesh);
    expect(r[0]).toBeCloseTo(DOUBLE_BOND_RADIUS, 6);
    expect(r[1]).toBeCloseTo(DOUBLE_BOND_RADIUS, 6);
  });

  it("keeps the licorice radius across a subsequent loadSnapshot", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));
    mesh.setUniformRadius(LICORICE_RADIUS);

    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));
    expect(bondRadii(mesh)[0]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("flags the radius attribute for re-upload", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));
    const attr = (mesh as unknown as { radiusAttr: { version: number } }).radiusAttr;
    const before = attr.version;
    mesh.setUniformRadius(LICORICE_RADIUS);
    expect(attr.version).toBeGreaterThan(before);
  });

  it("preserves base radii through a capacity grow", () => {
    // Capacity 1, but a double bond fans out to 2 visual instances → grow().
    const mesh = new ImpostorBondMesh(1);
    mesh.loadSnapshot(makeSnapshot(BOND_DOUBLE));
    // Defaults survive the reallocation.
    expect(bondRadii(mesh)[0]).toBeCloseTo(DOUBLE_BOND_RADIUS, 6);
    expect(bondRadii(mesh)[1]).toBeCloseTo(DOUBLE_BOND_RADIUS, 6);
    // And licorice override followed by revert still restores base radii.
    mesh.setUniformRadius(LICORICE_RADIUS);
    mesh.setUniformRadius(null);
    expect(bondRadii(mesh)[0]).toBeCloseTo(DOUBLE_BOND_RADIUS, 6);
    expect(bondRadii(mesh)[1]).toBeCloseTo(DOUBLE_BOND_RADIUS, 6);
  });
});
