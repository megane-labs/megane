/**
 * The tool rail left of the view, the context bar over it, and the status-bar
 * hint that says what a click does.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToolRail, TOOLS, toolHint, toolInfo } from "@/builder/ToolRail";
import { ContextBar, QUICK_ELEMENTS, BOND_ORDERS } from "@/builder/ContextBar";
import { useBuilderStore } from "@/builder/store";
import { TOOL_KEYS } from "@/builder/shortcuts";
import { useLibraryUi } from "@/builder/library/ui";
import { act } from "@testing-library/react";

beforeEach(() => {
  useBuilderStore.setState({
    tool: "select",
    element: 6,
    bondOrder: 1,
    pendingBondAtom: null,
    placeSource: null,
    adsorbHeight: null,
  });
  useLibraryUi.setState({ sketch: null, galleryOpen: false });
});
afterEach(cleanup);

describe("ToolRail", () => {
  it("offers every tool once, with its key, and marks the current one", () => {
    render(<ToolRail />);
    const buttons = screen.getByTestId("builder-tool-rail").querySelectorAll("button");
    expect(buttons).toHaveLength(TOOLS.length);
    for (const t of TOOLS) {
      const b = screen.getByTestId(`builder-tool-${t.value}`);
      expect(b.getAttribute("aria-label")).toBe(`${t.label} (${TOOL_KEYS[t.value]})`);
      expect(b.textContent).toBe(TOOL_KEYS[t.value]);
    }
    expect(screen.getByTestId("builder-tool-select").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("builder-tool-add").getAttribute("aria-checked")).toBe("false");
  });

  it("a click picks the tool", () => {
    render(<ToolRail />);
    fireEvent.click(screen.getByTestId("builder-tool-bond"));
    expect(useBuilderStore.getState().tool).toBe("bond");
    expect(screen.getByTestId("builder-tool-bond").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("builder-tool-select").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("toolHint", () => {
  it("is the tool's hint, plus the pending bond atom or the molecule being placed", () => {
    expect(toolHint("select", null, null)).toBe(toolInfo("select").hint);
    expect(toolHint("bond", null, null)).toBe(toolInfo("bond").hint);
    expect(toolHint("bond", 3, null)).toMatch(/First atom: #3\.$/);
    // A pending bond atom means nothing to any other tool.
    expect(toolHint("add", 3, null)).toBe(toolInfo("add").hint);
    expect(toolHint("place", null, null)).toMatch(/Choose a molecule in the library\.$/);
    expect(toolHint("place", null, { name: "Water" })).toMatch(/Placing Water\.$/);
  });
});

describe("ContextBar", () => {
  it("is absent for a tool with no settings", () => {
    for (const tool of ["move", "delete"] as const) {
      useBuilderStore.setState({ tool });
      const { unmount } = render(<ContextBar />);
      expect(screen.queryByTestId("builder-context-bar")).toBeNull();
      unmount();
    }
  });

  it("Add atom: quick elements, any Z, and the bond order", () => {
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    expect(screen.getByTestId("builder-context-label").textContent).toBe("Add atom");
    expect(screen.getAllByRole("button", { pressed: true }).map((b) => b.textContent)).toEqual([
      "C",
    ]);
    expect(QUICK_ELEMENTS[0]).toBe(6);

    fireEvent.click(screen.getByTestId("builder-element-N"));
    expect(useBuilderStore.getState().element).toBe(7);
    expect(screen.getByTestId("builder-element-N").getAttribute("aria-pressed")).toBe("true");

    // Any atomic number; out-of-range or empty input is ignored.
    const z = screen.getByTestId("builder-element-z");
    fireEvent.change(z, { target: { value: "26" } });
    expect(useBuilderStore.getState().element).toBe(26);
    expect(screen.getByTestId("builder-element-symbol").textContent).toBe("Fe");
    fireEvent.change(z, { target: { value: "200" } });
    fireEvent.change(z, { target: { value: "" } });
    expect(useBuilderStore.getState().element).toBe(26);

    for (const o of BOND_ORDERS) {
      fireEvent.click(screen.getByTestId(`builder-bond-order-${o.value}`));
      expect(useBuilderStore.getState().bondOrder).toBe(o.value);
      expect(screen.getByTestId(`builder-bond-order-${o.value}`).getAttribute("aria-checked")).toBe(
        "true",
      );
    }
  });

  it("Bond shows only the bond order; Element only the element", () => {
    useBuilderStore.setState({ tool: "bond" });
    const { unmount } = render(<ContextBar />);
    expect(screen.getByTestId("builder-bond-order")).toBeTruthy();
    expect(screen.queryByTestId("builder-element-z")).toBeNull();
    unmount();
    useBuilderStore.setState({ tool: "element" });
    render(<ContextBar />);
    expect(screen.getByTestId("builder-element-z")).toBeTruthy();
    expect(screen.queryByTestId("builder-bond-order")).toBeNull();
  });

  it("Place: the adsorption height, kept while the option is off", () => {
    useBuilderStore.setState({ tool: "place" });
    render(<ContextBar />);
    expect(screen.queryByTestId("builder-element-z")).toBeNull();
    fireEvent.change(screen.getByTestId("builder-adsorb-height"), { target: { value: "2.5" } });
    expect(useBuilderStore.getState().adsorbHeight).toBeNull();
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBe(2.5);
    fireEvent.change(screen.getByTestId("builder-adsorb-height"), { target: { value: "3" } });
    expect(useBuilderStore.getState().adsorbHeight).toBe(3);
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBeNull();
  });

  it("Place: the molecule picker opens the gallery, which a choice closes", () => {
    useBuilderStore.setState({ tool: "place" });
    render(<ContextBar />);
    // Nothing to place yet: the gallery is open straight away.
    expect(screen.getByTestId("builder-library")).toBeTruthy();
    expect(screen.getByTestId("builder-place-fragment").textContent).toContain("Choose a molecule");
    expect(screen.getByTestId("builder-place-fragment").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:benzene")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    expect(useBuilderStore.getState().placeSource?.id).toBe("preset:benzene");
    expect(screen.queryByTestId("builder-library")).toBeNull();
    expect(screen.getByTestId("builder-place-fragment").textContent).toContain("Benzene");
    // The picker toggles it; so does the gallery's own close button.
    fireEvent.click(screen.getByTestId("builder-place-fragment"));
    expect(screen.getByTestId("builder-library")).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-library-close"));
    expect(screen.queryByTestId("builder-library")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-place-fragment"));
    // Leaving the tool closes it, and coming back with a molecule keeps it shut.
    act(() => useBuilderStore.getState().setTool("select"));
    expect(useLibraryUi.getState().galleryOpen).toBe(false);
    act(() => useBuilderStore.getState().setTool("place"));
    expect(screen.queryByTestId("builder-library")).toBeNull();
  });
});
