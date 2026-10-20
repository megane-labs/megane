/**
 * The tool settings card: the Hydrogens setting, the element field and its
 * quick, metal and recent buttons, select-by-element with modifiers, the
 * radio groups' arrow keys, and the adsorption height.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  ContextBar,
  HYDROGEN_MODES,
  METAL_ELEMENTS,
  QUICK_ELEMENTS,
  hydrogenHint,
  selectByElement,
  parseAdsorbHeight,
} from "@/builder/ContextBar";
import { useBuilderStore } from "@/builder/store";
import { useRecentElements } from "@/builder/elements";
import { useLibraryUi } from "@/builder/library/ui";
import { getElementSymbol } from "@/constants";

const state = () => useBuilderStore.getState();

beforeEach(() => {
  useBuilderStore.setState(useBuilderStore.getInitialState(), true);
  useRecentElements.setState({ recent: [] });
  useLibraryUi.setState({ sketch: null, galleryOpen: false });
});
afterEach(cleanup);

/** A document holding the given elements. */
function doc(...elements: number[]) {
  state().newCell(10);
  elements.forEach((element, i) =>
    state().pushOp({ op: "add_atom", id: `a${i}`, element, position: [i, 1, 1] }),
  );
}

describe("hydrogenHint", () => {
  it("says what each mode does, and what Auto does for this structure", () => {
    expect(hydrogenHint("auto", true)).toMatch(/^Auto: on — this structure has explicit H/);
    expect(hydrogenHint("auto", false)).toMatch(/^Auto: off — bare skeleton/);
    expect(hydrogenHint("on", false)).toMatch(/^On:/);
    expect(hydrogenHint("off", true)).toMatch(/^Off:/);
  });
});

