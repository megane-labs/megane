/**
 * The two display-only atom layers — Drawing Boundary copies and the periodic
 * neighbour images a bond stream adds — must always look like the structural
 * atoms they mirror. They are created lazily (on the first snapshot, boundary
 * or periodic-image push), so every representation setting applied before they
 * existed has to be replayed onto them, and no later reload may re-derive their
 * visibility from a different rule than the main atom mesh uses.
 *
 * Regression: in illustrative mode a reload or a boundary / periodic-image
 * change hid the periodic copies (their visibility test omitted
 * "illustrative") while the main atoms stayed visible, and newly created
 * layers never received the spacefill radius scale, the licorice radius, or the
 * flat illustrative shading.
 */

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import type { DrawingBoundaryAtomRenderer } from "@/renderer/CellBoundaryAtomRenderer";
import type { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { generateDrawingBoundaryImages } from "@/logic/cellBoundaryImages";
import {
  BALL_STICK_ATOM_SCALE,
  LICORICE_RADIUS,
  SPACEFILL_ATOM_SCALE,
  getRadius,
} from "@/constants";
import type { Snapshot } from "@/types";
import type { PeriodicAtomImageData } from "@/pipeline/types";

/** One carbon on the cell origin (so it has boundary copies) and one oxygen inside. */
function makeCellSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 0,
    nFileBonds: 0,
    positions: new Float32Array([0, 0, 0, 2, 2, 2]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array(),
    bondOrders: null,
    box: new Float32Array([4, 0, 0, 0, 4, 0, 0, 0, 4]),
    boxOrigin: null,
  } as Snapshot;
}

function periodicImages(): PeriodicAtomImageData {
  return {
    positions: new Float32Array([-2, 2, 2]),
    elements: new Uint8Array([8]),
    sourceIndices: new Uint32Array([1]),
    latticeShifts: new Int32Array([-1, 0, 0]),
  };
}

/** A renderer that never mounted: stub the scene/camera the real canvas would create. */
function makeRenderer(): MoleculeRenderer {
  const renderer = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.scene = { add: () => {}, remove: () => {} };
  internals.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  internals.camera.position.set(0, 0, 10);
  internals.controls = { target: new THREE.Vector3(), upAxis: new THREE.Vector3(0, 1, 0) };
  // The axes inset owns its own WebGLRenderer; jsdom has no canvas context.
  internals.cellAxesRenderer = { loadBox: () => {}, setVisible: () => {}, dispose: () => {} };
  return renderer;
}

function primaryAtoms(renderer: MoleculeRenderer): ImpostorAtomMesh {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (renderer as any).atomRenderer as ImpostorAtomMesh;
}

function layer(
  renderer: MoleculeRenderer,
  kind: "drawingBoundary" | "bondPeriodic",
): DrawingBoundaryAtomRenderer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = (renderer as any).atomLayers.peekSecondary(kind) as DrawingBoundaryAtomRenderer;
  expect(found).toBeTruthy();
  return found;
}

/** The ImpostorAtomMesh inside a secondary layer. */
function layerMesh(l: DrawingBoundaryAtomRenderer): ImpostorAtomMesh {
  return (l as unknown as { atoms: ImpostorAtomMesh }).atoms;
}

function radii(mesh: ImpostorAtomMesh): Float32Array {
  return (mesh as unknown as { radiusBuf: Float32Array }).radiusBuf;
}

function illustrativeUniform(mesh: ImpostorAtomMesh): number {
  return (mesh as unknown as { material: { uniforms: { uIllustrative: { value: number } } } })
    .material.uniforms.uIllustrative.value;
}

function load(renderer: MoleculeRenderer, snapshot = makeCellSnapshot()): Snapshot {
  renderer.loadSnapshot(snapshot, { fit: false });
  return snapshot;
}

