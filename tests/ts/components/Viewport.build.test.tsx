/**
 * Tests for the Builder interactions wired into the Viewport: a left press
 * asks `pressAction` what a drag does (move atoms, rubber band, or camera),
 * a press released in place is a click (`pick`), a right-click opens the atom
 * menu on release, a double-click goes to the Builder first, and the guards
 * that keep all of it inert outside the Builder. The WebGL MoleculeRenderer is
 * mocked so the DOM event plumbing can be exercised in jsdom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { BuildHandlers } from "@/builder/types";

const canvas = document.createElement("canvas");
const gesture = { from: [0, 0], to: [1, 1] };

const rendererMock = {
  mount: vi.fn((el: HTMLElement) => el.appendChild(canvas)),
  dispose: vi.fn(),
  getCanvas: () => canvas,
  raycastAtPixel: vi.fn((): unknown => ({ kind: "atom", atomIndex: 5, position: [1, 2, 3] })),
  getCurrentPositionsCopy: vi.fn(() => new Float32Array([0, 0, 0])),
  setRotationCenter: vi.fn(),
  resetRotationCenter: vi.fn(),
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
  dragGesture: vi.fn(() => gesture),
  screenToWorldAtPivot: vi.fn(() => [7, 8, 9] as [number, number, number]),
  setHoverHighlight: vi.fn(),
  setWarningHighlight: vi.fn(),
};

vi.mock("@/renderer/MoleculeRenderer", () => ({
  MoleculeRenderer: function () {
    return rendererMock;
  },
  isMeganeTestMode: () => true,
}));

import { Viewport } from "@/components/Viewport";

function pointer(type: string, x: number, y: number, init: MouseEventInit = {}) {
  // A move reports no button change and, mid-press, the left button held.
  const buttons = type === "pointermove" ? { button: -1, buttons: 1 } : { button: 0 };
  canvas.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...buttons, ...init }) as Event,
  );
}

function handlers(overrides: Partial<BuildHandlers> = {}): BuildHandlers {
  return {
    pick: vi.fn(),
    pressAction: vi.fn(() => "camera" as const),
    dragStart: vi.fn(() => true),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
    boxSelect: vi.fn(),
    ...overrides,
  };
}

function mountBuilder(h: BuildHandlers, extra: Record<string, unknown> = {}) {
  return render(<Viewport snapshot={null} frame={null} buildActive buildHandlers={h} {...extra} />);
}

const noMods = { shiftKey: false, mod: false, altKey: false };

describe("Viewport — Builder interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererMock.raycastAtPixel.mockImplementation(() => ({
      kind: "atom",
      atomIndex: 5,
      position: [1, 2, 3],
    }));
    rendererMock.hitTestAxesInset.mockImplementation(() => false);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    cleanup();
    document.querySelectorAll('[data-testid="viewport-box-select"]').forEach((e) => e.remove());
  });

  it("reports a click on an atom to the pick handler", () => {
    const h = handlers();
    mountBuilder(h);
    pointer("pointerdown", 10, 10, { shiftKey: true });
    pointer("pointerup", 11, 10, { shiftKey: true });
    expect(h.pressAction).toHaveBeenCalledWith(5, { ...noMods, shiftKey: true });
    expect(h.pick).toHaveBeenCalledWith({ atomIndex: 5, world: null, shiftKey: true, mod: false });
    // A camera press leaves the controls alone.
    expect(rendererMock.setControlsEnabled).not.toHaveBeenCalledWith(false);
  });

  it("reports an empty-space click with the world point at the pivot depth", () => {
    rendererMock.raycastAtPixel.mockImplementation(() => null);
    const h = handlers();
    mountBuilder(h);
    pointer("pointerdown", 10, 10, { ctrlKey: true });
    pointer("pointerup", 10, 10);
    expect(h.pressAction).toHaveBeenCalledWith(null, { ...noMods, mod: true });
    expect(h.pick).toHaveBeenCalledWith({
      atomIndex: null,
      world: [7, 8, 9],
      shiftKey: false,
      mod: true,
    });
  });

  it("ignores a press that turned into a camera drag", () => {
    const h = handlers();
    mountBuilder(h);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 60, 60);
    pointer("pointerup", 60, 60);
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.dragStart).not.toHaveBeenCalled();
  });

  it("runs a move drag once the pointer moves, with the camera suspended from the press", () => {
    const h = handlers({ pressAction: vi.fn(() => "move" as const) });
    mountBuilder(h);
    pointer("pointerdown", 10, 10, { ctrlKey: true });
    expect(rendererMock.setControlsEnabled).toHaveBeenCalledWith(false);
    // Within the click slop nothing starts yet.
    pointer("pointermove", 11, 11);
    expect(h.dragStart).not.toHaveBeenCalled();
    pointer("pointermove", 30, 40);
    expect(h.dragStart).toHaveBeenCalledWith(5, { ...noMods, mod: true });
    expect(rendererMock.dragGesture).toHaveBeenCalledWith(5, 10, 10, 30, 40);
    expect(h.dragMove).toHaveBeenCalledWith(gesture);
    pointer("pointerup", 35, 45);
    // The release applies the last position before ending.
    expect(rendererMock.dragGesture).toHaveBeenLastCalledWith(5, 10, 10, 35, 45);
    expect(h.dragEnd).toHaveBeenCalled();
    expect(rendererMock.setControlsEnabled).toHaveBeenLastCalledWith(true);
    // A drag never doubles as a click.
    expect(h.pick).not.toHaveBeenCalled();
  });

  it("a move press released in place is a click, and a refused drag does nothing", () => {
    const h = handlers({ pressAction: vi.fn(() => "move" as const) });
    mountBuilder(h);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    expect(h.pick).toHaveBeenCalledTimes(1);
    expect(rendererMock.setControlsEnabled).toHaveBeenLastCalledWith(true);

    const refused = handlers({
      pressAction: vi.fn(() => "move" as const),
      dragStart: vi.fn(() => false),
    });
    cleanup();
    mountBuilder(refused);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 40, 40);
    pointer("pointerup", 40, 40);
    expect(refused.dragMove).not.toHaveBeenCalled();
    expect(refused.dragEnd).not.toHaveBeenCalled();
    expect(refused.pick).not.toHaveBeenCalled();
  });

  it("draws a rubber band and reports what it holds, Shift adding and Ctrl removing", () => {
    const h = handlers({ pressAction: vi.fn(() => "box" as const) });
    mountBuilder(h);
    const box = () => document.querySelector<HTMLElement>('[data-testid="viewport-box-select"]');
    for (const [init, mode] of [
      [{}, "replace"],
      [{ shiftKey: true }, "add"],
      [{ metaKey: true }, "subtract"],
    ] as const) {
      pointer("pointerdown", 50, 50, init);
      expect(rendererMock.setControlsEnabled).toHaveBeenLastCalledWith(false);
      pointer("pointermove", 20, 90);
      expect(box()?.style.left).toBe("20px");
      expect(box()?.style.height).toBe("40px");
      pointer("pointerup", 20, 90);
      expect(rendererMock.selectAtomsInRect).toHaveBeenLastCalledWith({
        x0: 50,
        y0: 50,
        x1: 20,
        y1: 90,
      });
      expect(h.boxSelect).toHaveBeenLastCalledWith([1, 2], mode);
      expect(box()).toBeNull();
    }
    expect(h.pick).not.toHaveBeenCalled();
  });

  it("Alt+drag always turns the camera", () => {
    const h = handlers({ pressAction: vi.fn(() => "move" as const) });
    mountBuilder(h);
    pointer("pointerdown", 10, 10, { altKey: true });
    pointer("pointermove", 50, 50);
    pointer("pointerup", 50, 50);
    expect(h.pressAction).not.toHaveBeenCalled();
    expect(h.dragStart).not.toHaveBeenCalled();
    expect(rendererMock.setControlsEnabled).not.toHaveBeenCalledWith(false);
  });

  it("a cancelled press ends a drag without a last move and drops a rubber band", () => {
    const h = handlers({ pressAction: vi.fn(() => "move" as const) });
    mountBuilder(h);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 30, 30);
    rendererMock.dragGesture.mockClear();
    pointer("pointercancel", 40, 40);
    expect(rendererMock.dragGesture).not.toHaveBeenCalled();
    expect(h.dragEnd).toHaveBeenCalled();

    const b = handlers({ pressAction: vi.fn(() => "box" as const) });
    cleanup();
    mountBuilder(b);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 30, 30);
    pointer("pointercancel", 30, 30);
    expect(b.boxSelect).not.toHaveBeenCalled();
    expect(rendererMock.setControlsEnabled).toHaveBeenLastCalledWith(true);
  });

  it("never leaves a rubber band behind when the left release goes unreported", () => {
    const h = handlers({ pressAction: vi.fn(() => "box" as const) });
    mountBuilder(h);
    const boxes = () => document.querySelectorAll('[data-testid="viewport-box-select"]').length;

    // Left released while the right button is held: a move with `button` 0
    // ends the band as a release there, and the later right release is inert.
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 20, 90);
    expect(boxes()).toBe(1);
    pointer("pointermove", 25, 95, { button: 0, buttons: 2 });
    expect(boxes()).toBe(0);
    expect(h.boxSelect).toHaveBeenLastCalledWith([1, 2], "replace");
    expect(rendererMock.selectAtomsInRect).toHaveBeenLastCalledWith({
      x0: 50,
      y0: 50,
      x1: 25,
      y1: 95,
    });
    expect(rendererMock.setControlsEnabled).toHaveBeenLastCalledWith(true);
    pointer("pointerup", 25, 95, { button: 2 });
    expect(h.boxSelect).toHaveBeenCalledTimes(1);

    // A hover move with no button held after a release that never came:
    // the band is dropped without selecting.
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 20, 90);
    pointer("pointermove", 30, 30, { buttons: 0 });
    expect(boxes()).toBe(0);
    expect(h.boxSelect).toHaveBeenCalledTimes(1);

    // Losing the pointer capture cancels the band.
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 20, 90);
    pointer("lostpointercapture", 20, 90);
    expect(boxes()).toBe(0);
    expect(h.boxSelect).toHaveBeenCalledTimes(1);

    // A new press drops a band whose press was never ended.
    pointer("pointerdown", 50, 50);
    pointer("pointermove", 20, 90);
    pointer("pointerdown", 60, 60);
    expect(boxes()).toBe(0);
    pointer("pointermove", 90, 90);
    pointer("pointerup", 90, 90);
    expect(boxes()).toBe(0);
    expect(h.boxSelect).toHaveBeenCalledTimes(2);
  });

  it("ends an atom drag when the left release goes unreported", () => {
    const h = handlers({ pressAction: vi.fn(() => "move" as const) });
    mountBuilder(h);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 30, 30);
    pointer("pointermove", 40, 40, { button: 0, buttons: 2 });
    expect(rendererMock.dragGesture).toHaveBeenLastCalledWith(5, 10, 10, 40, 40);
    expect(h.dragEnd).toHaveBeenCalledTimes(1);
    // A camera press keeps its pointer capture to itself.
    const cam = handlers();
    cleanup();
    mountBuilder(cam);
    pointer("pointerdown", 10, 10);
    pointer("lostpointercapture", 10, 10);
    pointer("pointerup", 10, 10);
    expect(cam.pick).toHaveBeenCalledTimes(1);
  });

  it("leaves a press on the axes inset to the inset", () => {
    rendererMock.hitTestAxesInset.mockImplementation(() => true);
    const h = handlers({ pressAction: vi.fn(() => "move" as const) });
    mountBuilder(h);
    pointer("pointerdown", 10, 10);
    pointer("pointerup", 10, 10);
    expect(h.pressAction).not.toHaveBeenCalled();
    expect(h.pick).not.toHaveBeenCalled();
  });

  it("opens the atom menu on a right-click's release, not on a right drag", () => {
    const onAtomRightClick = vi.fn();
    const h = handlers();
    mountBuilder(h, { onAtomRightClick });
    canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: 5, clientY: 5, bubbles: true }));
    expect(onAtomRightClick).not.toHaveBeenCalled();
    pointer("pointerdown", 20, 30, { button: 2 });
    pointer("pointerup", 21, 30, { button: 2 });
    expect(onAtomRightClick).toHaveBeenCalledWith(5, 21, 30);
    pointer("pointerdown", 20, 30, { button: 2 });
    pointer("pointerup", 80, 30, { button: 2 });
    expect(onAtomRightClick).toHaveBeenCalledTimes(1);
    rendererMock.raycastAtPixel.mockImplementation(() => null);
    pointer("pointerdown", 20, 30, { button: 2 });
    pointer("pointerup", 20, 30, { button: 2 });
    expect(onAtomRightClick).toHaveBeenCalledTimes(1);
    expect(h.pick).not.toHaveBeenCalled();
  });

  it("the viewer's right-click opens the menu on contextmenu, with the pointer position", () => {
    const onAtomRightClick = vi.fn();
    render(<Viewport snapshot={null} frame={null} onAtomRightClick={onAtomRightClick} />);
    canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: 5, clientY: 6, bubbles: true }));
    expect(onAtomRightClick).toHaveBeenCalledWith(5, 5, 6);
  });

  it("a double-click on an atom sets the rotation center, as in the viewer", () => {
    mountBuilder(handlers());
    canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: 5, clientY: 5 }));
    expect(rendererMock.setRotationCenter).toHaveBeenCalled();
  });

  it("does nothing outside the Builder or without handlers", () => {
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
  });

  it("ignores the middle button", () => {
    const h = handlers();
    mountBuilder(h);
    pointer("pointerdown", 10, 10, { button: 1 });
    pointer("pointerup", 10, 10, { button: 1 });
    expect(h.pick).not.toHaveBeenCalled();
  });

  it("passes the Builder's highlights to the renderer", () => {
    const h = handlers();
    mountBuilder(h, {
      hoverIndices: [3],
      hoverColor: 0xff0000,
      warningIndices: [1, 2],
    });
    expect(rendererMock.setHoverHighlight).toHaveBeenCalledWith([3], 0xff0000);
    expect(rendererMock.setWarningHighlight).toHaveBeenCalledWith([1, 2]);
    cleanup();
    vi.clearAllMocks();
    // The viewer sets none of them.
    render(<Viewport snapshot={null} frame={null} hoverIndices={[3]} />);
    expect(rendererMock.setHoverHighlight).not.toHaveBeenCalled();
    expect(rendererMock.setWarningHighlight).not.toHaveBeenCalled();
  });
});
