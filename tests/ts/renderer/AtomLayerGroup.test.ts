/**
 * AtomLayerGroup unit coverage: every setter records its value, fans out to
 * the primary renderer and every existing secondary layer, and a secondary
 * layer created later starts from the full recorded state.
 */

import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { AtomLayerGroup } from "@/renderer/AtomLayerGroup";
import { DrawingBoundaryAtomRenderer } from "@/renderer/CellBoundaryAtomRenderer";
import { representationFlags, type RepresentationType } from "@/renderer/representation";
import { BALL_STICK_ATOM_SCALE, LICORICE_RADIUS, SPACEFILL_ATOM_SCALE } from "@/constants";
import type { AtomRenderer, Snapshot } from "@/types";
import type { PeriodicAtomImageData } from "@/pipeline/types";

function snapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array(),
    bondOrders: null,
    box: new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 2]),
  } as Snapshot;
}

function images(): PeriodicAtomImageData {
  return {
    positions: new Float32Array([3, 1, 1]),
    elements: new Uint8Array([8]),
    sourceIndices: new Uint32Array([1]),
    latticeShifts: new Int32Array([1, 0, 0]),
  };
}

/** A primary renderer whose optional methods are all spies. */
function fakePrimary() {
  const mesh = new THREE.Object3D();
  return {
    mesh,
    loadSnapshot: vi.fn(),
    updatePositions: vi.fn(),
    setScale: vi.fn(),
    setUniformRadius: vi.fn(),
    setRadiusScale: vi.fn(),
    setIllustrative: vi.fn(),
    setOpacity: vi.fn(),
    setScaleOverrides: vi.fn(),
    setOpacityOverrides: vi.fn(),
    clearOverrides: vi.fn(),
    dispose: vi.fn(),
  } satisfies AtomRenderer;
}

type LayerInternals = {
  scale: number;
  opacity: number;
  radiusScale: number;
  uniformRadius: number | null;
  illustrative: boolean;
  scaleOverrides: Float32Array | null;
  opacityOverrides: Float32Array | null;
  colorOverrides: Float32Array | null;
  hiddenMask: Uint8Array | null;
};

function internals(layer: DrawingBoundaryAtomRenderer | null): LayerInternals {
  expect(layer).toBeInstanceOf(DrawingBoundaryAtomRenderer);
  return layer as unknown as LayerInternals;
}

