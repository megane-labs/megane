/**
 * The Structure menu's dialogs (cell, centre with vacuum, supercell, slab) and
 * the preview they show while open; the menu's own items; and the sidebar's
 * cell card with its symmetry offer. Every action is one edit op on the open
 * structure. (Starting a bulk crystal is a new document and lives in the New
 * structure dialog, covered by its own test.)
 */

import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  CrystalDialog,
  MAX_ATOMS,
  PREVIEW_DELAY_MS,
  PREVIEW_MAX_ATOMS,
  cellSummary,
  type CrystalDialogKind,
} from "@/builder/crystal/CrystalDialog";
import { CellCard } from "@/builder/crystal/CellCard";
import { structureMenuItems, type StructureMenuState } from "@/builder/crystal/structureMenu";
import { hasCellBox, symmetryOpsAvailable } from "@/builder/crystal/structure";
import type { MenuAction, MenuItem } from "@/builder/Menu";
import { useBuilderStore } from "@/builder/store";
import { bulkSnapshot } from "@/crystal/bulk";
import type { Snapshot } from "@/types";

const s = () => useBuilderStore.getState();
const edits = () => s().edits;
const shown = () => s().result!.snapshot;
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const type = (id: string, value: string) =>
  fireEvent.change(screen.getByTestId(id), { target: { value } });
const text = (id: string) => screen.getByTestId(id).textContent;
/** Let the dialog's preview timer fire. */
const settle = () => act(() => void vi.advanceTimersByTime(PREVIEW_DELAY_MS + 1));

function cif(): Snapshot {
  return {
    ...bulkSnapshot({ structure: "sc", elements: [11], a: 5 }),
    symmetryOps: ["x,y,z", "x+1/2,y+1/2,z+1/2"],
  };
}

const cu = (a = 4) => s().newBulk({ structure: "fcc", elements: [29], a, cubic: true });

/** A dialog that reopens like the menu reopens it, so a test can apply twice. */
function Dialog({ kind }: { kind: CrystalDialogKind }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <CrystalDialog kind={kind} onClose={() => setOpen(false)} />
  ) : (
    <button data-testid="reopen" onClick={() => setOpen(true)} />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useBuilderStore.setState(useBuilderStore.getInitialState(), true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("cellSummary / structure helpers", () => {
  it("names the angles of a cell that is not orthogonal", () => {
    const box = bulkSnapshot({ structure: "hcp", elements: [12], a: 3.21, covera: 1.624 }).box!;
    expect(cellSummary(box)).toContain("120.00°");
    expect(cellSummary(new Float32Array([2, 0, 0, 0, 3, 0, 0, 0, 4]))).toBe("2.00 × 3.00 × 4.00 Å");
  });

  it("tells a real cell from none and counts the symmetry operations still to apply", () => {
    expect(hasCellBox(null)).toBe(false);
    expect(hasCellBox(new Float32Array(9))).toBe(false);
    expect(hasCellBox(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]))).toBe(true);
    expect(symmetryOpsAvailable(null, [])).toBe(0);
    expect(symmetryOpsAvailable(cif(), [])).toBe(2);
    expect(symmetryOpsAvailable(cif(), [{ op: "wrap" }])).toBe(2);
    expect(symmetryOpsAvailable(cif(), [{ op: "expand_symmetry", id: "x" }])).toBe(0);
    expect(symmetryOpsAvailable(cif(), [{ op: "center", axes: [2], vacuum: null }])).toBe(2);
    expect(symmetryOpsAvailable(cif(), [{ op: "center", axes: [2], vacuum: 5 }])).toBe(0);
  });
});

