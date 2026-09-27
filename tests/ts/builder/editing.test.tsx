/**
 * Selection and editing helpers: the right-click atom menu, the Select tool's
 * bar (box, all, invert), the store's multi-atom moves and selection actions,
 * and the history grouped into Undo steps.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { AtomMenu } from "@/builder/AtomMenu";
import { ContextBar } from "@/builder/ContextBar";
import { useBuilderStore, editSteps } from "@/builder/store";
import { describeStep } from "@/builder/placement";
import { resolveShortcut, runShortcut } from "@/builder/shortcuts";
import type { Snapshot } from "@/types";

const s = () => useBuilderStore.getState();
const click = (id: string) => fireEvent.click(screen.getByTestId(id));

/** Methanol (C, O, H×4, bonded) and a separate water O at 10 Å. */
function mixture(): Snapshot {
  return {
    nAtoms: 7,
    nBonds: 5,
    nFileBonds: 5,
    positions: new Float32Array([
      0, 0, 0, 1.4, 0, 0, 1.8, 0.9, 0, -0.4, 1, 0, -0.4, -0.5, 0.9, -0.4, -0.5, -0.9, 10, 10, 10,
    ]),
    elements: new Uint8Array([6, 8, 1, 1, 1, 1, 8]),
    bonds: new Uint32Array([0, 1, 1, 2, 0, 3, 0, 4, 0, 5]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

beforeEach(() => {
  useBuilderStore.setState(useBuilderStore.getInitialState(), true);
  s().openStructure(mixture(), null, "mix.xyz");
});
afterEach(cleanup);

describe("store: selection and moves", () => {
  it("selects all, inverts, and toggles box selection", () => {
    s().selectAll();
    expect(s().selected).toEqual([0, 1, 2, 3, 4, 5, 6]);
    s().setSelected([0, 6]);
    s().invertSelection();
    expect(s().selected).toEqual([1, 2, 3, 4, 5]);
    s().setBoxSelect(true);
    expect(s().boxSelect).toBe(true);
  });

  it("moveAtoms writes one op per distinct displacement, as one Undo step", () => {
    const moved = s().moveAtoms(
      new Map<number, [number, number, number]>([
        [2, [1, 0, 0]],
        [3, [1, 0, 0]],
        [4, [0, 1, 0]],
        [5, [0, 0, 0]], // no move
        [99, [1, 1, 1]], // no such atom
      ]),
    );
    expect(moved).toBe(true);
    expect(s().edits).toEqual([
      { op: "move_atoms", atoms: [2, 3], delta: [1, 0, 0] },
      { op: "move_atoms", atoms: [4], delta: [0, 1, 0] },
    ]);
    expect(editSteps(s().edits)).toHaveLength(1);
    expect(describeStep(editSteps(s().edits)[0])).toBe("Move 3 atoms");
    s().undo();
    expect(s().edits).toEqual([]);
    // Nothing to move, or not editable: nothing written.
    expect(s().moveAtoms(new Map())).toBe(false);
    s().setShowOriginal(true);
    expect(s().moveAtoms(new Map([[2, [1, 0, 0]]]))).toBe(false);
  });

  it("describes a single op and a mixed group", () => {
    expect(describeStep([{ op: "wrap" }])).toBe("Wrap atoms into cell");
    expect(
      describeStep([
        { op: "move_atoms", atoms: [1], delta: [1, 0, 0] },
        { op: "move_atoms", atoms: [], delta: [0, 1, 0] },
      ]),
    ).toBe("Move 1 atom");
    expect(describeStep([{ op: "wrap" }, { op: "wrap" }, { op: "wrap" }])).toBe(
      "Wrap atoms into cell + 2 more",
    );
  });

  it("Ctrl/⌘ + A selects every atom; not in a text field or without a document", () => {
    const host = { open: () => {}, save: () => {}, resetView: () => {} };
    const key = { key: "a", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(resolveShortcut(key)).toEqual({ kind: "select_all" });
    expect(resolveShortcut({ ...key, shiftKey: true })).toBeNull();
    expect(runShortcut({ kind: "select_all" }, useBuilderStore, host)).toBe(true);
    expect(s().selected).toHaveLength(7);
    useBuilderStore.setState(useBuilderStore.getInitialState(), true);
    expect(runShortcut({ kind: "select_all" }, useBuilderStore, host)).toBe(false);
  });
});

describe("Select tool bar", () => {
  it("toggles box selection, selects all and inverts", () => {
    render(<ContextBar />);
    expect(screen.getByTestId("builder-context-label").textContent).toBe("Select");
    click("builder-select-box");
    expect(s().boxSelect).toBe(true);
    expect(screen.getByTestId("builder-select-box").getAttribute("aria-pressed")).toBe("true");
    click("builder-select-all");
    expect(s().selected).toHaveLength(7);
    act(() => s().setSelected([6]));
    click("builder-select-invert");
    expect(s().selected).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("AtomMenu", () => {
  const open = (atom: number, onClose = () => {}) =>
    render(<AtomMenu target={{ atom, x: 10, y: 20 }} onClose={onClose} />);

  it("names the atom and selects its molecule or its element", () => {
    let closed = 0;
    open(1, () => closed++);
    expect(screen.getByTestId("builder-atom-menu").textContent).toContain("O #1");
    click("builder-atom-menu-molecule");
    expect(s().selected).toEqual([0, 1, 2, 3, 4, 5]);
    expect(closed).toBe(1);
    click("builder-atom-menu-element");
    expect(s().selected).toEqual([1, 6]);
  });

  it("changes the atom to the current element and deletes it", () => {
    s().setElement(16);
    open(1);
    expect(screen.getByTestId("builder-atom-menu-set-element").textContent).toBe("Set to S");
    click("builder-atom-menu-set-element");
    expect(s().edits[0]).toMatchObject({ op: "set_element", atoms: [1], element: 16 });
    cleanup();
    open(6);
    act(() => s().setSelected([6]));
    click("builder-atom-menu-delete");
    expect(s().edits.at(-1)).toEqual({ op: "delete_atoms", atoms: [6] });
    expect(s().selected).toEqual([]);
  });

  it("starts a clean-up of the atom's molecule", () => {
    open(0);
    click("builder-atom-menu-cleanup");
    expect(s().selected).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s().notice?.text).toContain("Cleaning up");
  });

  it("disables edits when the atom already has the element or editing is paused", () => {
    s().setElement(8);
    s().pushOp({ op: "wrap" });
    s().setShowOriginal(true);
    open(1);
    for (const id of ["set-element", "delete", "cleanup"]) {
      expect((screen.getByTestId(`builder-atom-menu-${id}`) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
  });

  it("closes on a click elsewhere and on Escape, and shows nothing for a stale atom", () => {
    let closed = 0;
    open(0, () => closed++);
    fireEvent.pointerDown(document.body);
    expect(closed).toBe(1);
    fireEvent.pointerDown(screen.getByTestId("builder-atom-menu"));
    expect(closed).toBe(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(2);
    fireEvent.keyDown(window, { key: "a" });
    expect(closed).toBe(2);
    cleanup();
    const { container } = open(99);
    expect(container.textContent).toBe("");
  });
});
