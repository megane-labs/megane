/**
 * The sidebar's Inspector: the structure summary with nothing selected, and
 * the selected atoms — their positions, what they measure, and the actions on
 * them — with a selection.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Inspector, MAX_ATOM_ROWS, elementGroups } from "@/builder/Inspector";
import { useBuilderStore } from "@/builder/store";
import { useLibraryStore } from "@/builder/library/store";
import type { Snapshot } from "@/types";

const s = () => useBuilderStore.getState();
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const text = (id: string) => screen.getByTestId(id).textContent;

/** Methanol laid out on the axes: C at the origin, O along x, H around. */
function methanol(): Snapshot {
  return {
    nAtoms: 6,
    nBonds: 5,
    nFileBonds: 5,
    // C, O, H(O), H, H, H
    positions: new Float32Array([
      0, 0, 0, 1.4, 0, 0, 1.4, 1, 0, -0.5, 1, 0, -0.5, -0.5, 0.8, -0.5, -0.5, -0.8,
    ]),
    elements: new Uint8Array([6, 8, 1, 1, 1, 1]),
    bonds: new Uint32Array([0, 1, 1, 2, 0, 3, 0, 4, 0, 5]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  useLibraryStore.setState({ user: [] });
  useBuilderStore.setState(useBuilderStore.getInitialState(), true);
});
afterEach(cleanup);

describe("elementGroups", () => {
  it("groups atoms by element in Hill order", () => {
    const groups = elementGroups([8, 1, 6, 1, 7, 6]);
    expect(groups.map((g) => g.z)).toEqual([6, 1, 7, 8]);
    expect(groups[0].atoms).toEqual([2, 5]);
    // Without carbon, H sorts alphabetically with the rest.
    expect(elementGroups([8, 1, 11]).map((g) => g.z)).toEqual([1, 11, 8]);
  });
});

describe("Inspector — structure", () => {
  it("is empty without a document", () => {
    const { container } = render(<Inspector />);
    expect(container.textContent).toBe("");
  });

  it("summarises the structure and selects every atom of an element", () => {
    s().openStructure(methanol(), null, "meoh.xyz");
    render(<Inspector />);
    expect(text("builder-inspector-formula")).toBe("CH4O");
    expect(text("builder-inspector-atoms")).toBe("6");
    expect(text("builder-inspector-bonds")).toBe("5");
    expect(Number(text("builder-inspector-mass"))).toBeCloseTo(32.04, 1);
    expect(text("builder-inspector-element-H")).toBe("H4");
    click("builder-inspector-element-H");
    expect(s().selected).toEqual([2, 3, 4, 5]);
    // The selection replaces the summary.
    expect(screen.queryByTestId("builder-inspector-structure")).toBeNull();
    expect(text("builder-selected-count")).toBe("4 atoms selected");
  });

  it("an empty cell has no formula and no element chips", () => {
    s().newCell(10);
    render(<Inspector />);
    expect(text("builder-inspector-formula")).toBe("—");
    expect(screen.queryByTestId("builder-inspector-element-C")).toBeNull();
  });
});

describe("Inspector — selection", () => {
  beforeEach(() => s().openStructure(methanol(), null, "meoh.xyz"));

  it("lists each atom and measures 2, 3 and 4 atoms in picking order", () => {
    render(<Inspector />);
    act(() => s().setSelected([0]));
    expect(text("builder-selected-count")).toBe("1 atom selected");
    expect(text("builder-inspector-atom-0")).toContain("C");
    expect(text("builder-inspector-atom-0")).toContain("#0");
    expect(text("builder-inspector-atom-0")).toContain("0.000  0.000  0.000");
    expect(screen.getByTestId("builder-inspector-measure-hint")).toBeTruthy();

    act(() => s().setSelected([0, 1]));
    const measure = () => screen.getByTestId("builder-inspector-measure");
    expect(measure().getAttribute("data-type")).toBe("distance");
    expect(measure().textContent).toContain("1.400 Å");

    // C–O–H: a right angle at O.
    act(() => s().setSelected([0, 1, 2]));
    expect(measure().getAttribute("data-type")).toBe("angle");
    expect(measure().textContent).toContain("90.0°");

    // H–C–O–H with both H on the +y side: cis.
    act(() => s().setSelected([3, 0, 1, 2]));
    expect(measure().getAttribute("data-type")).toBe("dihedral");
    expect(measure().textContent).toMatch(/^Dihedral-?0\.0°$/);

    // Five or more atoms: no measurement, and no hint either.
    act(() => s().setSelected([0, 1, 2, 3, 4]));
    expect(screen.queryByTestId("builder-inspector-measure")).toBeNull();
    expect(screen.queryByTestId("builder-inspector-measure-hint")).toBeNull();
  });

  it(`lists ${MAX_ATOM_ROWS} atoms and counts the rest`, () => {
    const many = { ...methanol() };
    const n = MAX_ATOM_ROWS + 3;
    many.nAtoms = n;
    many.nBonds = 0;
    many.bonds = new Uint32Array(0);
    many.positions = new Float32Array(n * 3).map((_, i) => i);
    many.elements = new Uint8Array(n).fill(6);
    s().openStructure(many, null, "many.xyz");
    render(<Inspector />);
    act(() => s().setSelected(Array.from({ length: n }, (_, i) => i)));
    expect(screen.getByTestId(`builder-inspector-atom-${MAX_ATOM_ROWS - 1}`)).toBeTruthy();
    expect(screen.queryByTestId(`builder-inspector-atom-${MAX_ATOM_ROWS}`)).toBeNull();
    expect(text("builder-inspector-more")).toBe("and 3 more");
  });

  it("changes the element, saves a fragment, deletes and clears", () => {
    render(<Inspector />);
    act(() => s().setSelected([3, 4]));
    fireEvent.change(screen.getByTestId("builder-selection-element"), { target: { value: "9" } });
    expect(s().element).toBe(9);
    expect(text("builder-set-element-selected")).toBe("Set to F");
    click("builder-set-element-selected");
    expect(s().edits[0]).toEqual({ op: "set_element", atoms: [3, 4], element: 9 });

    click("builder-library-save-selection");
    expect(useLibraryStore.getState().user[0].origin).toBe("selection");
    expect(s().notice?.text).toContain("to the library");

    click("builder-delete-selected");
    expect(s().edits[1]).toEqual({ op: "delete_atoms", atoms: [3, 4] });
    expect(s().selected).toEqual([]);

    act(() => s().setSelected([0]));
    click("builder-clear-selection");
    expect(s().selected).toEqual([]);
  });

  it("offers an element outside the quick list as a choice", () => {
    s().setElement(26);
    render(<Inspector />);
    act(() => s().setSelected([0]));
    const select = screen.getByTestId("builder-selection-element") as HTMLSelectElement;
    expect(select.value).toBe("26");
    expect([...select.options].map((o) => o.textContent)).toContain("Fe");
  });

  it("the actions are inert while the original structure is shown", () => {
    s().pushOp({ op: "wrap" });
    render(<Inspector />);
    act(() => {
      s().setShowOriginal(true);
      s().setSelected([0]);
    });
    expect((screen.getByTestId("builder-delete-selected") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId("builder-set-element-selected") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("ignores stale indices past the end of the structure", () => {
    render(<Inspector />);
    act(() => s().setSelected([99]));
    expect(text("builder-selected-count")).toBe("1 atom selected");
    expect(screen.queryByTestId("builder-inspector-atom-0")).toBeNull();
    click("builder-delete-selected");
    click("builder-set-element-selected");
    expect(s().edits).toHaveLength(0);
  });
});