describe("Structure menu", () => {
  const base: StructureMenuState = {
    hasDocument: true,
    editable: true,
    hasCell: true,
    nAtoms: 4,
    symmetryOps: 0,
  };
  const action = (items: MenuItem[], testId: string) =>
    items.find((i): i is MenuAction => "onSelect" in i && i.testId === testId)!;

  it("opens a dialog for the ops with parameters and applies the others at once", () => {
    const open = vi.fn();
    const apply = vi.fn();
    const items = structureMenuItems({ ...base, symmetryOps: 3 }, open, apply);
    expect(action(items, "builder-structure-cell").label).toBe("Edit cell…");
    for (const [id, kind] of [
      ["builder-structure-cell", "cell"],
      ["builder-structure-center", "center"],
      ["builder-structure-supercell", "supercell"],
      ["builder-structure-slab", "slab"],
    ] as const) {
      action(items, id).onSelect();
      expect(open).toHaveBeenLastCalledWith(kind);
    }
    action(items, "builder-cell-wrap").onSelect();
    expect(apply).toHaveBeenLastCalledWith({ op: "wrap" });
    action(items, "builder-cell-remove").onSelect();
    expect(apply).toHaveBeenLastCalledWith({ op: "set_cell", box: null });
    const sym = action(items, "builder-structure-expand-symmetry");
    expect(sym.label).toBe("Expand symmetry (3 operations)");
    sym.onSelect();
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ op: "expand_symmetry" }));
    expect(items.some((i) => "separator" in i)).toBe(true);
  });

  it("disables what the document cannot take", () => {
    const disabled = (state: Partial<StructureMenuState>) =>
      structureMenuItems({ ...base, ...state }, vi.fn(), vi.fn())
        .filter((i): i is MenuAction => "onSelect" in i && !!i.disabled)
        .map((i) => i.testId);
    expect(disabled({})).toEqual(["builder-structure-expand-symmetry"]);
    expect(disabled({ hasCell: false })).toEqual([
      "builder-cell-wrap",
      "builder-structure-center",
      "builder-cell-remove",
      "builder-structure-supercell",
      "builder-structure-slab",
      "builder-structure-expand-symmetry",
    ]);
    expect(disabled({ nAtoms: 0 })).toContain("builder-cell-wrap");
    expect(disabled({ editable: false })).toHaveLength(7);
    const one = structureMenuItems({ ...base, symmetryOps: 1 }, vi.fn(), vi.fn());
    expect(action(one, "builder-structure-expand-symmetry").label).toBe(
      "Expand symmetry (1 operation)",
    );
    const none = structureMenuItems({ ...base, hasCell: false }, vi.fn(), vi.fn());
    expect(action(none, "builder-structure-cell").label).toBe("Set cell…");
  });
});

