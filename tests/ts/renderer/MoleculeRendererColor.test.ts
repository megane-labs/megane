import { describe, it, expect, vi } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import type { Snapshot } from "@/types";
import { BYTE_DIGITS, rgbAt } from "./colorBytes";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
  } as Snapshot;
}

/**
 * Build a renderer that has snapshot + atom mesh + bond mesh attached, but
 * skip the WebGL-dependent mount() pipeline. Direct field access is the
 * convention shared with MoleculeRendererCamera.test.ts.
 */
function makeRendererWithMeshes(): {
  renderer: MoleculeRenderer;
  atom: ImpostorAtomMesh;
  bond: ImpostorBondMesh;
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
  return { renderer, atom, bond, snapshot };
}

describe("MoleculeRenderer.applyAtomColorOverrides", () => {
  it("applies overrides to the atom mesh and re-syncs bond colors", () => {
    const { renderer, atom, bond } = makeRendererWithMeshes();
    const applySpy = vi.spyOn(atom, "applyColorOverrides");
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 0.9;
    overrides[1] = 0.1;
    overrides[2] = 0.1;
    renderer.applyAtomColorOverrides(overrides);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith(overrides);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);

    // Atom 0 buffer now reflects the override.
    expect(rgbAt(atom.getColorBuffer(), 0)[0]).toBeCloseTo(0.9, BYTE_DIGITS);
  });

  it("is a no-op when called with the same override reference twice", () => {
    const { renderer, atom } = makeRendererWithMeshes();
    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[3] = 0.5;
    overrides[4] = 0.5;
    overrides[5] = 0.5;

    renderer.applyAtomColorOverrides(overrides);
    const applySpy = vi.spyOn(atom, "applyColorOverrides");
    renderer.applyAtomColorOverrides(overrides);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("reverts to base CPK when null is passed after a previous override", () => {
    const { renderer, atom, snapshot } = makeRendererWithMeshes();
    const baseR = atom.getColorBuffer()[0];

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 0.9;
    overrides[1] = 0.1;
    overrides[2] = 0.1;
    renderer.applyAtomColorOverrides(overrides);
    expect(rgbAt(atom.getColorBuffer(), 0)[0]).toBeCloseTo(0.9, BYTE_DIGITS);

    const loadSpy = vi.spyOn(atom, "loadSnapshot");
    renderer.applyAtomColorOverrides(null);
    expect(loadSpy).toHaveBeenCalledWith(snapshot);
    expect(atom.getColorBuffer()[0]).toBe(baseR);
  });

  it("skips bond sync when the snapshot has no bonds", () => {
    const renderer = new MoleculeRenderer();
    const snapshot = {
      nAtoms: 2,
      nBonds: 0,
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      elements: new Uint8Array([6, 8]),
      bonds: new Uint32Array(),
      bondOrders: null,
    } as Snapshot;
    const atom = new ImpostorAtomMesh(8);
    atom.loadSnapshot(snapshot);
    const bond = new ImpostorBondMesh(16);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    internals.snapshot = snapshot;
    internals.atomRenderer = atom;
    internals.bondRenderer = bond;

    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");
    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 1;
    overrides[1] = 0;
    overrides[2] = 0;

    renderer.applyAtomColorOverrides(overrides);
    expect(recomputeSpy).not.toHaveBeenCalled();
  });

  it("re-syncs bond colors when updateBondsExt rewrites the bond mesh under active overrides", () => {
    const { renderer, atom, bond, snapshot } = makeRendererWithMeshes();
    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 1;
    overrides[1] = 0;
    overrides[2] = 0;
    overrides[3] = 0;
    overrides[4] = 0;
    overrides[5] = 1;
    renderer.applyAtomColorOverrides(overrides);

    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");
    renderer.updateBondsExt(snapshot.bonds, null, null, null, snapshot.nAtoms);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    // After the bond rewrite, atom 0's override is still red — bond mesh should
    // see the updated atom color buffer.
    expect(rgbAt(atom.getColorBuffer(), 0)[0]).toBe(1);
  });

  it("hands each PBC ghost's source atom to the bond color sync (GaN stubs)", () => {
    const { renderer, bond, snapshot } = makeRendererWithMeshes();
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");
    // Two half-bonds to ghosts 2 and 3, copies of atoms 1 and 0.
    const bonds = new Uint32Array([0, 2, 1, 3]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, -1, 0, 0, 2, 0, 0]);
    const elements = new Uint8Array([6, 8, 8, 6]);
    const sources = new Uint32Array([1, 0]);

    renderer.updateBondsExt(bonds, null, positions, elements, 4, null, sources);
    expect(recomputeSpy).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), sources);

    // An image map names the sources too when no explicit list is given.
    const imageMap = { sourceIndices: new Uint32Array([1, 0]), latticeShifts: new Int32Array(6) };
    renderer.updateBondsExt(bonds, null, positions, elements, 4, imageMap);
    expect(recomputeSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      imageMap.sourceIndices,
    );

    // A recolor afterwards still reaches the stubs.
    renderer.applyAtomColorOverrides(new Float32Array([1, 0, 0, 0, 0, 1]));
    expect(recomputeSpy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      imageMap.sourceIndices,
    );

    // A list that does not match the ghost count, or bonds without ghosts,
    // name nothing.
    renderer.updateBondsExt(bonds, null, positions, elements, 4, null, new Uint32Array([1]));
    expect(recomputeSpy).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), null);
    renderer.updateBondsExt(bonds, null, positions, elements, 4, null, sources);
    renderer.updateBonds(snapshot.bonds, null);
    expect(recomputeSpy).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), null);
  });

  it("counts ghosts after a heterogeneous frame's own atoms", () => {
    const { renderer, bond } = makeRendererWithMeshes();
    // The frame on screen grew to 3 atoms; its distance bonds reach 2 ghosts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (renderer as any).frameTopology = { ...makeSnapshot(), nAtoms: 3 };
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");
    const sources = new Uint32Array([2, 0]);
    renderer.updateBondsExt(
      new Uint32Array([0, 3, 2, 4]),
      null,
      new Float32Array(15),
      new Uint8Array([6, 8, 18, 18, 6]),
      5,
      null,
      sources,
    );
    expect(recomputeSpy).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), sources);
  });

  it("keeps the ghost sources of bonds pushed before the snapshot existed", () => {
    const renderer = new MoleculeRenderer();
    const sources = new Uint32Array([1, 0]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, -1, 0, 0, 2, 0, 0]);
    renderer.updateBondsExt(
      new Uint32Array([0, 2, 1, 3]),
      null,
      positions,
      new Uint8Array([6, 8, 8, 6]),
      4,
      null,
      sources,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = renderer as any;
    expect(internals.pendingBonds.ghostSources).toBe(sources);

    const snapshot = makeSnapshot();
    const atom = new ImpostorAtomMesh(8);
    atom.loadSnapshot(snapshot);
    const bond = new ImpostorBondMesh(16);
    bond.loadSnapshot(snapshot);
    internals.snapshot = snapshot;
    internals.atomRenderer = atom;
    internals.bondRenderer = bond;
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");
    internals.flushPendingBonds();
    expect(recomputeSpy).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), sources);
  });

  it("re-syncs bond colors when updateBonds rewrites topology under active overrides", () => {
    const { renderer, bond, snapshot } = makeRendererWithMeshes();
    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 0;
    overrides[1] = 1;
    overrides[2] = 0;
    renderer.applyAtomColorOverrides(overrides);

    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");
    renderer.updateBonds(snapshot.bonds, null);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
  });

  it("applyAtomColorOverrides on a renderer without snapshot is a safe no-op", () => {
    const renderer = new MoleculeRenderer();
    const overrides = new Float32Array(3);
    overrides.fill(NaN);
    expect(() => renderer.applyAtomColorOverrides(overrides)).not.toThrow();
  });
});
