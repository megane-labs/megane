import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tooltip, computeTooltipPosition, type ClientBox } from "@/components/Tooltip";
import type { AtomHoverInfo, BondHoverInfo } from "@/types";

describe("Tooltip", () => {
  it("renders nothing when info is null", () => {
    const { container } = render(<Tooltip info={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders atom info with element symbol and index", () => {
    const info: AtomHoverInfo = {
      kind: "atom",
      atomIndex: 42,
      elementSymbol: "C",
      atomicNumber: 6,
      position: [1.23, 4.56, 7.89],
      screenX: 100,
      screenY: 200,
    };

    render(<Tooltip info={info} />);
    expect(screen.getByText(/C/)).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    expect(screen.getByText(/1\.23/)).toBeInTheDocument();
    expect(screen.getByText(/4\.56/)).toBeInTheDocument();
  });

  it("renders bond info with bond order and length", () => {
    const info: BondHoverInfo = {
      kind: "bond",
      atomA: 10,
      atomB: 20,
      bondOrder: 2,
      bondLength: 1.34,
      screenX: 150,
      screenY: 250,
    };

    render(<Tooltip info={info} />);
    expect(screen.getByText(/Double/)).toBeInTheDocument();
    expect(screen.getByText(/1\.34/)).toBeInTheDocument();
  });
});

const VIEWPORT: ClientBox = { left: 0, top: 0, width: 1000, height: 800 };
const box = (left: number, top: number, width = 100, height = 40): ClientBox => ({
  left,
  top,
  width,
  height,
});

describe("computeTooltipPosition", () => {
  it("places the tooltip beside the cursor when the containing block is the viewport", () => {
    expect(computeTooltipPosition(200, 300, box(0, 0), 100, 40, VIEWPORT)).toEqual({
      left: 214,
      top: 286,
    });
  });

  it("subtracts the offset of a containing block that is not the viewport", () => {
    // e.g. a JupyterLab panel with CSS containment whose corner sits at
    // (250, 120): `left: 0` renders there, not at the viewport origin.
    expect(computeTooltipPosition(400, 300, box(250, 120), 100, 40, VIEWPORT)).toEqual({
      left: 164,
      top: 166,
    });
  });

  it("undoes a scale transform on the containing block", () => {
    // Rendered at 2x: 200x80 on screen for a 100x40 layout box.
    expect(computeTooltipPosition(300, 300, box(100, 100, 200, 80), 100, 40, VIEWPORT)).toEqual({
      left: 107,
      top: 93,
    });
  });

  it("flips to the left of the cursor near the right edge", () => {
    expect(computeTooltipPosition(950, 300, box(0, 0), 100, 40, VIEWPORT).left).toBe(836);
  });

  it("flips above the cursor near the bottom edge", () => {
    expect(computeTooltipPosition(200, 790, box(0, 0), 100, 40, VIEWPORT).top).toBe(736);
  });

  it("clamps to the top-left corner of the bounds", () => {
    expect(computeTooltipPosition(5, 5, box(0, 0, 100, 40), 100, 40, box(0, 0, 50, 20))).toEqual({
      left: 0,
      top: 0,
    });
  });

  it("treats a zero-sized measurement as unscaled", () => {
    expect(computeTooltipPosition(200, 300, box(10, 20, 0, 0), 0, 0, VIEWPORT)).toEqual({
      left: 204,
      top: 266,
    });
  });
});

describe("Tooltip placement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const atom: AtomHoverInfo = {
    kind: "atom",
    atomIndex: 1,
    elementSymbol: "O",
    atomicNumber: 8,
    position: [0, 0, 0],
    screenX: 400,
    screenY: 300,
  };

  it("maps the cursor into an offset containing block after layout", () => {
    // Every measurement reports `left: 0` landing at (250, 120): the tooltip
    // lives under a host ancestor that is the fixed-position containing block.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 250, y: 120, width: 0, height: 0 }),
    );
    render(<Tooltip info={atom} />);
    const el = screen.getByTestId("megane-tooltip");
    expect(el.style.left).toBe("164px");
    expect(el.style.top).toBe("166px");
  });

  it("re-measures when the hovered position changes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 }),
    );
    const { rerender } = render(<Tooltip info={atom} />);
    rerender(<Tooltip info={{ ...atom, screenX: 50, screenY: 60 }} />);
    const el = screen.getByTestId("megane-tooltip");
    expect(el.style.left).toBe("64px");
    expect(el.style.top).toBe("46px");
  });
});
