/**
 * The Details panel's Inspector — the selected atoms, their positions, what
 * they measure, and the actions on them — and the info line over the view,
 * which summarises the document and the structure.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Inspector, MAX_ATOM_ROWS } from "@/builder/Inspector";
import { elementGroups } from "@/builder/elements";
import { InfoHud } from "@/builder/InfoHud";
import { useBuilderStore, editSteps } from "@/builder/store";
import { describeStep } from "@/builder/placement";
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

describe("Inspector — nothing selected", () => {
  it("is empty without a selection: the structure is on the info line", () => {
    const { container } = render(<Inspector />);
    expect(container.textContent).toBe("");
    act(() => s().openStructure(methanol(), null, "meoh.xyz"));
    expect(container.textContent).toBe("");
  });
});

describe("InfoHud", () => {
  const hud = (viewed: Snapshot | null, fileName: string | null = null, steps = 0) =>
    render(<InfoHud fileName={fileName} steps={steps} viewed={viewed} left={92} right={384} />);

  it("says what the document is and summarises the structure", () => {
    hud(methanol(), "meoh.xyz", 2);
    expect(text("builder-file-name")).toBe("meoh.xyz · 2 edits");
    expect(text("builder-inspector-formula")).toBe("CH4O");
    expect(text("builder-status-atoms")).toBe("6 atoms · 5 bonds");
    expect(Number(text("builder-inspector-mass"))).toBeCloseTo(32.04, 1);
    expect(text("builder-crystal-cell-summary")).toBe("No cell");
    // It reports only: clicks go through to the view.
    expect(screen.getByTestId("builder-info").style.pointerEvents).toBe("none");
  });

  it("shows the cell, and only the name before anything is open", () => {
    s().newCell(10);
    hud(s().result!.snapshot, "untitled", 1);
    expect(text("builder-file-name")).toBe("untitled · 1 edit");
    expect(text("builder-inspector-formula")).toBe("—");
    expect(text("builder-crystal-cell-summary")).toBe("10.00 × 10.00 × 10.00 Å");
    cleanup();
    hud(null);
    expect(text("builder-file-name")).toBe("No structure");
    expect(screen.queryByTestId("builder-inspector-formula")).toBeNull();
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
    expect(measure().textContent).toMatch(/^Dihedral-?0\.0°Set to/);

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
    // The panel's own choice: the Add / Element tools keep theirs.
    expect(s().element).toBe(6);
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

  it("sets a distance, an angle and a dihedral by number, each one Undo step", () => {
    render(<Inspector />);
    const set = (value: string) => {
      fireEvent.change(screen.getByTestId("builder-inspector-measure-input"), {
        target: { value },
      });
      click("builder-inspector-measure-apply");
    };
    // C–O is 1.400 Å: stretch it; the O side (O and its H) moves.
    act(() => s().setSelected([0, 1]));
    expect((screen.getByTestId("builder-inspector-measure-input") as HTMLInputElement).value).toBe(
      "1.400",
    );
    set("1.6");
    expect(text("builder-inspector-measure")).toContain("1.600 Å");
    expect(s().edits).toEqual([{ op: "move_atoms", atoms: [1, 2], delta: expect.any(Array) }]);

    act(() => s().setSelected([0, 1, 2]));
    set("109.5");
    expect(text("builder-inspector-measure")).toContain("109.5°");

    act(() => s().setSelected([3, 0, 1, 2]));
    set("180");
    expect(text("builder-inspector-measure")).toMatch(/-?180\.0°/);

    // Out of range: nothing moves and the notice says why.
    const before = s().edits.length;
    act(() => s().setSelected([0, 1]));
    set("-1");
    expect(s().edits).toHaveLength(before);
    expect(s().notice?.text).toContain("positive");
    act(() => s().setSelected([0, 1, 2]));
    set("200");
    expect(s().notice?.text).toContain("between 0° and 180°");
    act(() => s().setSelected([3, 0, 1, 2]));
    set("");
    expect(s().notice?.text).toContain("degrees");
  });

  it("Clean up hands the selection's molecules to RDKit", () => {
    render(<Inspector />);
    act(() => s().setSelected([0]));
    click("builder-selection-cleanup");
    expect(s().notice?.text).toContain("Cleaning up");
  });
});

describe("Inspector — bonds, transforms and their feedback", () => {
  const steps = () => editSteps(s().edits).map(describeStep);
  const change = (id: string, value: string) =>
    fireEvent.change(screen.getByTestId(id), { target: { value } });

  beforeEach(() => {
    s().openStructure(methanol(), null, "methanol.xyz");
  });

  it("offers Remove bond for two bonded atoms and rebalances them", () => {
    render(<Inspector />);
    act(() => s().setSelected([0, 2]));
    expect(screen.queryByTestId("builder-remove-bond")).toBeNull();
    act(() => s().setSelected([0, 1]));
    click("builder-remove-bond");
    expect(s().edits[0]).toEqual({ op: "delete_bond", a: 0, b: 1 });
    expect(steps()).toEqual(["Remove bond C #0 – O #1"]);
    // Both stay selected; they are no longer bonded, so the button goes.
    expect(s().selected).toEqual([0, 1]);
    expect(screen.queryByTestId("builder-remove-bond")).toBeNull();
  });

  it("Set to and Delete follow the hydrogen mode and label the step", () => {
    render(<Inspector />);
    act(() => s().setSelected([1]));
    change("builder-selection-element", "7");
    click("builder-set-element-selected");
    // O–H to N: one more H, in the same step.
    expect(s().edits.map((op) => op.op)).toEqual(["set_element", "add_atom"]);
    expect(steps()).toEqual(["Set O #1 to N"]);
    click("builder-delete-selected");
    expect(steps().at(-1)).toBe("Delete N #1 (+2 H)");
  });

  it("says when a Move or Rotate would do nothing, and labels the ones that do", () => {
    render(<Inspector />);
    act(() => s().setSelected([0]));
    click("builder-transform-move");
    expect(s().notice).toEqual({
      level: "info",
      text: "Nothing to move: type a displacement other than 0 0 0 Å.",
    });
    change("builder-transform-angle", "360");
    click("builder-transform-rotate");
    expect(s().notice?.text).toContain("Nothing to rotate");
    expect(s().edits).toHaveLength(0);
    change("builder-transform-dx", "1");
    click("builder-transform-move");
    expect(steps()).toEqual(["Move C #0 by (1.00, 0.00, 0.00) Å"]);
    act(() => s().setSelected([0, 1]));
    change("builder-transform-angle", "90");
    click("builder-transform-rotate");
    expect(steps().at(-1)).toBe("Rotate 2 atoms by 90° about z");
  });

  it("labels a set measurement, and says when it is already there", () => {
    render(<Inspector />);
    act(() => s().setSelected([0, 1]));
    change("builder-inspector-measure-input", "1.5");
    click("builder-inspector-measure-apply");
    expect(steps()).toEqual(["Set distance C #0 – O #1 to 1.500 Å"]);
    change("builder-inspector-measure-input", "1.5");
    click("builder-inspector-measure-apply");
    expect(s().notice?.text).toBe("The distance is already 1.500 Å.");
    act(() => s().setSelected([0, 1, 2]));
    change("builder-inspector-measure-input", "100");
    click("builder-inspector-measure-apply");
    expect(steps().at(-1)).toBe("Set angle C #0 – O #1 – H #2 to 100.0°");
  });

  it("says when a ring keeps the rest of the structure from following", () => {
    // Close methanol's C–O–H into a ring with an H–C bond.
    s().pushOp({ op: "add_bond", a: 2, b: 0 });
    render(<Inspector />);
    act(() => s().setSelected([0, 1]));
    change("builder-inspector-measure-input", "1.6");
    click("builder-inspector-measure-apply");
    expect(s().notice?.text).toBe(
      "C #0 – O #1 is in a ring, so only O #1 moved; its other ring bonds stretched.",
    );
    // A dihedral about a ring bond cannot turn at all.
    const before = s().edits.length;
    act(() => s().setSelected([3, 0, 1, 2]));
    change("builder-inspector-measure-input", "60");
    click("builder-inspector-measure-apply");
    expect(s().notice?.text).toBe(
      "C #0 – O #1 is a ring bond: its dihedral cannot be turned on its own.",
    );
    expect(s().edits).toHaveLength(before);
  });
});
