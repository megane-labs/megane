/**
 * The periodic table behind the tool settings' *Periodic table* button: where
 * each element sits, what it says about one, and choosing one from it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  PeriodicTable,
  TABLE_MAX_Z,
  tableNeighbour,
  tablePosition,
  typeAheadMatch,
} from "@/builder/PeriodicTable";
import { ContextBar } from "@/builder/ContextBar";
import { useBuilderStore } from "@/builder/store";

beforeEach(() => useBuilderStore.setState(useBuilderStore.getInitialState(), true));
afterEach(cleanup);

describe("tablePosition", () => {
  it("places each block where the long-form table has it", () => {
    const at = (z: number) => tablePosition(z);
    expect(at(1)).toEqual({ row: 1, col: 1 });
    expect(at(2)).toEqual({ row: 1, col: 18 });
    expect(at(3)).toEqual({ row: 2, col: 1 });
    expect(at(5)).toEqual({ row: 2, col: 13 }); // B
    expect(at(10)).toEqual({ row: 2, col: 18 }); // Ne
    expect(at(12)).toEqual({ row: 3, col: 2 }); // Mg
    expect(at(13)).toEqual({ row: 3, col: 13 }); // Al
    expect(at(26)).toEqual({ row: 4, col: 8 }); // Fe
    expect(at(54)).toEqual({ row: 5, col: 18 }); // Xe
    expect(at(56)).toEqual({ row: 6, col: 2 }); // Ba
    expect(at(57)).toEqual({ row: 9, col: 3 }); // La, first lanthanide
    expect(at(71)).toEqual({ row: 9, col: 17 }); // Lu
    expect(at(72)).toEqual({ row: 6, col: 4 }); // Hf
    expect(at(79)).toEqual({ row: 6, col: 11 }); // Au
    expect(at(86)).toEqual({ row: 6, col: 18 }); // Rn
    expect(at(88)).toEqual({ row: 7, col: 2 }); // Ra
    expect(at(92)).toEqual({ row: 10, col: 6 }); // U
    expect(at(104)).toEqual({ row: 7, col: 4 }); // Rf
  });

  it("gives every element its own cell", () => {
    const seen = new Set<string>();
    for (let z = 1; z <= 118; z++) {
      const { row, col } = tablePosition(z);
      seen.add(`${row},${col}`);
    }
    expect(seen.size).toBe(118);
  });
});

describe("PeriodicTable", () => {
  it("shows every element with a symbol, the current one pressed", () => {
    let picked = 0;
    render(<PeriodicTable value={26} onPick={(z) => (picked = z)} onClose={() => {}} />);
    expect(TABLE_MAX_Z).toBe(118);
    expect(screen.getByTestId("builder-periodic-U")).toBeTruthy();
    expect(screen.getByTestId("builder-periodic-Np")).toBeTruthy();
    expect(screen.getByTestId("builder-periodic-Og")).toBeTruthy();
    expect(screen.getByTestId("builder-periodic-Fe").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("builder-periodic-Cu").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("builder-periodic-Cu"));
    expect(picked).toBe(29);
  });

  it("opens from the context bar, sets the element and closes", () => {
    useBuilderStore.setState({ tool: "add" });
    render(<ContextBar />);
    const toggle = screen.getByTestId("builder-element-table");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("builder-periodic-Pt"));
    expect(useBuilderStore.getState().element).toBe(78);
    expect(screen.getByTestId("builder-element-symbol").textContent).toBe("Pt");
    expect(screen.queryByTestId("builder-periodic-table")).toBeNull();

    // Escape closes it, and so does switching to another tool.
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-periodic-table")).toBeNull();
    fireEvent.click(toggle);
    act(() => useBuilderStore.setState({ tool: "element" }));
    expect(screen.queryByTestId("builder-periodic-table")).toBeNull();
  });

  it("describes the element under the pointer, else the current one", () => {
    render(<PeriodicTable value={26} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId("builder-periodic-info-name").textContent).toBe("Iron");
    expect(screen.getByTestId("builder-periodic-info").textContent).toContain("Transition metal");
    fireEvent.mouseEnter(screen.getByTestId("builder-periodic-Ne"));
    expect(screen.getByTestId("builder-periodic-info-name").textContent).toBe("Neon");
    expect(screen.getByTestId("builder-periodic-info").textContent).toContain("Noble gas");
    expect(screen.getByTestId("builder-periodic-info").textContent).toContain("20.180 u");
    fireEvent.mouseLeave(screen.getByTestId("builder-periodic-Ne").parentElement!);
    expect(screen.getByTestId("builder-periodic-info-name").textContent).toBe("Iron");
    // Keyboard focus shows it too; uranium's mass has two decimals.
    fireEvent.focus(screen.getByTestId("builder-periodic-U"));
    expect(screen.getByTestId("builder-periodic-info").textContent).toContain("Actinide");
    expect(screen.getByTestId("builder-periodic-info").textContent).toMatch(/238\.\d\d u/);
  });

  it("closes on a click outside or on ×, not on a click inside or on its button", () => {
    const anchor = { current: document.createElement("button") };
    document.body.append(anchor.current);
    let closed = 0;
    render(<PeriodicTable value={6} anchor={anchor} onPick={() => {}} onClose={() => closed++} />);
    fireEvent.pointerDown(screen.getByTestId("builder-periodic-info"));
    fireEvent.pointerDown(anchor.current);
    expect(closed).toBe(0);
    fireEvent.pointerDown(document.body);
    expect(closed).toBe(1);
    fireEvent.click(screen.getByTestId("builder-periodic-close"));
    expect(closed).toBe(2);
    anchor.current.remove();
  });

  it("sits left of the panel its button is in, inside the window", () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-collapsed", "false");
    const button = document.createElement("button");
    panel.append(button);
    document.body.append(panel);
    const rect = (left: number, top: number) =>
      ({ left, top, right: left + 10, bottom: top + 10, width: 10, height: 10 }) as DOMRect;
    panel.getBoundingClientRect = () => rect(900, 0);
    button.getBoundingClientRect = () => rect(950, 200);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 600 });
    try {
      render(
        <PeriodicTable
          value={6}
          anchor={{ current: button }}
          onPick={() => {}}
          onClose={() => {}}
        />,
      );
      const table = screen.getByTestId("builder-periodic-table");
      expect(table.style.left).toBe("290px");
      expect(table.style.top).toBe("188px");
      expect(table.style.visibility).toBe("visible");
    } finally {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", original);
      panel.remove();
    }
  });
});

describe("tableNeighbour", () => {
  it("moves along a row, skipping the gaps", () => {
    expect(tableNeighbour(1, "ArrowRight")).toBe(2); // H → He across the gap
    expect(tableNeighbour(2, "ArrowRight")).toBe(2); // nothing right of He
    expect(tableNeighbour(4, "ArrowRight")).toBe(5); // Be → B across the d block
    expect(tableNeighbour(5, "ArrowLeft")).toBe(4);
    expect(tableNeighbour(3, "ArrowLeft")).toBe(3);
    expect(tableNeighbour(56, "ArrowRight")).toBe(72); // Ba → Hf past the f block
  });

  it("moves to the nearest row with a cell in or near the column", () => {
    expect(tableNeighbour(1, "ArrowDown")).toBe(3); // H → Li
    expect(tableNeighbour(2, "ArrowDown")).toBe(10); // He → Ne
    expect(tableNeighbour(26, "ArrowUp")).toBe(13); // Fe (col 8) → Al (col 13), nearest in row 3
    expect(tableNeighbour(26, "ArrowDown")).toBe(44); // Fe → Ru
    expect(tableNeighbour(88, "ArrowDown")).toBe(57); // Ra → La, the f rows below
    expect(tableNeighbour(57, "ArrowDown")).toBe(89); // La → Ac
    expect(tableNeighbour(92, "ArrowDown")).toBe(92); // nothing below the actinides
    expect(tableNeighbour(1, "ArrowUp")).toBe(1);
  });

  it("Home and End go to the row's ends; other keys stay", () => {
    expect(tableNeighbour(8, "Home")).toBe(3);
    expect(tableNeighbour(8, "End")).toBe(10);
    expect(tableNeighbour(3, "Home")).toBe(3);
    expect(tableNeighbour(8, "Enter")).toBe(8);
  });
});

describe("typeAheadMatch", () => {
  it("names the element whose symbol it is, else the lightest that starts so", () => {
    expect(typeAheadMatch("fe")).toBe(26);
    expect(typeAheadMatch("F")).toBe(9);
    expect(typeAheadMatch("Z")).toBe(30); // Zn before Zr
    expect(typeAheadMatch("q")).toBeNull();
    expect(typeAheadMatch("")).toBeNull();
  });
});

describe("PeriodicTable — keyboard", () => {
  function open(value = 26) {
    const anchor = { current: document.createElement("button") };
    document.body.append(anchor.current);
    const onPick = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <PeriodicTable value={value} anchor={anchor} onPick={onPick} onClose={onClose} />,
    );
    return { anchor: anchor.current, onPick, onClose, view };
  }
  const cell = (sym: string) => screen.getByTestId(`builder-periodic-${sym}`);

  it("opens on the current element, the one cell Tab reaches", () => {
    const { anchor } = open(26);
    expect(document.activeElement).toBe(cell("Fe"));
    expect(cell("Fe").tabIndex).toBe(0);
    expect(cell("Cu").tabIndex).toBe(-1);
    anchor.remove();
  });

  it("starts from H for an element the table does not show", () => {
    const { anchor } = open(0);
    expect(document.activeElement).toBe(cell("H"));
    anchor.remove();
  });

  it("starts from a superheavy element, which the table shows too", () => {
    const { anchor } = open(110);
    expect(document.activeElement).toBe(cell("Ds"));
    expect(screen.getByTestId("builder-periodic-info-name").textContent).toBe("Darmstadtium");
    anchor.remove();
  });

  it("moves with the arrow keys and picks with Enter or Space", () => {
    const { anchor, onPick } = open(26);
    fireEvent.keyDown(cell("Fe"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("Co"));
    expect(cell("Co").tabIndex).toBe(0);
    expect(screen.getByTestId("builder-periodic-info-name").textContent).toBe("Cobalt");
    fireEvent.keyDown(cell("Co"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell("Rh"));
    fireEvent.keyDown(cell("Rh"), { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith(45);
    // Focus was in the table, so it goes back to the button.
    expect(document.activeElement).toBe(anchor);
    fireEvent.keyDown(cell("Rh"), { key: " " });
    expect(onPick).toHaveBeenCalledTimes(2);
    // Keys that mean nothing here are left alone.
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    cell("Rh").dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    anchor.remove();
  });

  it("jumps to a typed symbol, and starts over after a pause or a miss", () => {
    const now = vi.spyOn(Date, "now");
    const { anchor } = open(6);
    try {
      now.mockReturnValue(1000);
      fireEvent.keyDown(cell("C"), { key: "f" });
      expect(document.activeElement).toBe(cell("F"));
      now.mockReturnValue(1200);
      fireEvent.keyDown(cell("F"), { key: "e" });
      expect(document.activeElement).toBe(cell("Fe"));
      // After a pause a letter starts a new symbol.
      now.mockReturnValue(5000);
      fireEvent.keyDown(cell("Fe"), { key: "n" });
      expect(document.activeElement).toBe(cell("N"));
      // "Nq" names nothing and neither does "q": focus stays.
      now.mockReturnValue(5100);
      fireEvent.keyDown(cell("N"), { key: "q" });
      expect(document.activeElement).toBe(cell("N"));
      // "Qa" is no symbol: start over from "a".
      now.mockReturnValue(5200);
      fireEvent.keyDown(cell("N"), { key: "a" });
      expect(document.activeElement).toBe(cell("Al"));
      // A letter with Ctrl is a shortcut, not type-ahead.
      const ctrl = new KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      cell("Al").dispatchEvent(ctrl);
      expect(ctrl.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(cell("Al"));
    } finally {
      now.mockRestore();
      anchor.remove();
    }
  });

  it("Escape and × close it and give focus back to the button", () => {
    const first = open(6);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(first.anchor);
    first.view.unmount();
    first.anchor.remove();
    const second = open(6);
    screen.getByTestId("builder-periodic-close").focus();
    fireEvent.click(screen.getByTestId("builder-periodic-close"));
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(second.anchor);
    second.anchor.remove();
  });

  it("leaves focus alone when it was elsewhere", () => {
    const other = document.createElement("input");
    document.body.append(other);
    const { anchor, onClose } = open(6);
    other.focus();
    fireEvent.pointerDown(other);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(other);
    other.remove();
    anchor.remove();
  });
});
