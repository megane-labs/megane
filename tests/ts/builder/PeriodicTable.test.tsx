/**
 * The periodic table behind the context bar's *Table* button: where each
 * element sits, and choosing one from it.
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
});
