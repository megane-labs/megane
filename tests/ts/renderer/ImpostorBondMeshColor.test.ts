import { describe, it, expect } from "vitest";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import { BOND_DOUBLE, BOND_TRIPLE, BOND_AROMATIC, BOND_SINGLE, getColor } from "@/constants";
import type { Snapshot } from "@/types";
import { BYTE_DIGITS, rgbAt, rgba8 } from "./colorBytes";

function makeSnapshot(bondOrder: number = BOND_SINGLE): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    positions: rgba8([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: bondOrder === BOND_SINGLE ? null : new Uint8Array([bondOrder]),
  } as Snapshot;
}

/** Endpoint colors of each visual instance, as [0, 1] RGB. */
function buffers(mesh: ImpostorBondMesh): {
  a: (i: number) => [number, number, number];
  b: (i: number) => [number, number, number];
} {
  const m = mesh as unknown as { colorABuf: Uint8ClampedArray; colorBBuf: Uint8ClampedArray };
  return { a: (i) => rgbAt(m.colorABuf, i), b: (i) => rgbAt(m.colorBBuf, i) };
}

function expectRgb(got: [number, number, number], want: readonly number[]): void {
  for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c], BYTE_DIGITS);
}

describe("ImpostorBondMesh.recomputeColorsFromAtomBuffer", () => {
  it("stores each endpoint color on its own half for a single bond", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));

    // Atom 0 = red, atom 1 = blue
    const atomColors = rgba8([1, 0, 0, 0, 0, 1]);
    mesh.recomputeColorsFromAtomBuffer(atomColors, makeSnapshot(BOND_SINGLE));

    const { a, b } = buffers(mesh);
    // Single bond → 1 instance. A half = atom 0 (red), B half = atom 1 (blue).
    expect(a(0)).toEqual([1, 0, 0]);
    expect(b(0)).toEqual([0, 0, 1]);
  });

  it("paints all double-bond instances with the same split colors", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_DOUBLE));

    const atomColors = rgba8([1, 1, 0, 0, 1, 1]);
    mesh.recomputeColorsFromAtomBuffer(atomColors, makeSnapshot(BOND_DOUBLE));

    const { a, b } = buffers(mesh);
    // BOND_DOUBLE fans out to 2 visual instances
    for (let inst = 0; inst < 2; inst++) {
      expect(a(inst)).toEqual([1, 1, 0]);
      expect(b(inst)).toEqual([0, 1, 1]);
    }
  });

  it("paints all triple-bond instances with the same split colors", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_TRIPLE));

    const atomColors = rgba8([0.2, 0.4, 0.6, 0.8, 0.6, 0.4]);
    mesh.recomputeColorsFromAtomBuffer(atomColors, makeSnapshot(BOND_TRIPLE));

    const { a, b } = buffers(mesh);
    for (let inst = 0; inst < 3; inst++) {
      expectRgb(a(inst), [0.2, 0.4, 0.6]);
      expectRgb(b(inst), [0.8, 0.6, 0.4]);
    }
  });

  it("paints both aromatic-bond instances with the split colors", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_AROMATIC));

    const atomColors = rgba8([1, 0, 0, 0, 1, 0]);
    mesh.recomputeColorsFromAtomBuffer(atomColors, makeSnapshot(BOND_AROMATIC));

    const { a, b } = buffers(mesh);
    for (let inst = 0; inst < 2; inst++) {
      expect(a(inst)).toEqual([1, 0, 0]);
      expect(b(inst)).toEqual([0, 1, 0]);
    }
  });

  it("bumps both color attributes' versions so the GPU buffers re-upload", () => {
    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));
    const m = mesh as unknown as {
      colorAAttr: { version: number };
      colorBAttr: { version: number };
    };
    const beforeA = m.colorAAttr.version;
    const beforeB = m.colorBAttr.version;

    const atomColors = rgba8([1, 0, 0, 0, 0, 1]);
    mesh.recomputeColorsFromAtomBuffer(atomColors, makeSnapshot(BOND_SINGLE));

    expect(m.colorAAttr.version).toBeGreaterThan(beforeA);
    expect(m.colorBAttr.version).toBeGreaterThan(beforeB);
  });

  it("colors a ghost endpoint from its element instead of black (PBC stub)", () => {
    // Extended snapshot: 2 real atoms + 1 ghost (a Carbon copy, Z=6) appended
    // at index 2. The half-bond connects real atom 1 (Oxygen) to the ghost.
    const extSnap = {
      nAtoms: 3,
      nBonds: 1,
      positions: rgba8([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      elements: new Uint8Array([6, 8, 6]),
      bonds: new Uint32Array([1, 2]),
      bondOrders: null,
    } as Snapshot;

    const mesh = new ImpostorBondMesh(16);
    mesh.loadSnapshot(extSnap);

    // Atom color buffer only covers the 2 real atoms (no ghost entry).
    const atomColors = rgba8([1, 0, 0, 0, 1, 0]);
    mesh.recomputeColorsFromAtomBuffer(atomColors, extSnap);

    const { a, b } = buffers(mesh);
    // A half = real atom 1's color from the atom buffer (green).
    expect(a(0)).toEqual([0, 1, 0]);
    // B half = ghost (Z=6) element color, not black.
    expectRgb(b(0), getColor(6));
  });
});

describe("ImpostorBondMesh.loadSnapshot split coloring", () => {
  it("derives each half from its endpoint element color (no color context)", () => {
    const mesh = new ImpostorBondMesh(16);
    // Carbon (Z=6) — Oxygen (Z=8) single bond.
    mesh.loadSnapshot(makeSnapshot(BOND_SINGLE));

    const { a, b } = buffers(mesh);
    expectRgb(a(0), getColor(6));
    expectRgb(b(0), getColor(8));
  });
});
