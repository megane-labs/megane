import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { StructureLayer } from "@/renderer/StructureLayer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import type { Snapshot } from "@/types";
import { BYTE_DIGITS, rgbAt } from "./colorBytes";

function makeSnapshot(nBonds = 1): Snapshot {
  return {
    nAtoms: 2,
    nBonds,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: nBonds > 0 ? new Uint32Array([0, 1]) : new Uint32Array(),
    bondOrders: null,
  } as Snapshot;
}

function loadLayer(layer: StructureLayer, snapshot: Snapshot): void {
  layer.loadSnapshot(snapshot);
}

describe("StructureLayer.applyAtomColorOverrides", () => {
  it("delegates to ImpostorAtomMesh.applyColorOverrides and re-syncs bond colors", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);
    const snap = makeSnapshot();
    loadLayer(layer, snap);

    const atom = (layer as unknown as { atomRenderer: ImpostorAtomMesh }).atomRenderer;
    const bond = (layer as unknown as { bondRenderer: ImpostorBondMesh }).bondRenderer;
    const applySpy = vi.spyOn(atom, "applyColorOverrides");
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 0.9;
    overrides[1] = 0.1;
    overrides[2] = 0.1;

    layer.applyAtomColorOverrides(overrides);

    expect(applySpy).toHaveBeenCalledWith(overrides);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when called with the same override reference twice", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);
    loadLayer(layer, makeSnapshot());

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    layer.applyAtomColorOverrides(overrides);
    const atom = (layer as unknown as { atomRenderer: ImpostorAtomMesh }).atomRenderer;
    const applySpy = vi.spyOn(atom, "applyColorOverrides");

    layer.applyAtomColorOverrides(overrides);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("reverts to base CPK when null is passed after a previous override", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);
    loadLayer(layer, makeSnapshot());
    const atom = (layer as unknown as { atomRenderer: ImpostorAtomMesh }).atomRenderer;

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 0.9;
    overrides[1] = 0.1;
    overrides[2] = 0.1;
    layer.applyAtomColorOverrides(overrides);
    expect(rgbAt(atom.getColorBuffer(), 0)[0]).toBeCloseTo(0.9, BYTE_DIGITS);

    const loadSpy = vi.spyOn(atom, "loadSnapshot");
    layer.applyAtomColorOverrides(null);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    // Atom 0 reverted to base CPK (carbon ≠ 0.9 red).
    expect(rgbAt(atom.getColorBuffer(), 0)[0]).not.toBeCloseTo(0.9, BYTE_DIGITS);
  });

  it("re-applies the active overrides on the next loadSnapshot", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);
    const snap = makeSnapshot();
    loadLayer(layer, snap);

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 0.5;
    overrides[1] = 0.5;
    overrides[2] = 0.5;
    layer.applyAtomColorOverrides(overrides);

    // Load a fresh snapshot — overrides should be re-applied so the atom buffer
    // still reflects the gray override on atom 0.
    layer.loadSnapshot(makeSnapshot());
    const atom = (layer as unknown as { atomRenderer: ImpostorAtomMesh }).atomRenderer;
    expect(rgbAt(atom.getColorBuffer(), 0)[0]).toBeCloseTo(0.5, BYTE_DIGITS);
  });

  it("syncs bond colors after updateBondsExt when overrides are active", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);
    loadLayer(layer, makeSnapshot());

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 1;
    overrides[1] = 0;
    overrides[2] = 0;
    overrides[3] = 0;
    overrides[4] = 0;
    overrides[5] = 1;
    layer.applyAtomColorOverrides(overrides);

    const bond = (layer as unknown as { bondRenderer: ImpostorBondMesh }).bondRenderer;
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");

    layer.updateBondsExt(new Uint32Array([0, 1]), null, null, null, 0);
    expect(recomputeSpy).toHaveBeenCalledTimes(1);
  });

  it("skips bond color sync when the snapshot has no bonds", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);
    loadLayer(layer, makeSnapshot(0));

    const bond = (layer as unknown as { bondRenderer: ImpostorBondMesh }).bondRenderer;
    const recomputeSpy = vi.spyOn(bond, "recomputeColorsFromAtomBuffer");

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    overrides[0] = 1;
    overrides[1] = 0;
    overrides[2] = 0;
    layer.applyAtomColorOverrides(overrides);

    expect(recomputeSpy).not.toHaveBeenCalled();
  });

  it("applyAtomColorOverrides on an unloaded layer is a safe no-op", () => {
    const scene = new THREE.Scene();
    const layer = new StructureLayer("layer-1", scene);

    const overrides = new Float32Array(6);
    overrides.fill(NaN);
    expect(() => layer.applyAtomColorOverrides(overrides)).not.toThrow();
  });
});
