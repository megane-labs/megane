import { describe, it, expect, vi, afterEach } from "vitest";
import {
  alignArrow,
  arrowCorrection,
  arrowSide,
  ARROW_INSET,
  followActiveElement,
  presentSteps,
} from "@/tour/followTarget";

/** A DOMRect-like box. */
function box(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function withRect<T extends HTMLElement>(el: T, rect: () => DOMRect): T {
  el.getBoundingClientRect = rect;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("arrowCorrection", () => {
  it("leaves an arrow that already points into the target alone", () => {
    expect(arrowCorrection(208, { start: 136, end: 280 }, { start: 189, end: 227 })).toBeNull();
    // A tall target: anywhere inside it will do.
    expect(arrowCorrection(31, { start: 10, end: 174 }, { start: 12, end: 840 })).toBeNull();
  });

  it("moves an arrow pointing past the target to the target's centre (#964)", () => {
    // The Tutorial button at the foot of the rail, measured at 1400x900:
    // driver.js put the arrow at the popover's end, 60 px below the button.
    expect(arrowCorrection(826, { start: 683, end: 847 }, { start: 746, end: 784 })).toBe(765);
  });

  it("keeps the arrow off the popover's rounded corners", () => {
    // The target's centre is near the popover's top: inset by ARROW_INSET.
    expect(arrowCorrection(150, { start: 100, end: 300 }, { start: 90, end: 110 })).toBe(
      100 + ARROW_INSET,
    );
  });

  it("points from the nearest end when the popover's edge does not reach the target", () => {
    expect(arrowCorrection(200, { start: 100, end: 300 }, { start: 400, end: 420 })).toBe(
      300 - ARROW_INSET,
    );
    expect(arrowCorrection(286, { start: 100, end: 300 }, { start: 400, end: 420 })).toBeNull();
  });

  it("gives up on a popover too short to carry an arrow", () => {
    expect(arrowCorrection(5, { start: 0, end: 20 }, { start: 100, end: 120 })).toBeNull();
  });
});

describe("arrowSide", () => {
  it("reads driver.js's side class", () => {
    const arrow = document.createElement("div");
    expect(arrowSide(arrow)).toBeNull();
    arrow.className = "driver-popover-arrow driver-popover-arrow-side-top";
    expect(arrowSide(arrow)).toBe("top");
  });
});

describe("alignArrow", () => {
  function popoverWithArrow(side: string, arrowRect: DOMRect, popRect: DOMRect) {
    const popover = withRect(document.createElement("div"), () => popRect);
    const arrow = withRect(document.createElement("div"), () => arrowRect);
    arrow.className = `driver-popover-arrow driver-popover-arrow-side-${side}`;
    popover.appendChild(arrow);
    document.body.appendChild(popover);
    return { popover, arrow };
  }

  it("slides a side arrow vertically onto the target", () => {
    const { popover, arrow } = popoverWithArrow(
      "left",
      box(898, 821, 10, 10),
      box(539, 683, 360, 164),
    );
    expect(alignArrow(popover, arrow, box(915, 746, 38, 38))).toBe(true);
    // centre 765 → top = 765 - 683 - 5 (jsdom's clientTop is 0)
    expect(arrow.style.top).toBe("77px");
    expect(arrow.style.bottom).toBe("auto");
    expect(arrow.style.marginTop).toBe("0px");
  });

  it("slides a top/bottom arrow horizontally onto the target", () => {
    const { popover, arrow } = popoverWithArrow(
      "bottom",
      box(110, 300, 10, 10),
      box(100, 100, 300, 200),
    );
    expect(alignArrow(popover, arrow, box(300, 320, 40, 20))).toBe(true);
    expect(arrow.style.left).toBe("215px");
    expect(arrow.style.right).toBe("auto");
  });

  it("does nothing when the arrow already points at the target, is hidden or has no side", () => {
    const ok = popoverWithArrow("right", box(503, 317, 10, 10), box(512, 240, 360, 164));
    expect(alignArrow(ok.popover, ok.arrow, box(24, 24, 472, 596))).toBe(false);
    expect(ok.arrow.style.top).toBe("");

    const hidden = popoverWithArrow("left", box(898, 821, 10, 10), box(539, 683, 360, 164));
    hidden.arrow.style.display = "none";
    expect(alignArrow(hidden.popover, hidden.arrow, box(915, 746, 38, 38))).toBe(false);

    const none = popoverWithArrow("left", box(898, 821, 10, 10), box(539, 683, 360, 164));
    none.arrow.className = "driver-popover-arrow driver-popover-arrow-none";
    expect(alignArrow(none.popover, none.arrow, box(915, 746, 38, 38))).toBe(false);
  });
});

describe("followActiveElement", () => {
  function harness() {
    let frame: FrameRequestCallback | null = null;
    const raf = vi.fn((cb: FrameRequestCallback) => {
      frame = cb;
      return 7;
    });
    const caf = vi.fn();
    const step = () => frame?.(0);
    return { raf, caf, step };
  }

  it("re-places the callout when its target moves, and points the arrow at it", () => {
    let targetRect = box(915, 189, 38, 38);
    const target = withRect(document.createElement("button"), () => targetRect);
    document.body.appendChild(target);
    const popover = withRect(document.createElement("div"), () => box(539, 136, 360, 144));
    popover.className = "driver-popover";
    const arrow = withRect(document.createElement("div"), () => box(898, 260, 10, 10));
    arrow.className = "driver-popover-arrow driver-popover-arrow-side-left";
    popover.appendChild(arrow);
    document.body.appendChild(popover);

    const tour = { isActive: () => true, getActiveElement: () => target, refresh: vi.fn() };
    const { raf, caf, step } = harness();
    const stop = followActiveElement(tour, document, raf, caf);

    step();
    // Same step, target where driver.js put it: no refresh, but the arrow
    // (at 265, below the button) is moved onto the button.
    expect(tour.refresh).not.toHaveBeenCalled();
    expect(arrow.style.top).toBe(`${208 - 136 - 5}px`);

    step();
    expect(tour.refresh).not.toHaveBeenCalled();
    // The panel moves (a JupyterLab sidebar opens): no window event.
    targetRect = box(475, 189, 38, 38);
    step();
    expect(tour.refresh).toHaveBeenCalledTimes(1);
    step();
    expect(tour.refresh).toHaveBeenCalledTimes(1);

    stop();
    expect(caf).toHaveBeenCalledWith(7);
  });

  it("runs on the window's animation frames by default", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(3);
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const stop = followActiveElement({
      isActive: () => false,
      getActiveElement: () => undefined,
      refresh: vi.fn(),
    });
    expect(raf).toHaveBeenCalledTimes(1);
    stop();
    expect(caf).toHaveBeenCalledWith(3);
    raf.mockRestore();
    caf.mockRestore();
  });

  it("does not refresh on a new step, nor for a step without a target or a finished tour", () => {
    const a = withRect(document.createElement("div"), () => box(0, 0, 10, 10));
    const b = withRect(document.createElement("div"), () => box(50, 50, 10, 10));
    const dummy = document.createElement("div");
    dummy.id = "driver-dummy-element";
    let active: Element | undefined = a;
    let running = true;
    const tour = {
      isActive: () => running,
      getActiveElement: () => active,
      refresh: vi.fn(),
    };
    const { raf, caf, step } = harness();
    followActiveElement(tour, document, raf, caf);
    step();
    active = b; // the next step: driver.js places it itself
    step();
    active = dummy;
    step();
    active = undefined;
    step();
    running = false;
    step();
    expect(tour.refresh).not.toHaveBeenCalled();
  });
});

describe("presentSteps", () => {
  it("drops steps whose target is missing or has no size, keeps the rest", () => {
    document.body.innerHTML = `
      <div data-testid="shown"></div>
      <div data-testid="collapsed"></div>`;
    withRect(document.querySelector<HTMLElement>('[data-testid="shown"]')!, () =>
      box(0, 0, 40, 40),
    );
    withRect(document.querySelector<HTMLElement>('[data-testid="collapsed"]')!, () =>
      box(0, 0, 0, 0),
    );
    const shown = { element: '[data-testid="shown"]', popover: { title: "a" } };
    const centred = { popover: { title: "b" } };
    const steps = [
      shown,
      { element: '[data-testid="collapsed"]', popover: { title: "c" } },
      { element: '[data-testid="missing"]', popover: { title: "d" } },
      centred,
    ];
    expect(presentSteps(steps)).toEqual([shown, centred]);
  });
});