describe("MoleculeRenderer — secondary atom layers in illustrative mode", () => {
  it("keeps Drawing Boundary copies visible across a reload", () => {
    const renderer = makeRenderer();
    const snapshot = load(renderer);
    renderer.setDrawingBoundary(generateDrawingBoundaryImages(snapshot));
    renderer.setRepresentationType("illustrative");
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(true);

    load(renderer);

    expect(primaryAtoms(renderer).mesh.visible).toBe(true);
    expect(layer(renderer, "drawingBoundary").count).toBeGreaterThan(0);
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(true);
    expect(layer(renderer, "bondPeriodic").group.visible).toBe(true);
  });

  it("keeps Drawing Boundary copies visible when the boundary changes", () => {
    const renderer = makeRenderer();
    const snapshot = load(renderer);
    renderer.setRepresentationType("illustrative");

    renderer.setDrawingBoundary(generateDrawingBoundaryImages(snapshot));

    expect(primaryAtoms(renderer).mesh.visible).toBe(true);
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(true);
  });

  it("keeps bond periodic images visible when they change", () => {
    const renderer = makeRenderer();
    load(renderer);
    renderer.setRepresentationType("illustrative");

    renderer.setBondPeriodicImages(periodicImages());

    expect(layer(renderer, "bondPeriodic").count).toBe(1);
    expect(layer(renderer, "bondPeriodic").group.visible).toBe(true);
  });

  it("creates layers with the spacefill radius and flat shading applied before they existed", () => {
    // The pipeline can switch the representation before the first snapshot
    // (PipelineViewer applies the viewport state on renderer-ready).
    const renderer = makeRenderer();
    renderer.setRepresentationType("illustrative");
    load(renderer);
    renderer.setBondPeriodicImages(periodicImages());

    const mesh = layerMesh(layer(renderer, "bondPeriodic"));
    expect(radii(mesh)[0]).toBeCloseTo(getRadius(8) * SPACEFILL_ATOM_SCALE, 6);
    expect(illustrativeUniform(mesh)).toBe(1);
    expect(layer(renderer, "bondPeriodic").group.visible).toBe(true);
  });
});

describe("MoleculeRenderer — secondary atom layers replay the representation state", () => {
  it("applies the licorice radius to layers created after the switch", () => {
    const renderer = makeRenderer();
    renderer.setRepresentationType("licorice");
    const snapshot = load(renderer);
    renderer.setDrawingBoundary(generateDrawingBoundaryImages(snapshot));

    const mesh = layerMesh(layer(renderer, "drawingBoundary"));
    expect(radii(mesh)[0]).toBeCloseTo(LICORICE_RADIUS, 6);
  });

  it("keeps ball-and-stick radii by default", () => {
    const renderer = makeRenderer();
    load(renderer);
    renderer.setBondPeriodicImages(periodicImages());

    const mesh = layerMesh(layer(renderer, "bondPeriodic"));
    expect(radii(mesh)[0]).toBeCloseTo(getRadius(8) * BALL_STICK_ATOM_SCALE, 6);
    expect(illustrativeUniform(mesh)).toBe(0);
  });

  it("hides the layers with the main atoms in atom-less representations", () => {
    const renderer = makeRenderer();
    const snapshot = load(renderer);
    renderer.setRepresentationType("cartoon");
    renderer.setDrawingBoundary(generateDrawingBoundaryImages(snapshot));
    renderer.setBondPeriodicImages(periodicImages());

    expect(primaryAtoms(renderer).mesh.visible).toBe(false);
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(false);
    expect(layer(renderer, "bondPeriodic").group.visible).toBe(false);
  });

  it("follows setAtomsVisible across a reload", () => {
    const renderer = makeRenderer();
    load(renderer);
    renderer.setAtomsVisible(false);
    load(renderer);
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(false);
    expect(layer(renderer, "bondPeriodic").group.visible).toBe(false);
    renderer.setAtomsVisible(true);
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(true);
  });

  it("carries atom scale, opacity and overrides onto periodic images", () => {
    const renderer = makeRenderer();
    load(renderer);
    renderer.setAtomScale(2);
    renderer.setAtomOpacity(0.5);
    renderer.setAtomScaleOverrides(new Float32Array([1, 3]));
    renderer.setAtomOpacityOverrides(new Float32Array([1, 0.25]));
    renderer.applyAtomColorOverrides(new Float32Array([NaN, NaN, NaN, 1, 0, 0]));

    renderer.setBondPeriodicImages(periodicImages());

    const l = layer(renderer, "bondPeriodic") as unknown as {
      scale: number;
      opacity: number;
      scaleOverrides: Float32Array | null;
      opacityOverrides: Float32Array | null;
      colorOverrides: Float32Array | null;
    };
    expect(l.scale).toBe(2);
    expect(l.opacity).toBe(0.5);
    expect(Array.from(l.scaleOverrides!)).toEqual([1, 3]);
    expect(Array.from(l.opacityOverrides!)).toEqual([1, 0.25]);
    expect(l.colorOverrides![3]).toBe(1);

    renderer.clearAtomOverrides();
    expect(l.scaleOverrides).toBeNull();
    expect(l.opacityOverrides).toBeNull();
  });

  it("maps the per-atom representation mask onto periodic images", () => {
    const renderer = makeRenderer();
    load(renderer);
    renderer.setRepresentationByAtom(["atoms", "line"]);
    renderer.setBondPeriodicImages(periodicImages());

    const hidden = (layer(renderer, "bondPeriodic") as unknown as { hiddenMask: Uint8Array })
      .hiddenMask;
    expect(Array.from(hidden)).toEqual([0, 1]);
  });
});

