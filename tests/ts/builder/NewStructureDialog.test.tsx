/**
 * "New structure": the one place a document starts from scratch — an empty
 * cell or a bulk crystal (the form that used to be the Crystal section's
 * Bulk tab).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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

  it("closes on Escape, on the backdrop and on Close", () => {
    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    click("builder-new-close");
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("builder-new-dialog"));
    expect(onClose).toHaveBeenCalledTimes(3);
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
