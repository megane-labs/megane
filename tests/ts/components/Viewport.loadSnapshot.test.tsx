/**
 * Viewport → MoleculeRenderer.loadSnapshot camera-fit gating.
 *
 * A snapshot that shares its topology arrays with the previously loaded one
 * and differs only in `positions` is a coordinate re-mapping of the scene
 * already on screen (the wrap node toggling wrap/unwrap). The Viewport must
 * pass `{ fit: false }` so the user's zoom/orbit survives the toggle, while a
 * genuinely new structure still re-fits the camera.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { Snapshot } from "@/types";

const canvas = document.createElement("canvas");

const rendererMock = {
  mount: vi.fn(),
  dispose: vi.fn(),
  getCanvas: () => canvas,
  loadSnapshot: vi.fn(),
  updateFrame: vi.fn(),
  setLabels: vi.fn(),
  setVectors: vi.fn(),
  setPreviewSelection: vi.fn(),
  setControlsEnabled: vi.fn(),
};

vi.mock("@/renderer/MoleculeRenderer", () => ({
  MoleculeRenderer: function () {
    return rendererMock;
  },
  isMeganeTestMode: () => true,
}));

import { Viewport } from "@/components/Viewport";

function makeSnapshot(): Snapshot {
  return {
    nAtoms: 2,
    nBonds: 1,
    nFileBonds: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    elements: new Uint8Array([6, 8]),
    bonds: new Uint32Array([0, 1]),
    bondOrders: null,
    box: new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]),
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  } as Snapshot;
}

describe("Viewport — loadSnapshot camera-fit gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fits the camera on the first snapshot load", () => {
    const snapshot = makeSnapshot();
    render(<Viewport snapshot={snapshot} frame={null} />);
    expect(rendererMock.loadSnapshot).toHaveBeenCalledWith(snapshot, { fit: true });
    cleanup();
  });

  it("skips the fit for a positions-only re-mapping of the same topology", () => {
    const first = makeSnapshot();
    const { rerender } = render(<Viewport snapshot={first} frame={null} />);
    // Same topology arrays, new positions — what the wrap node emits.
    const remapped: Snapshot = { ...first, positions: new Float32Array([5, 5, 5, 6, 5, 5]) };
    rerender(<Viewport snapshot={remapped} frame={null} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(remapped, { fit: false });
    cleanup();
  });

  it("re-fits when the topology changes (a genuinely new structure)", () => {
    const first = makeSnapshot();
    const { rerender } = render(<Viewport snapshot={first} frame={null} />);
    const other = makeSnapshot(); // fresh arrays: element/bond identity differs
    rerender(<Viewport snapshot={other} frame={null} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(other, { fit: true });
    cleanup();
  });

  it("re-fits when the atom count changes", () => {
    const first = makeSnapshot();
    const { rerender } = render(<Viewport snapshot={first} frame={null} />);
    const grown: Snapshot = {
      ...first,
      nAtoms: 4,
      positions: new Float32Array(12),
    };
    rerender(<Viewport snapshot={grown} frame={null} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(grown, { fit: true });
    cleanup();
  });

  // The Build tab re-executes the `edit` node on every click; its output has
  // fresh element/bond arrays (and often a different atom count), which the
  // topology heuristic reads as a new structure. The pipeline store bumps
  // `editRevision` alongside, and the Viewport must keep the camera then.
  it("keeps the camera when the snapshot arrives with a moved preserveCameraKey", () => {
    const first = makeSnapshot();
    const { rerender } = render(<Viewport snapshot={first} frame={null} preserveCameraKey={0} />);
    const edited: Snapshot = {
      ...first,
      nAtoms: 3,
      positions: new Float32Array(9),
      elements: new Uint8Array([6, 8, 7]),
      bonds: new Uint32Array([0, 1, 1, 2]),
    };
    rerender(<Viewport snapshot={edited} frame={null} preserveCameraKey={1} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(edited, { fit: false });
    // The key is acknowledged: the next structure with the same key re-fits.
    const other = makeSnapshot();
    rerender(<Viewport snapshot={other} frame={null} preserveCameraKey={1} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(other, { fit: true });
    cleanup();
  });

  it("still fits the very first snapshot even when the key has moved", () => {
    const { rerender } = render(<Viewport snapshot={null} frame={null} preserveCameraKey={0} />);
    const snapshot = makeSnapshot();
    rerender(<Viewport snapshot={snapshot} frame={null} preserveCameraKey={1} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(snapshot, { fit: true });
    cleanup();
  });

  it("a key change without a snapshot change is acknowledged, so a later file load re-fits", () => {
    const first = makeSnapshot();
    const { rerender } = render(<Viewport snapshot={first} frame={null} preserveCameraKey={0} />);
    // An edit action that left the rendered structure identical (e.g. a
    // no-op param update on the edit node): key moves, snapshot does not.
    rerender(<Viewport snapshot={first} frame={null} preserveCameraKey={1} />);
    expect(rendererMock.loadSnapshot).toHaveBeenCalledTimes(1);
    const other = makeSnapshot();
    rerender(<Viewport snapshot={other} frame={null} preserveCameraKey={1} />);
    expect(rendererMock.loadSnapshot).toHaveBeenLastCalledWith(other, { fit: true });
    cleanup();
  });
});