describe("MoleculeRenderer — recorded atom appearance outlives the meshes", () => {
  function uniforms(mesh: ImpostorAtomMesh): Record<string, { value: number }> {
    return (mesh as unknown as { material: { uniforms: Record<string, { value: number }> } })
      .material.uniforms;
  }

  it("applies scale, opacity and colours set before the first snapshot", () => {
    const renderer = makeRenderer();
    renderer.setAtomScale(2);
    renderer.setAtomOpacity(0.5);
    renderer.applyAtomColorOverrides(new Float32Array([1, 0, 0, NaN, NaN, NaN]));

    load(renderer);

    const atoms = primaryAtoms(renderer);
    expect(uniforms(atoms).uScaleMultiplier.value).toBe(2);
    expect(uniforms(atoms).uOpacity.value).toBe(0.5);
    expect(Array.from(atoms.getColorBuffer().slice(0, 3))).toEqual([1, 0, 0]);
  });

  it("keeps scale and colours on a heterogeneous trajectory frame", () => {
    const renderer = makeRenderer();
    load(renderer);
    renderer.setAtomScale(1.5);
    renderer.applyAtomColorOverrides(new Float32Array([0, 1, 0, NaN, NaN, NaN]));

    renderer.updateFrame({
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([0, 0, 0, 2, 2, 2]),
      elements: new Uint8Array([6, 8]),
      bonds: new Uint32Array(),
      nBonds: 0,
    });

    const atoms = primaryAtoms(renderer);
    expect(uniforms(atoms).uScaleMultiplier.value).toBe(1.5);
    expect(Array.from(atoms.getColorBuffer().slice(0, 3))).toEqual([0, 1, 0]);
  });

  it("re-derives the Drawing Boundary copies per frame and keeps them visible", () => {
    const renderer = makeRenderer();
    const snapshot = load(renderer);
    renderer.setDrawingBoundary(generateDrawingBoundaryImages(snapshot));
    renderer.setRepresentationType("illustrative");
    const onOrigin = layer(renderer, "drawingBoundary").count;
    expect(onOrigin).toBeGreaterThan(0);

    // Move the carbon off the cell faces: it no longer has boundary copies.
    renderer.updateFrame({
      frameId: 1,
      nAtoms: 2,
      positions: new Float32Array([1, 1, 1, 2, 2, 2]),
    });

    expect(layer(renderer, "drawingBoundary").count).toBe(0);
    expect(layer(renderer, "drawingBoundary").group.visible).toBe(true);
  });
});