describe("AtomLayerGroup — secondary layer lifecycle", () => {
  it("creates each secondary layer lazily and attaches it once", () => {
    const attach = vi.fn();
    const group = new AtomLayerGroup(attach);
    expect(group.peekSecondary("drawingBoundary")).toBeNull();
    expect(group.peekSecondary("bondPeriodic")).toBeNull();

    group.loadBondPeriodicImages(snapshot(), images());
    const periodic = group.peekSecondary("bondPeriodic");
    expect(periodic?.count).toBe(1);
    expect(group.peekSecondary("drawingBoundary")).toBeNull();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(periodic!.group);

    group.loadBondPeriodicImages(snapshot(), null);
    expect(group.peekSecondary("bondPeriodic")).toBe(periodic);
    expect(periodic!.count).toBe(0);
    expect(attach).toHaveBeenCalledTimes(1);

    group.loadDrawingBoundary(snapshot(), null);
    expect(group.peekSecondary("drawingBoundary")).not.toBeNull();
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("replays the full recorded state onto a layer created later", () => {
    const group = new AtomLayerGroup(() => {});
    const scaleOverrides = new Float32Array([1, 2]);
    const opacityOverrides = new Float32Array([1, 0.5]);
    const colors = new Float32Array([NaN, NaN, NaN, 0, 1, 0]);
    const mask = new Uint8Array([0, 1]);
    group.setScale(1.5, null);
    group.setOpacity(0.7);
    group.setScaleOverrides(scaleOverrides);
    group.setOpacityOverrides(opacityOverrides);
    group.setColorOverrides(colors);
    group.setSecondaryHiddenMask(mask);
    group.setRepresentation("illustrative", null);
    group.setVisible(false);

    group.loadBondPeriodicImages(snapshot(), images());

    const layer = group.peekSecondary("bondPeriodic")!;
    const s = internals(layer);
    expect(s.scale).toBe(1.5);
    expect(s.opacity).toBe(0.7);
    expect(s.radiusScale).toBe(SPACEFILL_ATOM_SCALE);
    expect(s.uniformRadius).toBeNull();
    expect(s.illustrative).toBe(true);
    expect(s.scaleOverrides).toBe(scaleOverrides);
    expect(s.opacityOverrides).toBe(opacityOverrides);
    expect(s.colorOverrides).toBe(colors);
    expect(s.hiddenMask).toBe(mask);
    expect(layer.group.visible).toBe(false);
  });

  it("starts layers at ball-and-stick defaults", () => {
    const group = new AtomLayerGroup(() => {});
    group.loadDrawingBoundary(snapshot(), null);
    const layer = group.peekSecondary("drawingBoundary")!;
    const s = internals(layer);
    expect(s.scale).toBe(1);
    expect(s.opacity).toBe(1);
    expect(s.radiusScale).toBe(BALL_STICK_ATOM_SCALE);
    expect(s.illustrative).toBe(false);
    expect(s.scaleOverrides).toBeNull();
    expect(layer.group.visible).toBe(true);
    expect(group.state).toMatchObject({
      scale: 1,
      opacity: 1,
      radiusScale: BALL_STICK_ATOM_SCALE,
      uniformRadius: null,
      illustrative: false,
      visible: true,
    });
  });

  it("disposes the primary and every secondary layer", () => {
    const group = new AtomLayerGroup(() => {});
    const primary = fakePrimary();
    group.setPrimary(primary);
    group.loadDrawingBoundary(snapshot(), null);
    group.loadBondPeriodicImages(snapshot(), images());
    const boundary = group.peekSecondary("drawingBoundary")!;
    const periodic = group.peekSecondary("bondPeriodic")!;
    const boundaryDispose = vi.spyOn(boundary, "dispose");
    const periodicDispose = vi.spyOn(periodic, "dispose");

    group.dispose();

    expect(primary.dispose).toHaveBeenCalledTimes(1);
    expect(boundaryDispose).toHaveBeenCalledTimes(1);
    expect(periodicDispose).toHaveBeenCalledTimes(1);
    expect(group.primary).toBeNull();
    expect(group.peekSecondary("drawingBoundary")).toBeNull();
    // A second dispose is a no-op.
    group.dispose();
    expect(primary.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("AtomLayerGroup — fan-out to the primary and existing layers", () => {
  function setup() {
    const group = new AtomLayerGroup(() => {});
    const primary = fakePrimary();
    group.setPrimary(primary);
    group.loadDrawingBoundary(snapshot(), null);
    group.loadBondPeriodicImages(snapshot(), images());
    const layers = [group.peekSecondary("drawingBoundary")!, group.peekSecondary("bondPeriodic")!];
    return { group, primary, layers };
  }

  it("exposes the adopted primary", () => {
    const { group, primary } = setup();
    expect(group.primary).toBe(primary);
    group.setPrimary(null);
    expect(group.primary).toBeNull();
  });

  it("rescales the primary only when a snapshot is supplied", () => {
    const { group, primary, layers } = setup();
    group.setScale(2, null);
    expect(primary.setScale).not.toHaveBeenCalled();
    const snap = snapshot();
    group.setScale(3, snap);
    expect(primary.setScale).toHaveBeenCalledWith(3, snap);
    for (const layer of layers) expect(internals(layer).scale).toBe(3);
    expect(group.state.scale).toBe(3);
  });

  it("fans out opacity and per-atom overrides", () => {
    const { group, primary, layers } = setup();
    const scale = new Float32Array([1, 2]);
    const opacity = new Float32Array([0.5, 1]);
    group.setOpacity(0.4);
    group.setScaleOverrides(scale);
    group.setOpacityOverrides(opacity);
    expect(primary.setOpacity).toHaveBeenCalledWith(0.4);
    expect(primary.setScaleOverrides).toHaveBeenCalledWith(scale);
    expect(primary.setOpacityOverrides).toHaveBeenCalledWith(opacity);
    for (const layer of layers) {
      expect(internals(layer).opacity).toBe(0.4);
      expect(internals(layer).scaleOverrides).toBe(scale);
      expect(internals(layer).opacityOverrides).toBe(opacity);
    }

    group.clearOverrides();
    expect(primary.clearOverrides).toHaveBeenCalledTimes(1);
    expect(group.state.scaleOverrides).toBeNull();
    expect(group.state.opacityOverrides).toBeNull();
    for (const layer of layers) {
      expect(internals(layer).scaleOverrides).toBeNull();
      expect(internals(layer).opacityOverrides).toBeNull();
    }
  });

  it("repaints only the secondary layers on a colour change", () => {
    const { group, primary, layers } = setup();
    const colors = new Float32Array([1, 0, 0, 0, 0, 1]);
    group.setColorOverrides(colors);
    expect(group.state.colorOverrides).toBe(colors);
    for (const layer of layers) expect(internals(layer).colorOverrides).toBe(colors);
    expect(primary.loadSnapshot).not.toHaveBeenCalled();
  });

  it("masks only the secondary layers", () => {
    const { group, layers } = setup();
    const mask = new Uint8Array([1, 0]);
    group.setSecondaryHiddenMask(mask);
    expect(group.state.secondaryHiddenMask).toBe(mask);
    for (const layer of layers) expect(internals(layer).hiddenMask).toBe(mask);
  });

  it("shows and hides every layer together", () => {
    const { group, primary, layers } = setup();
    group.setVisible(false);
    expect(primary.mesh.visible).toBe(false);
    for (const layer of layers) expect(layer.group.visible).toBe(false);
    group.setVisible(true);
    expect(primary.mesh.visible).toBe(true);
    for (const layer of layers) expect(layer.group.visible).toBe(true);
  });

  it("tolerates setters before any renderer exists", () => {
    const group = new AtomLayerGroup(() => {});
    group.setScale(2, snapshot());
    group.setOpacity(0.5);
    group.setScaleOverrides(new Float32Array([1]));
    group.setOpacityOverrides(new Float32Array([1]));
    group.clearOverrides();
    group.setColorOverrides(null);
    group.setSecondaryHiddenMask(null);
    group.setRepresentation("licorice", snapshot());
    group.setVisible(false);
    expect(group.state).toMatchObject({ scale: 2, opacity: 0.5, visible: false });
    expect(group.state.uniformRadius).toBe(LICORICE_RADIUS);
  });
});

describe("AtomLayerGroup — representation", () => {
  it("applies radius, shading and visibility to every layer", () => {
    const group = new AtomLayerGroup(() => {});
    const primary = fakePrimary();
    group.setPrimary(primary);
    group.loadBondPeriodicImages(snapshot(), images());
    const layer = group.peekSecondary("bondPeriodic")!;
    const snap = snapshot();

    group.setRepresentation("licorice", snap);
    expect(primary.setRadiusScale).toHaveBeenCalledWith(BALL_STICK_ATOM_SCALE, snap);
    expect(primary.setUniformRadius).toHaveBeenCalledWith(LICORICE_RADIUS, snap);
    expect(primary.setIllustrative).toHaveBeenLastCalledWith(false);
    expect(internals(layer).uniformRadius).toBe(LICORICE_RADIUS);
    expect(primary.mesh.visible).toBe(true);

    group.setRepresentation("illustrative", snap);
    expect(primary.setRadiusScale).toHaveBeenLastCalledWith(SPACEFILL_ATOM_SCALE, snap);
    expect(primary.setUniformRadius).toHaveBeenLastCalledWith(null, snap);
    expect(primary.setIllustrative).toHaveBeenLastCalledWith(true);
    expect(internals(layer).radiusScale).toBe(SPACEFILL_ATOM_SCALE);
    expect(internals(layer).illustrative).toBe(true);
    expect(layer.group.visible).toBe(true);

    group.setRepresentation("cartoon", snap);
    expect(primary.mesh.visible).toBe(false);
    expect(layer.group.visible).toBe(false);
  });

  it("leaves the primary's radii alone without a snapshot", () => {
    const group = new AtomLayerGroup(() => {});
    const primary = fakePrimary();
    group.setPrimary(primary);
    group.setRepresentation("illustrative", null);
    expect(primary.setRadiusScale).not.toHaveBeenCalled();
    expect(primary.setUniformRadius).not.toHaveBeenCalled();
    expect(primary.setIllustrative).toHaveBeenCalledWith(true);
    expect(group.state.radiusScale).toBe(SPACEFILL_ATOM_SCALE);
  });
});

describe("representationFlags", () => {
  const cases: [RepresentationType, Partial<ReturnType<typeof representationFlags>>][] = [
    ["atoms", { showAtoms: true, showBonds: true, showCartoon: false, illustrative: false }],
    ["both", { showAtoms: true, showBonds: true, showCartoon: true }],
    ["licorice", { showAtoms: true, showBonds: true, uniformRadius: LICORICE_RADIUS }],
    [
      "illustrative",
      {
        showAtoms: true,
        showBonds: false,
        illustrative: true,
        atomRadiusScale: SPACEFILL_ATOM_SCALE,
        uniformRadius: null,
      },
    ],
    ["cartoon", { showAtoms: false, showBonds: false, showCartoon: true }],
    ["surface", { showAtoms: false, showSurface: true, showLine: false }],
    ["line", { showAtoms: false, showBonds: false, showLine: true }],
  ];

  it.each(cases)("%s", (type, expected) => {
    expect(representationFlags(type)).toMatchObject(expected);
  });

  it("uses ball-and-stick radii outside illustrative mode", () => {
    for (const type of ["atoms", "both", "licorice", "cartoon", "surface", "line"] as const) {
      expect(representationFlags(type).atomRadiusScale).toBe(BALL_STICK_ATOM_SCALE);
    }
  });
});
