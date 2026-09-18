/**
 * Tests for the Build tab interactions wired into the Viewport: click-to-pick
 * (atom or empty space), drag-to-move with camera suspension, and the
 * guards that keep those inert on other tabs. The WebGL MoleculeRenderer is
 * mocked so the DOM event plumbing can be exercised in jsdom.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { BuildHandlers } from "@/stores/useBuildStore";

const canvas = document.createElement("canvas");

const rendererMock = {
  mount: vi.fn(),
  dispose: vi.fn(),
  getCanvas: () => canvas,
  raycastAtPixel: vi.fn(() => ({ kind: "atom", atomIndex: 5 })),
  getCurrentPositionsCopy: vi.fn(() => new Float32Array([0, 0, 0])),
  setRotationCenter: vi.fn(),
  hitTestAxesInset: vi.fn(() => false),
  isAxesDragging: vi.fn(() => false),
  startAxesDrag: vi.fn(),
  moveAxesDrag: vi.fn(),
  endAxesDrag: vi.fn(),
  loadSnapshot: vi.fn(),
  updateFrame: vi.fn(),
  setLabels: vi.fn(),
  setVectors: vi.fn(),
  setPreviewSelection: vi.fn(),
  setControlsEnabled: vi.fn(),
  selectAtomsInRect: vi.fn(() => [1, 2]),
  dragDeltaForAtom: vi.fn(() => [1, 2, 3] as [number, number, number]),
  screenToWorldAtPivot: vi.fn(() => [7, 8, 9] as [number, number, number]),
};

vi.mock("@/renderer/MoleculeRenderer", () => ({
  MoleculeRenderer: function () {
    return rendererMock;
  },
  isMeganeTestMode: () => true,
}));

import { Viewport } from "@/components/Viewport";

function pointer(type: string, x: number, y: number, init: MouseEventInit = {}) {
  canvas.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...init }) as Event,
  );
}

function handlers(overrides: Partial<BuildHandlers> = {}): BuildHandlers {
  return {
    pick: vi.fn(),
    dragStart: vi.fn(() => false),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
    ...overrides,
  };
}

describe("Viewport — Build interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererMock.raycastAtPixel.mockImplementation(() => ({ kind: "atom", atomIndex: 5 }));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  it("reports a click on an atom to the pick handler", () => {
    const h = handlers();
    render(<Viewport snapshot={null} frame={null} buildActive buildHandlers={h} />);
    pointer("pointerdown", 10, 10, { shiftKey: true });
    pointer("pointerup", 11, 10);
    expect(h.dragStart).toHaveBeenCalledWith(5);
    expect(h.pick).toHaveBeenCalledWith({ atomIndex: 5, world: null, shiftKey: true });
    expect(rendererMock.setControlsEnabled).not.toHaveBeenCalledWith(false);
    cleanup();
  });

  it("reports an empty-space click with the world point at the pivot depth", () => {
    rendererMock.raycastAtPixel.mockImplementation(() => null);
    const h = handlers();
    render(<Viewport snapshot={null} frame={null} buildActive buildHandlers={h} />);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    expect(h.pick).toHaveBeenCalledWith({ atomIndex: null, world: [7, 8, 9], shiftKey: false });
    cleanup();
  });

  it("ignores a press that turned into a camera drag", () => {
    const h = handlers();
    render(<Viewport snapshot={null} frame={null} buildActive buildHandlers={h} />);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 60, 60);
    expect(h.pick).not.toHaveBeenCalled();
    cleanup();
  });

  it("runs a move drag when the handler accepts it and suspends the camera meanwhile", () => {
    const h = handlers({ dragStart: vi.fn(() => true) });
    render(<Viewport snapshot={null} frame={null} buildActive buildHandlers={h} />);
    pointer("pointerdown", 10, 10);
    expect(rendererMock.setControlsEnabled).toHaveBeenCalledWith(false);
    pointer("pointermove", 30, 40);
    expect(rendererMock.dragDeltaForAtom).toHaveBeenCalledWith(5, 10, 10, 30, 40);
    expect(h.dragMove).toHaveBeenCalledWith([1, 2, 3]);
    pointer("pointerup", 30, 40);
    expect(h.dragEnd).toHaveBeenCalled();
    expect(rendererMock.setControlsEnabled).toHaveBeenLastCalledWith(true);
    // A drag never doubles as a click.
    expect(h.pick).not.toHaveBeenCalled();
    cleanup();
  });

  it("does nothing on other tabs or without handlers", () => {
    const h = handlers();
    render(<Viewport snapshot={null} frame={null} buildHandlers={h} />);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    expect(h.pick).not.toHaveBeenCalled();
    cleanup();
    render(<Viewport snapshot={null} frame={null} buildActive />);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    expect(rendererMock.raycastAtPixel).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores non-primary buttons", () => {
    const h = handlers();
    render(<Viewport snapshot={null} frame={null} buildActive buildHandlers={h} />);
    pointer("pointerdown", 10, 10, { button: 2 });
    pointer("pointerup", 10, 10, { button: 2 });
    expect(h.pick).not.toHaveBeenCalled();
    cleanup();
  });
});