describe("CrystalDialog — cell", () => {
  it("previews the new cell, applies it with or without the atoms, and closes", () => {
    cu();
    render(<Dialog kind="cell" />);
    expect((screen.getByTestId("builder-cell-a") as HTMLInputElement).value).toBe("4");
    type("builder-cell-a", "8");
    // Nothing changes until the preview timer fires, and the document never does.
    expect(s().preview).toBeNull();
    settle();
    expect(s().preview!.snapshot.box![0]).toBeCloseTo(8, 5);
    expect(edits()).toHaveLength(0);
    expect(text("builder-crystal-preview-status")).toContain("Apply keeps it");
    click("builder-cell-apply");
    expect(edits()[0]).toMatchObject({ op: "set_cell", scaleAtoms: true });
    expect(s().preview).toBeNull();
    expect(shown().box![0]).toBeCloseTo(8, 5);
    // Atoms moved with the cell: the (½,0,½) atom is now at x = 4.
    expect(shown().positions[6]).toBeCloseTo(4, 4);
    expect(screen.queryByTestId("builder-crystal-dialog")).toBeNull();

    // Reopened, the fields follow the document; without scaling the atoms stay.
    click("reopen");
    expect((screen.getByTestId("builder-cell-a") as HTMLInputElement).value).toBe("8");
    click("builder-cell-scale-atoms");
    type("builder-cell-a", "6");
    click("builder-cell-apply");
    expect(edits()[1]).toMatchObject({ op: "set_cell", scaleAtoms: false });
    expect(shown().positions[6]).toBeCloseTo(4, 4);
  });

  it("an invalid cell disables Apply and shows no preview", () => {
    cu();
    render(<Dialog kind="cell" />);
    type("builder-cell-gamma", "0");
    settle();
    expect(s().preview).toBeNull();
    expect(screen.queryByTestId("builder-crystal-preview-status")).toBeNull();
    expect((screen.getByTestId("builder-cell-apply") as HTMLButtonElement).disabled).toBe(true);
    click("builder-cell-apply");
    expect(edits()).toHaveLength(0);
  });

  it("sets a first cell on a structure without one (the atoms stay)", () => {
    cu();
    s().pushOp({ op: "set_cell", box: null });
    render(<Dialog kind="cell" />);
    expect((screen.getByTestId("builder-cell-a") as HTMLInputElement).value).toBe("10");
    expect((screen.getByTestId("builder-cell-scale-atoms") as HTMLInputElement).disabled).toBe(
      true,
    );
    click("builder-cell-apply");
    expect(edits()[1]).toMatchObject({ op: "set_cell", scaleAtoms: false });
  });

  it("Cancel and Escape drop the preview and leave the document", () => {
    cu();
    render(<Dialog kind="cell" />);
    type("builder-cell-a", "8");
    settle();
    expect(s().preview).not.toBeNull();
    click("builder-crystal-cancel");
    expect(s().preview).toBeNull();
    expect(edits()).toHaveLength(0);
    click("reopen");
    type("builder-cell-a", "9");
    settle();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-crystal-dialog")).toBeNull();
    expect(s().preview).toBeNull();
  });

  it("does nothing while the original structure is shown", () => {
    cu();
    s().pushOp({ op: "wrap" });
    s().setShowOriginal(true);
    render(<Dialog kind="cell" />);
    type("builder-cell-a", "8");
    settle();
    expect(s().preview).toBeNull();
    expect(text("builder-crystal-preview-status")).toContain("paused");
    click("builder-cell-apply");
    expect(edits()).toHaveLength(1);
  });

  it("asks for a document first", () => {
    render(<Dialog kind="cell" />);
    expect(screen.getByTestId("builder-crystal-no-document")).toBeTruthy();
    expect((screen.getByTestId("builder-cell-apply") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CrystalDialog — center with vacuum", () => {
  it("centres along the chosen axes; with none chosen Apply is inert", () => {
    cu();
    render(<Dialog kind="center" />);
    click("builder-cell-axis-a");
    type("builder-cell-vacuum", "5");
    click("builder-cell-center");
    expect(edits()[0]).toEqual({ op: "center", axes: [0, 2], vacuum: 5 });
    click("reopen");
    click("builder-cell-axis-c");
    expect(screen.getByTestId("builder-cell-axis-c").getAttribute("aria-pressed")).toBe("false");
    click("builder-cell-center");
    expect(edits()).toHaveLength(1);
  });

  it("needs a cell", () => {
    s().newCell(10);
    s().pushOp({ op: "set_cell", box: null });
    render(<Dialog kind="center" />);
    expect(text("builder-crystal-no-cell")).toContain("needs a cell");
    expect((screen.getByTestId("builder-cell-center") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CrystalDialog — supercell", () => {
  it("previews the result in the view and pushes a diagonal or matrix supercell", () => {
    cu();
    render(<Dialog kind="supercell" />);
    expect(text("builder-supercell-preview")).toBe("8 images → 32 atoms");
    type("builder-supercell-nc", "1");
    expect(text("builder-supercell-preview")).toBe("4 images → 16 atoms");
    settle();
    expect(s().preview!.snapshot.nAtoms).toBe(16);
    expect(shown().nAtoms).toBe(4);
    click("builder-supercell-apply");
    expect(edits()[0]).toMatchObject({ op: "supercell", matrix: [2, 0, 0, 0, 2, 0, 0, 0, 1] });
    // Apply gives the atoms a fresh fragment id, not the preview's.
    expect((edits()[0] as { id: string }).id).not.toBe("preview");
    expect(shown().nAtoms).toBe(16);
    click("reopen");
    click("builder-supercell-advanced");
    type("builder-supercell-m1", "1");
    type("builder-supercell-m3", "-1");
    expect(text("builder-supercell-preview")).toBe("2 images → 32 atoms");
    click("builder-supercell-apply");
    expect(edits()[1]).toMatchObject({ op: "supercell", matrix: [1, 1, 0, -1, 1, 0, 0, 0, 1] });
    expect(shown().nAtoms).toBe(32);
    // A singular matrix is refused.
    click("reopen");
    click("builder-supercell-advanced");
    type("builder-supercell-m1", "1");
    type("builder-supercell-m4", "0");
    type("builder-supercell-m3", "0");
    type("builder-supercell-m0", "0");
    expect(text("builder-supercell-preview")).toBe("Invalid matrix");
    click("builder-supercell-apply");
    expect(edits()).toHaveLength(2);
  });

  it("puts the preview back on the new structure after an Undo", () => {
    cu();
    s().pushOp({ op: "wrap" });
    render(<Dialog kind="supercell" />);
    settle();
    expect(s().preview!.snapshot.nAtoms).toBe(32);
    act(() => void s().undo());
    expect(s().preview).toBeNull();
    settle();
    expect(s().preview!.snapshot.nAtoms).toBe(32);
  });

  it("builds but does not preview a large result, and refuses one beyond the limit", () => {
    cu();
    render(<Dialog kind="supercell" />);
    type("builder-supercell-na", "500");
    type("builder-supercell-nb", "500");
    type("builder-supercell-nc", "2");
    // 4 atoms × 500 000 images.
    expect(text("builder-supercell-preview")).toBe(
      `2,000,000 atoms would exceed the ${MAX_ATOMS.toLocaleString("en-US")}-atom limit`,
    );
    click("builder-supercell-apply");
    expect(edits()).toHaveLength(0);
    type("builder-supercell-nc", "1");
    expect(text("builder-supercell-preview")).toBe("250000 images → 1000000 atoms");
    expect(1_000_000).toBeGreaterThan(PREVIEW_MAX_ATOMS);
    settle();
    expect(s().preview).toBeNull();
    expect(text("builder-crystal-preview-status")).toContain("Too large to preview");
  });

  it("needs a cell", () => {
    s().newCell(10);
    s().pushOp({ op: "set_cell", box: null });
    render(<Dialog kind="supercell" />);
    expect(text("builder-crystal-no-cell")).toContain("needs a cell");
    expect(screen.queryByTestId("builder-supercell")).toBeNull();
  });
});

describe("CrystalDialog — slab", () => {
  it("previews and cuts a slab, with the termination shift", () => {
    cu(3.61);
    render(<Dialog kind="slab" />);
    expect(text("builder-slab-preview")).toMatch(/^16 atoms, .* Å thick$/);
    type("builder-slab-layers", "2");
    type("builder-slab-vacuum", "5");
    type("builder-slab-h", "1");
    type("builder-slab-k", "0");
    type("builder-slab-l", "0");
    settle();
    expect(s().preview!.snapshot.nAtoms).toBe(8);
    click("builder-slab-apply");
    expect(edits()[0]).toEqual(
      expect.objectContaining({ op: "slab", miller: [1, 0, 0], layers: 2, vacuum: 5 }),
    );
    expect(edits()[0]).not.toHaveProperty("shift");
    expect(shown().nAtoms).toBe(8);
    // Two cubic cells along x hold four (100) planes: 1.5 a thick, plus the vacuum.
    expect(shown().box![8]).toBeCloseTo(3.61 * 1.5 + 10, 3);
    // Zero Miller indices are refused with a message; a shift is recorded when set.
    click("reopen");
    type("builder-slab-h", "0");
    type("builder-slab-k", "0");
    type("builder-slab-l", "0");
    expect(text("builder-slab-preview")).toContain("not all zero");
    click("builder-slab-apply");
    expect(edits()).toHaveLength(1);
    type("builder-slab-l", "1");
    fireEvent.change(screen.getByTestId("builder-slab-shift"), { target: { value: "0.25" } });
    click("builder-slab-apply");
    expect(edits()[1]).toMatchObject({ op: "slab", miller: [0, 0, 1], shift: 0.25 });
  });

  it("announces the thickness and refuses a slab beyond the atom limit", () => {
    cu(3.61);
    render(<Dialog kind="slab" />);
    type("builder-slab-layers", "3");
    type("builder-slab-vacuum", "10");
    // Each (111) repeat of the conventional cell is one 4-atom plane, so three
    // layers are 12 atoms spanning two interplanar spacings of a/√3.
    expect(text("builder-slab-preview")).toBe(
      `12 atoms, ${((2 * 3.61) / Math.sqrt(3)).toFixed(1)} Å thick`,
    );
    click("builder-slab-apply");
    expect(shown().nAtoms).toBe(12);
    // Cutting the slab again stacks the whole structure: the count multiplies.
    click("reopen");
    expect(text("builder-slab-preview")).toMatch(/^48 atoms, /);
    type("builder-slab-layers", "300000");
    expect(text("builder-slab-preview")).toBe(
      `3,600,000 atoms would exceed the ${MAX_ATOMS.toLocaleString("en-US")}-atom limit`,
    );
    click("builder-slab-apply");
    expect(edits()).toHaveLength(1);
    type("builder-slab-layers", "2");
    click("builder-slab-apply");
    expect(shown().nAtoms).toBe(24);
  });

  it("says so when the cell yields no slab", () => {
    cu(3.61);
    render(<Dialog kind="slab" />);
    type("builder-slab-layers", "0");
    expect(text("builder-slab-preview")).toBe("");
    expect((screen.getByTestId("builder-slab-apply") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CellCard", () => {
  it("summarises the cell and opens the cell dialog", () => {
    const onOpen = vi.fn();
    render(<CellCard onOpen={onOpen} />);
    expect(text("builder-crystal-cell-summary")).toBe("No cell");
    expect(screen.queryByTestId("builder-cell-edit")).toBeNull();
    act(() => cu(3.61));
    expect(text("builder-crystal-cell-summary")).toBe("3.61 × 3.61 × 3.61 Å");
    expect(text("builder-cell-edit")).toBe("Edit cell…");
    click("builder-cell-edit");
    expect(onOpen).toHaveBeenCalledWith("cell");
    act(() => s().pushOp({ op: "set_cell", box: null }));
    expect(text("builder-cell-edit")).toBe("Set cell…");
  });

  it("offers to expand a file's symmetry operations once", () => {
    s().openStructure(cif(), null, "nacl.cif");
    render(<CellCard onOpen={vi.fn()} />);
    expect(text("builder-crystal-symmetry")).toContain("2 symmetry operations");
    click("builder-crystal-expand-symmetry");
    expect(edits()[0]).toMatchObject({ op: "expand_symmetry" });
    expect(shown().nAtoms).toBe(2);
    expect(screen.queryByTestId("builder-crystal-symmetry")).toBeNull();
    // Undo brings the offer back; a cell change consumes it as well.
    act(() => void s().undo());
    expect(screen.getByTestId("builder-crystal-symmetry")).toBeTruthy();
    act(() => s().pushOp({ op: "supercell", id: "sc", matrix: [2, 0, 0, 0, 1, 0, 0, 0, 1] }));
    expect(screen.queryByTestId("builder-crystal-symmetry")).toBeNull();
  });

  it("is quiet for files without symmetry operations", () => {
    cu(3.61);
    render(<CellCard onOpen={vi.fn()} />);
    expect(screen.queryByTestId("builder-crystal-symmetry")).toBeNull();
  });
});
