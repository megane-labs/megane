import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ViewAxisControls } from "@/components/ViewAxisControls";
import { CARTESIAN_VIEW_AXES, LATTICE_VIEW_AXES, VIEW_AXES } from "@/renderer/cameraOrientation";

describe("ViewAxisControls", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders both axis rows when the structure has a cell", () => {
    render(<ViewAxisControls hasCell onAlign={() => {}} />);
    expect(screen.getByTestId("view-axis-controls")).toBeTruthy();
    expect(screen.getByTestId("view-axis-row-lattice")).toBeTruthy();
    expect(screen.getByTestId("view-axis-row-cartesian")).toBeTruthy();
    for (const axis of VIEW_AXES) {
      expect(screen.getByTestId(`view-axis-${axis}`)).toBeTruthy();
    }
  });

  it("hides the crystal-axis row without a cell", () => {
    render(<ViewAxisControls hasCell={false} onAlign={() => {}} />);
    expect(screen.queryByTestId("view-axis-row-lattice")).toBeNull();
    for (const axis of LATTICE_VIEW_AXES) {
      expect(screen.queryByTestId(`view-axis-${axis}`)).toBeNull();
    }
    for (const axis of CARTESIAN_VIEW_AXES) {
      expect(screen.getByTestId(`view-axis-${axis}`)).toBeTruthy();
    }
  });

  it("reports the clicked axis", () => {
    const onAlign = vi.fn();
    render(<ViewAxisControls hasCell onAlign={onAlign} />);
    for (const axis of VIEW_AXES) {
      fireEvent.click(screen.getByTestId(`view-axis-${axis}`));
      expect(onAlign).toHaveBeenLastCalledWith(axis);
    }
    expect(onAlign).toHaveBeenCalledTimes(VIEW_AXES.length);
  });

  it("labels buttons with a typographic minus and names the side in the tooltip", () => {
    render(<ViewAxisControls hasCell onAlign={() => {}} />);
    expect(screen.getByTestId("view-axis--a").textContent).toBe("−a");
    expect(screen.getByTestId("view-axis-+a").textContent).toBe("+a");
    expect(screen.getByTestId("view-axis-+c").getAttribute("title")).toBe(
      "View along the crystal c axis from its + side",
    );
    expect(screen.getByTestId("view-axis--z").getAttribute("title")).toBe(
      "View along the z axis from its − side",
    );
    expect(screen.getByTestId("view-axis-+x").getAttribute("data-axis")).toBe("+x");
  });
});
