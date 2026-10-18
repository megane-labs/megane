/**
 * Unit tests for the Selection Inspector preview overlay and box-select
 * plumbing on MoleculeRenderer (setPreviewSelection / selectAtomsInRect /
 * setControlsEnabled). These paths are additive to the measurement selection
 * and are exercised without a WebGL context by stubbing renderer internals.
 */

import { describe, it, expect } from "vitest";
import { MoleculeRenderer } from "@/renderer/MoleculeRenderer";
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