describe("ContextBar — Hydrogens", () => {
  it("is a radio group bound to the store, with a hint for the open structure", () => {
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    const group = screen.getByTestId("builder-hydrogens");
    expect(group.getAttribute("role")).toBe("radiogroup");
    const radios = screen.getAllByRole("radio").filter((r) => group.contains(r));
    expect(radios.map((r) => r.textContent)).toEqual(HYDROGEN_MODES.map((m) => m.label));
    expect(screen.getByTestId("builder-hydrogens-auto").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("builder-hydrogens-auto").tabIndex).toBe(0);
    expect(screen.getByTestId("builder-hydrogens-on").tabIndex).toBe(-1);
    // Nothing open: a bare skeleton.
    expect(screen.getByTestId("builder-hydrogens-hint").textContent).toMatch(/^Auto: off/);

    fireEvent.click(screen.getByTestId("builder-hydrogens-off"));
    expect(state().hydrogenMode).toBe("off");
    expect(screen.getByTestId("builder-hydrogens-off").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("builder-hydrogens-hint").textContent).toMatch(/^Off:/);
  });

  it("Auto follows whether the document has explicit H", () => {
    doc(6, 1);
    useBuilderStore.setState({ tool: "element" });
    render(<ContextBar />);
    expect(screen.getByTestId("builder-hydrogens-hint").textContent).toMatch(/^Auto: on/);
    cleanup();
    doc(6, 8);
    useBuilderStore.setState({ tool: "element" });
    render(<ContextBar />);
    expect(screen.getByTestId("builder-hydrogens-hint").textContent).toMatch(/^Auto: off/);
  });

  it("arrow keys, Home and End move the choice", () => {
    useBuilderStore.setState({ tool: "bond" });
    render(<ContextBar />);
    const auto = screen.getByTestId("builder-hydrogens-auto");
    auto.focus();
    fireEvent.keyDown(auto, { key: "ArrowRight" });
    expect(state().hydrogenMode).toBe("on");
    expect(document.activeElement).toBe(screen.getByTestId("builder-hydrogens-on"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(state().hydrogenMode).toBe("off");
    // Wraps around both ways.
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(state().hydrogenMode).toBe("auto");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(state().hydrogenMode).toBe("off");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(state().hydrogenMode).toBe("on");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(state().hydrogenMode).toBe("auto");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(state().hydrogenMode).toBe("off");
    // Other keys and keys outside a radio do nothing.
    fireEvent.keyDown(document.activeElement!, { key: "a" });
    expect(state().hydrogenMode).toBe("off");
    fireEvent.keyDown(screen.getByTestId("builder-hydrogens"), { key: "ArrowRight" });
    expect(state().hydrogenMode).toBe("off");
  });

  it("the bond order answers arrow keys too", () => {
    useBuilderStore.setState({ tool: "bond", bondOrder: 1 });
    render(<ContextBar />);
    const single = screen.getByTestId("builder-bond-order-1");
    expect(single.tabIndex).toBe(0);
    expect(screen.getByTestId("builder-bond-order-2").tabIndex).toBe(-1);
    fireEvent.keyDown(single, { key: "ArrowRight" });
    expect(state().bondOrder).toBe(2);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(state().bondOrder).toBe(4);
  });

  it("is not offered by tools that do not change atoms", () => {
    for (const tool of ["select", "move", "place"] as const) {
      useBuilderStore.setState({ tool });
      const { unmount } = render(<ContextBar />);
      expect(screen.queryByTestId("builder-hydrogens")).toBeNull();
      unmount();
    }
  });
});

describe("ContextBar — Element", () => {
  it("offers metals beside the common elements", () => {
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    for (const z of [...QUICK_ELEMENTS, ...METAL_ELEMENTS]) {
      expect(screen.getByTestId(`builder-element-${getElementSymbol(z)}`)).toBeTruthy();
    }
    expect(screen.getByRole("group", { name: "Metals" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-element-Au"));
    expect(state().element).toBe(79);
    expect(screen.getByTestId("builder-element-Au").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("builder-element-symbol").textContent).toBe("Au");
  });

  it("takes a symbol in any case or an atomic number, and marks what it cannot use", () => {
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    const field = screen.getByTestId("builder-element-z") as HTMLInputElement;
    expect(field.value).toBe("6");
    expect(field.getAttribute("aria-invalid")).toBe("false");
    // The field can be cleared and typed into again.
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "" } });
    expect(field.value).toBe("");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(state().element).toBe(6);
    fireEvent.change(field, { target: { value: "fe" } });
    expect(state().element).toBe(26);
    expect(field.value).toBe("fe");
    expect(field.getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByTestId("builder-element-symbol").textContent).toBe("Fe");
    fireEvent.change(field, { target: { value: "Xx" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.style.border).toContain("1px solid");
    expect(state().element).toBe(26);
    // Enter keeps an invalid draft, so it can be fixed.
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("Xx");
    fireEvent.change(field, { target: { value: "118" } });
    expect(state().element).toBe(118);
    fireEvent.change(field, { target: { value: "119" } });
    expect(state().element).toBe(118);
    // Leaving the field drops the invalid draft.
    fireEvent.blur(field);
    expect(field.value).toBe("118");
    expect(field.getAttribute("aria-invalid")).toBe("false");
  });

  it("Enter and leaving the field settle it, and remember the element", () => {
    useBuilderStore.setState({ tool: "element" });
    render(<ContextBar />);
    const field = screen.getByTestId("builder-element-z") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "se" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(state().element).toBe(34);
    expect(field.value).toBe("34");
    expect(useRecentElements.getState().recent).toEqual([34]);
    expect(screen.getByTestId("builder-element-recent-Se").getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.change(field, { target: { value: "Ga" } });
    fireEvent.blur(field);
    expect(useRecentElements.getState().recent).toEqual([31, 34]);
    // A blur with nothing typed remembers nothing.
    fireEvent.blur(field);
    expect(useRecentElements.getState().recent).toEqual([31, 34]);
    // A recent button picks its element.
    fireEvent.click(screen.getByTestId("builder-element-recent-Se"));
    expect(state().element).toBe(34);
  });

  it("Escape puts back the element held before typing", () => {
    useBuilderStore.setState({ tool: "add", element: 8 });
    render(<ContextBar />);
    const field = screen.getByTestId("builder-element-z") as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.change(field, { target: { value: "17" } });
    expect(state().element).toBe(17);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(state().element).toBe(8);
    expect(field.value).toBe("8");
    expect(useRecentElements.getState().recent).toEqual([]);
    // Escape with nothing typed changes nothing.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(state().element).toBe(8);
    // An invalid draft only: the element never changed.
    fireEvent.change(field, { target: { value: "q" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(state().element).toBe(8);
    expect(field.value).toBe("8");
  });

  it("the Recent row leaves out elements that already have a button", () => {
    useRecentElements.setState({ recent: [6, 26, 47] });
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(recent.textContent).toBe("RecentAg");
    expect(screen.queryByTestId("builder-element-recent-C")).toBeNull();
  });

  it("a pick from the periodic table is remembered", () => {
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
    fireEvent.click(screen.getByTestId("builder-element-table"));
    fireEvent.click(screen.getByTestId("builder-periodic-Ru"));
    expect(state().element).toBe(44);
    expect(screen.getByTestId("builder-element-recent-Ru")).toBeTruthy();
  });
});

describe("selectByElement", () => {
  it("replaces, adds, or toggles off a fully selected element", () => {
    expect(selectByElement([0, 5], [1, 2])).toEqual([1, 2]);
    expect(selectByElement([0, 1], [1, 2], { add: true })).toEqual([0, 1, 2]);
    expect(selectByElement([0, 1], [1, 2], { toggle: true })).toEqual([0, 1, 2]);
    expect(selectByElement([0, 1, 2], [1, 2], { toggle: true })).toEqual([0]);
    // Shift only ever adds.
    expect(selectByElement([0, 1, 2], [1, 2], { add: true })).toEqual([0, 1, 2]);
  });
});

describe("ContextBar — select by element", () => {
  it("Shift adds an element to the selection, Ctrl/⌘ toggles it", () => {
    doc(6, 1, 1, 8);
    useBuilderStore.setState({ tool: "select" });
    render(<ContextBar />);
    const h = screen.getByTestId("builder-inspector-element-H");
    const o = screen.getByTestId("builder-inspector-element-O");
    expect(h.title).toMatch(/Shift adds/);
    fireEvent.click(h);
    expect(state().selected).toEqual([1, 2]);
    fireEvent.click(o, { shiftKey: true });
    expect(state().selected).toEqual([1, 2, 3]);
    fireEvent.click(h, { ctrlKey: true });
    expect(state().selected).toEqual([3]);
    fireEvent.click(h, { metaKey: true });
    expect(state().selected).toEqual([3, 1, 2]);
    fireEvent.click(o);
    expect(state().selected).toEqual([3]);
  });
});

describe("parseAdsorbHeight", () => {
  it("accepts only finite heights above zero", () => {
    expect(parseAdsorbHeight("2.5")).toBe(2.5);
    expect(parseAdsorbHeight("")).toBeNull();
    expect(parseAdsorbHeight("  ")).toBeNull();
    expect(parseAdsorbHeight("0")).toBeNull();
    expect(parseAdsorbHeight("-1")).toBeNull();
    expect(parseAdsorbHeight("abc")).toBeNull();
    expect(parseAdsorbHeight("Infinity")).toBeNull();
  });
});

describe("ContextBar — Place on atoms", () => {
  it("never uses a blank or non-positive height, and says which way is up", () => {
    useBuilderStore.setState({ tool: "place" });
    render(<ContextBar />);
    const height = screen.getByTestId("builder-adsorb-height") as HTMLInputElement;
    expect(height.closest("label")!.textContent).toContain(
      "Å above the atom along c (or +z without a cell)",
    );
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(state().adsorbHeight).toBe(2);
    fireEvent.change(height, { target: { value: "" } });
    expect(height.getAttribute("aria-invalid")).toBe("true");
    expect(state().adsorbHeight).toBe(2);
    fireEvent.change(height, { target: { value: "-1" } });
    expect(state().adsorbHeight).toBe(2);
    fireEvent.change(height, { target: { value: "0" } });
    expect(state().adsorbHeight).toBe(2);
    // Leaving the field puts the last good height back.
    fireEvent.blur(height);
    expect(height.value).toBe("2");
    expect(height.getAttribute("aria-invalid")).toBe("false");
    fireEvent.change(height, { target: { value: "3.5" } });
    expect(state().adsorbHeight).toBe(3.5);
    // A valid field left alone stays as typed.
    fireEvent.blur(height);
    expect(height.value).toBe("3.5");
    // Off, then on with an invalid draft: the last good height is used.
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(state().adsorbHeight).toBeNull();
    fireEvent.change(height, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(state().adsorbHeight).toBe(3.5);
  });
});

describe("ContextBar — periodic table focus", () => {
  it("hands focus back to its button when Escape closes it", () => {
    useBuilderStore.setState({ tool: "add", element: 26 });
    render(<ContextBar />);
    const button = screen.getByTestId("builder-element-table");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByTestId("builder-periodic-Fe"));
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByTestId("builder-periodic-table")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
