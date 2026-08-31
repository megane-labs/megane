/**
 * Regression: a color change must not wipe the per-atom state owned by other
 * layers.
 *
 * `applyAtomColorOverrides` resets the mesh to base CPK by calling
 * `ImpostorAtomMesh.loadSnapshot`, and that reload zeroes the per-atom scale,
 * opacity and hidden buffers. Before the fix, any pipeline carrying a `color`
 * node silently discarded the `modify` node's scale / opacity and the per-atom
 * representation split, because `applyParticleOverrides` runs before the color
 * pass in `applyViewportState`. The illustrative preset wires color and
 * representation together, so shrinking its spacefill spheres appeared to do
 * nothing at all.
 */

import { describe, it, expect } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import type { Snapshot } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    elements: new Uint8Array([6, 8, 6]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
  } as Snapshot;
}

function makeRenderer(): {
  renderer: MoleculeRenderer;
  atom: ImpostorAtomMesh;
  snapshot: Snapshot;
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
  return { renderer, atom, snapshot };
}

/** Per-atom effective scale the vertex shader multiplies the radius by. */
function effectiveScales(atom: ImpostorAtomMesh, nAtoms: number): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Array.from((atom as any).scaleOverrideBuf.subarray(0, nAtoms) as Float32Array);
}

function opacities(atom: ImpostorAtomMesh, nAtoms: number): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Array.from((atom as any).opacityOverrideBuf.subarray(0, nAtoms) as Float32Array);
}

function colorOverrides(): Float32Array {
  const buf = new Float32Array(9);
  buf.fill(NaN);
  buf[0] = 0.9;
  buf[1] = 0.1;
  buf[2] = 0.1;
  return buf;
}

describe("applyAtomColorOverrides preserves per-atom state", () => {
  it("keeps the Modify node's scale overrides across a color change", () => {
    const { renderer, atom } = makeRenderer();
    renderer.setAtomScaleOverrides(new Float32Array([0.5, 0.5, 0.5]));
    expect(effectiveScales(atom, 3)).toEqual([0.5, 0.5, 0.5]);

    renderer.applyAtomColorOverrides(colorOverrides());

    expect(effectiveScales(atom, 3)).toEqual([0.5, 0.5, 0.5]);
  });

  it("keeps per-atom opacity overrides across a color change", () => {
    const { renderer, atom } = makeRenderer();
    renderer.setAtomOpacityOverrides(new Float32Array([1, 0.25, 1]));

    renderer.applyAtomColorOverrides(colorOverrides());

    expect(opacities(atom, 3)).toEqual([1, 0.25, 1]);
  });

  it("keeps the per-atom representation hidden mask across a color change", () => {
    const { renderer, atom } = makeRenderer();
    // Atom 1 drawn by the line renderer, so the mesh must keep it collapsed.
    renderer.setRepresentationByAtom(["atoms", "line", "atoms"]);
    expect(effectiveScales(atom, 3)[1]).toBe(0);

    renderer.applyAtomColorOverrides(colorOverrides());

    expect(effectiveScales(atom, 3)[1]).toBe(0);
  });

  it("composites a restored hidden mask on top of restored scale overrides", () => {
    const { renderer, atom } = makeRenderer();
    renderer.setAtomScaleOverrides(new Float32Array([0.5, 0.5, 0.5]));
    renderer.setRepresentationByAtom(["atoms", "line", "atoms"]);

    renderer.applyAtomColorOverrides(colorOverrides());

    // Visible atoms keep the Modify scale; the hidden one stays collapsed.
    expect(effectiveScales(atom, 3)).toEqual([0.5, 0, 0.5]);
  });

  it("leaves the reloaded defaults alone when nothing was overridden", () => {
    const { renderer, atom } = makeRenderer();

    renderer.applyAtomColorOverrides(colorOverrides());

    expect(effectiveScales(atom, 3)).toEqual([1, 1, 1]);
    expect(opacities(atom, 3)).toEqual([1, 1, 1]);
  });

  it("still restores overrides when the color pass reverts to base CPK", () => {
    const { renderer, atom } = makeRenderer();
    renderer.applyAtomColorOverrides(colorOverrides());
    renderer.setAtomScaleOverrides(new Float32Array([0.25, 0.25, 0.25]));

    // null = "no color node upstream any more", which reloads the snapshot too.
    renderer.applyAtomColorOverrides(null);

    expect(effectiveScales(atom, 3)).toEqual([0.25, 0.25, 0.25]);
  });
});
