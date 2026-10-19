/**
 * Unit tests for the Selection Inspector preview overlay and box-select
 * plumbing on MoleculeRenderer (setPreviewSelection / selectAtomsInRect /
 * setControlsEnabled). These paths are additive to the measurement selection
 * and are exercised without a WebGL context by stubbing renderer internals.
 */

import { describe, it, expect } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
import { ImpostorAtomMesh } from "@/renderer/ImpostorAtomMesh";
import { ImpostorBondMesh } from "@/renderer/ImpostorBondMesh";
import type { Snapshot } from "@/types";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    elements: new Uint8Array([6, 7, 8]),
    bonds: new Uint32Array(0),
  } as Snapshot;
}

function makeRenderer() {
  const renderer = new MoleculeRenderer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = renderer as any;
  internals.snapshot = makeSnapshot();
  return { renderer, internals };
}

describe("MoleculeRenderer — preview selection", () => {
  it("draws one highlight sphere per previewed atom", () => {
    const { renderer, internals } = makeRenderer();
    renderer.setPreviewSelection([0, 2]);
    expect(internals.selection.previewSelectionGroup.children.length).toBe(2);
  });

  it("clears the preview on null/empty", () => {
    const { renderer, internals } = makeRenderer();
    renderer.setPreviewSelection([0, 1, 2]);
    expect(internals.selection.previewSelectionGroup.children.length).toBe(3);
    renderer.setPreviewSelection(null);
    expect(internals.selection.previewSelectionGroup.children.length).toBe(0);
    renderer.setPreviewSelection([]);
    expect(internals.selection.previewSelectionGroup.children.length).toBe(0);
  });

  it("does not touch the measurement selection group", () => {
    const { renderer, internals } = makeRenderer();
    renderer.setPreviewSelection([0, 1]);
    expect(internals.selection.selectionGroup.children.length).toBe(0);
  });

  it("follows the atoms when a new snapshot moves them (a Builder drag)", () => {
    const { renderer, internals } = makeRenderer();
    internals.atomRenderer = new ImpostorAtomMesh(8);
    internals.bondRenderer = new ImpostorBondMesh(8);
    internals.scene = { add: () => {}, remove: () => {} };
    // No mounted camera: keep the camera step out of a geometry-only test.
    internals.cameraController.syncExtent = () => {};
    renderer.setPreviewSelection([1]);
    const moved = makeSnapshot();
    moved.positions = new Float32Array([0, 0, 0, 5, 6, 7, 2, 0, 0]);
    renderer.loadSnapshot(moved, { fit: false });
    const spheres = internals.selection.previewSelectionGroup.children;
    expect(spheres.length).toBe(1);
    expect(spheres[0].position.toArray()).toEqual([5, 6, 7]);
  });

  it("follows the atoms through a trajectory frame", () => {
    const { renderer, internals } = makeRenderer();
    internals.atomRenderer = new ImpostorAtomMesh(8);
    internals.atomRenderer.loadSnapshot(internals.snapshot);
    internals.bondRenderer = new ImpostorBondMesh(8);
    renderer.setPreviewSelection([2]);
    renderer.updateFrame({
      frameId: 1,
      nAtoms: 3,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 4, 4, 4]),
    });
    const spheres = internals.selection.previewSelectionGroup.children;
    expect(spheres[0].position.toArray()).toEqual([4, 4, 4]);
  });

  it("forwards the Builder's hover, warning, gesture and mouse scheme", () => {
    const { renderer, internals } = makeRenderer();
    renderer.setHoverHighlight([0], 0x123456);
    renderer.setWarningHighlight([1, 2]);
    expect(internals.selection.hoverGroup.children.length).toBe(1);
    expect(internals.selection.warningGroup.children.length).toBe(2);
    // Not mounted: no container to measure a drag in.
    expect(renderer.dragGesture(0, 0, 0, 1, 1)).toBeNull();
    renderer.setMouseScheme("builder");
    expect(internals.cameraController.mouseScheme).toBe("builder");
  });

  it("selectAtomsInRect returns [] without a container", () => {
    const { renderer } = makeRenderer();
    expect(renderer.selectAtomsInRect({ x0: 0, y0: 0, x1: 10, y1: 10 })).toEqual([]);
  });

  it("setControlsEnabled toggles the orbit controls flag", () => {
    const { renderer, internals } = makeRenderer();
    internals.cameraController.controls = { enabled: true };
    renderer.setControlsEnabled(false);
    expect(internals.cameraController.controls.enabled).toBe(false);
    renderer.setControlsEnabled(true);
    expect(internals.cameraController.controls.enabled).toBe(true);
  });
});
