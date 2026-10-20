/**
 * "New structure": the one place a document starts from scratch — an empty
 * cell or a bulk crystal (the form that used to be the Crystal section's
 * Bulk tab).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NewStructureDialog, DEFAULT_NEW_CELL_EDGE } from "@/builder/NewStructureDialog";

const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const type = (id: string, value: string) =>
  fireEvent.change(screen.getByTestId(id), { target: { value } });

const onNewCell = vi.fn();
const onNewBulk = vi.fn();
const onClose = vi.fn();

function open(props: Partial<React.ComponentProps<typeof NewStructureDialog>> = {}) {
  render(
    <NewStructureDialog
      hasDocument={false}
      onNewCell={onNewCell}
      onNewBulk={onNewBulk}
      onClose={onClose}
      {...props}
    />,
  );
}

beforeEach(() => {
  onNewCell.mockReset();
  onNewBulk.mockReset();
  onClose.mockReset();
});
afterEach(cleanup);

describe("NewStructureDialog — empty cell", () => {
  it("creates a cell of the given edge and closes", () => {
    open();
    expect((screen.getByTestId("builder-new-cell-edge") as HTMLInputElement).value).toBe(
      String(DEFAULT_NEW_CELL_EDGE),
    );
    expect(screen.queryByTestId("builder-new-replaces")).toBeNull();
    type("builder-new-cell-edge", "15");
    click("builder-new-cell");
    expect(onNewCell).toHaveBeenCalledWith(15);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refuses an edge of zero and warns when a document is open", () => {
    open({ hasDocument: true });
    expect(screen.getByTestId("builder-new-replaces")).toBeTruthy();
    type("builder-new-cell-edge", "0");
    click("builder-new-cell");
    expect(onNewCell).not.toHaveBeenCalled();
  });

  it("closes on Escape and on Close, not on a click inside the form", () => {
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    click("builder-new-close");
    expect(onClose).toHaveBeenCalledTimes(2);
    // It is a form in the Details panel, not a modal: no backdrop to dismiss.
    fireEvent.click(screen.getByTestId("builder-new-dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("NewStructureDialog — bulk crystal", () => {
  it("builds a spec from the fields, from an example, and reports a bad element", () => {
    open({ initialKind: "bulk" });
    click("builder-bulk-create");
    expect(onNewBulk).toHaveBeenCalledWith({
      structure: "fcc",
      elements: [29],
      a: 3.61,
      cubic: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The primitive cell of another element.
    click("builder-bulk-cubic");
    type("builder-bulk-element-0", "au");
    type("builder-bulk-a", "4.08");
    click("builder-bulk-create");
    expect(onNewBulk).toHaveBeenLastCalledWith({
      structure: "fcc",
      elements: [79],
      a: 4.08,
      cubic: false,
    });

    // An example fills every field, including c/a for the hexagonal ones.
    fireEvent.change(screen.getByTestId("builder-bulk-example"), { target: { value: "Mg (hcp)" } });
    expect((screen.getByTestId("builder-bulk-structure") as HTMLSelectElement).value).toBe("hcp");
    expect((screen.getByTestId("builder-bulk-covera") as HTMLInputElement).value).toBe("1.624");
    expect(screen.queryByTestId("builder-bulk-cubic")).toBeNull();
    click("builder-bulk-create");
    expect(onNewBulk).toHaveBeenLastCalledWith(
      expect.objectContaining({ structure: "hcp", elements: [12], covera: 1.624 }),
    );
    // An unknown example name is ignored.
    fireEvent.change(screen.getByTestId("builder-bulk-example"), { target: { value: "" } });
    expect((screen.getByTestId("builder-bulk-structure") as HTMLSelectElement).value).toBe("hcp");
  });

  it("shows the species the prototype needs and reports a bad element", () => {
    open({ initialKind: "bulk" });
    fireEvent.change(screen.getByTestId("builder-bulk-structure"), {
      target: { value: "perovskite" },
    });
    expect(screen.getByTestId("builder-bulk-element-2")).toBeTruthy();
    type("builder-bulk-element-0", "Sr");
    type("builder-bulk-element-1", "Ti");
    type("builder-bulk-element-2", "Zz");
    click("builder-bulk-create");
    expect(screen.getByTestId("builder-new-error").textContent).toContain('Species X: "Zz"');
    expect(onNewBulk).not.toHaveBeenCalled();
    type("builder-bulk-element-2", "O");
    click("builder-bulk-create");
    expect(onNewBulk).toHaveBeenCalledTimes(1);
  });

  it("reports what the generator refuses", () => {
    onNewBulk.mockImplementation(() => {
      throw new Error("lattice constant must be positive");
    });
    open({ initialKind: "bulk" });
    click("builder-bulk-create");
    expect(screen.getByTestId("builder-new-error").textContent).toContain("positive");
    expect(onClose).not.toHaveBeenCalled();
    // Switching tabs clears the message.
    click("builder-new-kind-cell");
    expect(screen.queryByTestId("builder-new-error")).toBeNull();
  });
});

describe("NewStructureDialog — tabs", () => {
  it("are buttons in a tab list, moved between with the arrow keys, Home and End", () => {
    open();
    const cell = screen.getByTestId("builder-new-kind-cell");
    const bulk = screen.getByTestId("builder-new-kind-bulk");
    expect(cell.tagName).toBe("BUTTON");
    expect(cell.getAttribute("role")).toBe("tab");
    expect(cell.getAttribute("aria-selected")).toBe("true");
    // Only the selected tab is in the Tab order.
    expect(cell.tabIndex).toBe(0);
    expect(bulk.tabIndex).toBe(-1);
    fireEvent.keyDown(cell, { key: "ArrowRight" });
    expect(bulk.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(bulk);
    expect(screen.getByTestId("builder-bulk-create")).toBeTruthy();
    fireEvent.keyDown(bulk, { key: "ArrowRight" });
    expect(cell.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(cell, { key: "ArrowLeft" });
    expect(bulk.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(bulk, { key: "ArrowUp" });
    expect(cell.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(cell, { key: "End" });
    expect(bulk.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(bulk, { key: "Home" });
    expect(cell.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(cell, { key: "ArrowDown" });
    expect(bulk.getAttribute("aria-selected")).toBe("true");
    // Other keys leave the tabs alone.
    fireEvent.keyDown(bulk, { key: "x" });
    expect(bulk.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(cell);
    expect(cell.getAttribute("aria-selected")).toBe("true");
  });
});

describe("NewStructureDialog — replacing the open structure", () => {
  it("goes ahead at once on a synchronous yes and stays open on a no", () => {
    const confirmReplace = vi.fn(() => false);
    open({ hasDocument: true, confirmReplace });
    click("builder-new-cell");
    expect(confirmReplace).toHaveBeenCalledTimes(1);
    expect(onNewCell).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    confirmReplace.mockReturnValue(true);
    click("builder-new-cell");
    expect(onNewCell).toHaveBeenCalledWith(DEFAULT_NEW_CELL_EDGE);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("waits for an asked question, and reports a refused spec after it", async () => {
    let answer: (ok: boolean) => void = () => {};
    const confirmReplace = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    open({ hasDocument: true, initialKind: "bulk", confirmReplace });
    click("builder-bulk-create");
    expect(onNewBulk).not.toHaveBeenCalled();
    answer(false);
    await Promise.resolve();
    expect(onNewBulk).not.toHaveBeenCalled();

    click("builder-bulk-create");
    answer(true);
    await waitFor(() => expect(onNewBulk).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);

    onNewBulk.mockImplementation(() => {
      throw new Error("lattice constant must be positive");
    });
    click("builder-bulk-create");
    answer(true);
    await waitFor(() =>
      expect(screen.getByTestId("builder-new-error").textContent).toContain("positive"),
    );
    onNewBulk.mockImplementation(() => {
      throw "plain refusal";
    });
    click("builder-bulk-create");
    answer(true);
    await waitFor(() =>
      expect(screen.getByTestId("builder-new-error").textContent).toBe("plain refusal"),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
