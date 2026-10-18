import { describe, it, expect, vi } from "vitest";
import { applyViewportState } from "@/pipeline/apply";
import { DEFAULT_VIEWPORT_STATE, type ParticleData } from "@/pipeline/types";
import { NO_OVERRIDE } from "@/pipeline/colorWriter";
import type { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { Snapshot } from "@/types";

function makeSnapshot(nAtoms: number): Snapshot {
  return {
    nAtoms,
    nBonds: 0,
    positions: new Float32Array(nAtoms * 3),
    elements: new Uint8Array(nAtoms),
    bonds: new Uint32Array(),
    bondOrders: null,
  } as Snapshot;
}

function makeRendererStub() {
  return {
    setAtomsVisible: vi.fn(),
    setCellVisible: vi.fn(),
    setBondsVisible: vi.fn(),
    getOrCreateLayer: vi.fn(),
    removeInactiveLayers: vi.fn(),
    setPerspective: vi.fn(),
    setCellAxesVisible: vi.fn(),
    setPivotMarkerVisible: vi.fn(),
    setRepresentationType: vi.fn(),
    setRepresentationByAtom: vi.fn(),
    setLabels: vi.fn(),
    loadPolyhedra: vi.fn(),
    clearPolyhedra: vi.fn(),
    setVectors: vi.fn(),
    clearAtomOverrides: vi.fn(),
    setAtomScale: vi.fn(),
    setAtomOpacity: vi.fn(),
    setAtomScaleOverrides: vi.fn(),
    setAtomOpacityOverrides: vi.fn(),
    applyAtomColorOverrides: vi.fn(),
    updateBondsExt: vi.fn(),
    setBondScale: vi.fn(),
    setBondOpacity: vi.fn(),
    setBondOpacityOverrides: vi.fn(),
    clearBondOpacityOverrides: vi.fn(),
  };
}

function particle(
  indices: number[] | null,
  o: { scale?: number[]; opacity?: number[]; color?: number[] } = {},
): ParticleData {
  const n = 3;
  return {
    type: "particle",
    source: makeSnapshot(n),
    sourceNodeId: "loader",
    indices: indices ? new Uint32Array(indices) : null,
    scaleOverrides: o.scale ? new Float32Array(o.scale) : null,
    opacityOverrides: o.opacity ? new Float32Array(o.opacity) : null,
    colorOverrides: o.color ? new Float32Array(o.color) : null,
    representationOverride: null,
  };
}

function run(particles: ParticleData[]) {
  const renderer = makeRendererStub();
  applyViewportState(
    renderer as unknown as MoleculeRenderer,
    { ...DEFAULT_VIEWPORT_STATE, particles },
    null,
  );
  return renderer;
}

const N = NO_OVERRIDE;

describe("applyViewportState — whole-structure base, selections on top", () => {
  it("lets a selection restore scale 1.0 under a global 0.5", () => {
    // Global 0.5 (Quick Style) then a layer that inherited it and set its atom back to 1.0.
    const r = run([
      particle(null, { scale: [0.5, 0.5, 0.5] }),
      particle([1], { scale: [0.5, 1, 0.5] }),
    ]);
    const arg = r.setAtomScaleOverrides.mock.calls[0][0] as Float32Array;
    expect([...arg]).toEqual([0.5, 1, 0.5]);
  });

  it("applies a selection even when its stream comes before the whole-structure one", () => {
    const r = run([
      particle([0], { opacity: [0, 1, 1] }),
      particle(null, { opacity: [0.5, 0.5, 0.5] }),
    ]);
    const arg = r.setAtomOpacityOverrides.mock.calls[0][0] as Float32Array;
    expect([...arg]).toEqual([0, 0.5, 0.5]);
  });

  it("writes only the atoms a selection covers", () => {
    const r = run([
      particle(null, { scale: [0.5, 0.5, 0.5] }),
      particle([2], { scale: [2, 2, 2] }),
    ]);
    const arg = r.setAtomScaleOverrides.mock.calls[0][0] as Float32Array;
    expect([...arg]).toEqual([0.5, 0.5, 2]);
  });

  it("keeps the earlier color where a selection has none for its atom", () => {
    const r = run([
      particle(null, { color: [1, 0, 0, 1, 0, 0, 1, 0, 0] }),
      particle([0, 1], { color: [0, 0, 1, N, N, N, N, N, N] }),
    ]);
    const arg = r.applyAtomColorOverrides.mock.calls[0][0] as Float32Array;
    expect([...arg]).toEqual([0, 0, 1, 1, 0, 0, 1, 0, 0]);
  });

  it("still merges two whole-structure streams by non-default value", () => {
    const r = run([
      particle(null, { scale: [0.5, 1, 1], opacity: [1, 0.2, 1] }),
      particle(null, { scale: [1, 1, 3], opacity: [1, 1, 0.4] }),
    ]);
    expect([...(r.setAtomScaleOverrides.mock.calls[0][0] as Float32Array)]).toEqual([0.5, 1, 3]);
    const op = [...(r.setAtomOpacityOverrides.mock.calls[0][0] as Float32Array)];
    expect(op[0]).toBe(1);
    expect(op[1]).toBeCloseTo(0.2);
    expect(op[2]).toBeCloseTo(0.4);
  });
});
