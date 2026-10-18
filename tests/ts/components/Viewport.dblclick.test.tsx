/**
 * Double-click sets the orbit center as in OVITO: the drawn atom that was hit
 * (its periodic-image position when an image was clicked), a bond midpoint,
 * or — on empty space — a reset to the model center. The WebGL renderer is
 * mocked so only the DOM wiring is exercised.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const canvas = document.createElement("canvas");

const rendererMock = {
  mount: vi.fn(),
  dispose: vi.fn(),
  getCanvas: () => canvas,
  raycastAtPixel: vi.fn(),
  getCurrentPositionsCopy: vi.fn(() => new Float32Array([0, 0, 0, 2, 4, 6])),
  setRotationCenter: vi.fn(),
  resetRotationCenter: vi.fn(),
  hitTestAxesInset: vi.fn(() => false),
  isAxesDragging: vi.fn(() => false),
  endAxesDrag: vi.fn(),
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

function dblclick() {
  canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 20, clientY: 20, bubbles: true }));
}

describe("Viewport — double-click orbit center", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the position of the drawn copy that was hit, not the source atom", () => {
    // A periodic image of atom 1 drawn one cell over.
    rendererMock.raycastAtPixel.mockReturnValue({
      kind: "atom",
      atomIndex: 1,
      position: [12, 4, 6],
    });
    render(<Viewport snapshot={null} frame={null} />);
    dblclick();
    expect(rendererMock.setRotationCenter).toHaveBeenCalledWith(12, 4, 6);
    cleanup();
  });

  it("uses the midpoint of a double-clicked bond", () => {
    rendererMock.raycastAtPixel.mockReturnValue({ kind: "bond", atomA: 0, atomB: 1 });
    render(<Viewport snapshot={null} frame={null} />);
    dblclick();
    expect(rendererMock.setRotationCenter).toHaveBeenCalledWith(1, 2, 3);
    cleanup();
  });

  it("ignores a bond hit before any positions exist", () => {
    rendererMock.raycastAtPixel.mockReturnValue({ kind: "bond", atomA: 0, atomB: 1 });
    rendererMock.getCurrentPositionsCopy.mockReturnValueOnce(null as unknown as Float32Array);
    render(<Viewport snapshot={null} frame={null} />);
    dblclick();
    expect(rendererMock.setRotationCenter).not.toHaveBeenCalled();
    expect(rendererMock.resetRotationCenter).not.toHaveBeenCalled();
    cleanup();
  });

  it("resets to the model center on empty space", () => {
    rendererMock.raycastAtPixel.mockReturnValue(null);
    render(<Viewport snapshot={null} frame={null} />);
    dblclick();
    expect(rendererMock.resetRotationCenter).toHaveBeenCalledTimes(1);
    expect(rendererMock.setRotationCenter).not.toHaveBeenCalled();
    cleanup();
  });
});
