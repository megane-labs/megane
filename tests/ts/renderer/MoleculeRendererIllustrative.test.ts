/**
 * Illustrative representation (Mol* parity) coverage.
 *
 * The mode draws spacefill spheres at the full van der Waals radius with flat,
 * unlit shading and a silhouette outline, and hides the bond sticks the touching
 * spheres would swallow anyway.
 */

import { describe, it, expect } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import {
  BALL_STICK_ATOM_SCALE,
  LICORICE_RADIUS,
  SPACEFILL_ATOM_SCALE,
  getRadius,
} from "@/constants";
import type { Snapshot } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    // Carbon (Z=6) — Oxygen (Z=8): distinct vdW radii, so a spacefill switch is
    // visible per element rather than collapsing to one radius.
    nAtoms: 2,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
  } as Snapshot;
}

function makeRendererWithMeshes(): {
  renderer: MoleculeRenderer;
  atom: ImpostorAtomMesh;
  bond: ImpostorBondMesh;
  atomRadii: () => Float32Array;
  illustrativeUniform: () => number;
} {
  const renderer = new MoleculeRenderer();
  const snapshot = makeSnapshot();
  const atom = new ImpostorAtomMesh(8);
  atom.loadSnapshot(snapshot);
  const bond = new ImpostorBondMesh(16);
  bond.loadSnapshot(snapshot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.snapshot = snapshot;
  internals.atomRenderer = atom;
  internals.bondRenderer = bond;
  return {
    renderer,
    atom,
    bond,
    atomRadii: () => (atom as unknown as { radiusBuf: Float32Array }).radiusBuf,
    illustrativeUniform: () =>
      (
        atom as unknown as {
          material: { uniforms: { uIllustrative: { value: number } } };
        }
      ).material.uniforms.uIllustrative.value,
  };
}

describe("MoleculeRenderer — illustrative representation", () => {
  it("shows atoms and hides bonds", () => {
    const { renderer, atom, bond } = makeRendererWithMeshes();
    renderer.setBondsVisible(true);
    renderer.setRepresentationType("illustrative");
    expect(atom.mesh.visible).toBe(true);
    expect(bond.mesh.visible).toBe(false);
  });

  it("keeps bonds hidden when bond availability is re-announced", () => {
    // setBondsVisible runs on every pipeline execution; it must not resurrect
    // the sticks that the illustrative mode deliberately switched off.
    const { renderer, bond } = makeRendererWithMeshes();
    renderer.setRepresentationType("illustrative");
    renderer.setBondsVisible(true);
    expect(bond.mesh.visible).toBe(false);
  });

  it("grows atoms to their full van der Waals radius", () => {
    const { renderer, atomRadii } = makeRendererWithMeshes();
    renderer.setRepresentationType("illustrative");
    const r = atomRadii();
    expect(r[0]).toBeCloseTo(getRadius(6) * SPACEFILL_ATOM_SCALE, 6);
    expect(r[1]).toBeCloseTo(getRadius(8) * SPACEFILL_ATOM_SCALE, 6);
    // Per-element proportions survive the switch (unlike licorice).
    expect(r[0]).not.toBeCloseTo(r[1], 6);
  });

  it("enables flat unlit shading only in illustrative mode", () => {
    const { renderer, illustrativeUniform } = makeRendererWithMeshes();
    expect(illustrativeUniform()).toBe(0);
    renderer.setRepresentationType("illustrative");
    expect(illustrativeUniform()).toBe(1);
    renderer.setRepresentationType("atoms");
    expect(illustrativeUniform()).toBe(0);
  });

  it("restores ball-and-stick radii and bonds when switching back", () => {
    const { renderer, bond, atomRadii } = makeRendererWithMeshes();
    renderer.setBondsVisible(true);
    renderer.setRepresentationType("illustrative");
    renderer.setRepresentationType("atoms");

    const r = atomRadii();
    expect(r[0]).toBeCloseTo(getRadius(6) * BALL_STICK_ATOM_SCALE, 6);
    expect(r[1]).toBeCloseTo(getRadius(8) * BALL_STICK_ATOM_SCALE, 6);
    expect(bond.mesh.visible).toBe(true);
  });

  it("lets licorice's uniform radius win over the spacefill scale", () => {
    // Both knobs write the same buffer; the licorice radius is the more
    // specific one and must not be overwritten by the vdW fraction.
    const { renderer, atomRadii } = makeRendererWithMeshes();
    renderer.setRepresentationType("illustrative");
    renderer.setRepresentationType("licorice");
    const r = atomRadii();
    expect(r[0]).toBeCloseTo(LICORICE_RADIUS, 6);
    expect(r[1]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("scales picking and selection highlights with the spacefill radius", () => {
    // Picking and the highlight spheres both size themselves off this: a
    // ball-and-stick radius would leave most of a spacefill sphere unclickable
    // and bury the highlight inside the atom.
    const { renderer } = makeRendererWithMeshes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    renderer.setRepresentationType("illustrative");
    expect(internals.atomRadiusScale()).toBeCloseTo(SPACEFILL_ATOM_SCALE, 6);
    renderer.setRepresentationType("atoms");
    expect(internals.atomRadiusScale()).toBeCloseTo(BALL_STICK_ATOM_SCALE, 6);
  });
});
