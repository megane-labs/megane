/**
 * The periodic table behind the tool settings' *Periodic table* button: where
 * each element sits, what it says about one, and choosing one from it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { PeriodicTable, TABLE_MAX_Z, tablePosition } from "@/builder/PeriodicTable";
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
    expect(TABLE_MAX_Z).toBe(92);
    expect(screen.getByTestId("builder-periodic-U")).toBeTruthy();
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
