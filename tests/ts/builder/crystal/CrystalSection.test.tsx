/**
 * The sidebar's Crystal section: cell editing, wrap / centre, supercells,
 * slabs and symmetry expansion, all as edit ops on the open structure.
 * (Starting a bulk crystal is a new document and lives in the New structure
 * dialog, covered by its own test.)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "../util";
import { CrystalSection, MAX_ATOMS, cellSummary } from "@/builder/crystal/CrystalSection";
import { useBuilderStore } from "@/builder/store";
import { bulkSnapshot } from "@/crystal/bulk";
import type { Snapshot } from "@/types";

const s = () => useBuilderStore.getState();
const edits = () => s().edits;
const shown = () => s().result!.snapshot;
const click = (id: string) => fireEvent.click(screen.getByTestId(id));
const type = (id: string, value: string) =>
  fireEvent.change(screen.getByTestId(id), { target: { value } });

function cif(): Snapshot {
  return {
    ...bulkSnapshot({ structure: "sc", elements: [11], a: 5 }),
    symmetryOps: ["x,y,z", "x+1/2,y+1/2,z+1/2"],
  };
}

beforeEach(() => {
  localStorage.clear();
  useBuilderStore.setState({
    source: null,
    sourceLabels: null,
    fileName: null,
    edits: [],
    redoStack: [],
    showOriginal: false,
    result: null,
    revision: 0,
    tool: "select",
    selected: [],
    pendingBondAtom: null,
    placeSource: null,
    adsorbHeight: null,
    notice: null,
  });
});
afterEach(cleanup);

describe("CrystalSection — shell", () => {
  it("summarises the cell and asks for a document first", () => {
    render(<CrystalSection />);
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toBe("No cell");
    expect(screen.getByTestId("builder-crystal-no-document")).toBeTruthy();
    act(() => s().newBulk({ structure: "fcc", elements: [29], a: 3.61, cubic: true }));
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toBe(
      "3.61 × 3.61 × 3.61 Å",
    );
    expect(screen.queryByTestId("builder-crystal-no-document")).toBeNull();
  });

  it("names the angles of a cell that is not orthogonal", () => {
    const box = bulkSnapshot({ structure: "hcp", elements: [12], a: 3.21, covera: 1.624 }).box!;
    expect(cellSummary(box)).toContain("120.00°");
  });
});

describe("CrystalSection — cell", () => {
  it("edits the cell parameters, scales atoms, wraps, centres and removes the cell", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 4, cubic: true });
    render(<CrystalSection />);
    expect((screen.getByTestId("builder-cell-a") as HTMLInputElement).value).toBe("4");
    type("builder-cell-a", "8");
    click("builder-cell-apply");
    expect(edits()[0]).toMatchObject({ op: "set_cell", scaleAtoms: true });
    expect(shown().box![0]).toBeCloseTo(8, 5);
    // Atoms moved with the cell: the (½,0,½) atom is now at x = 4.
    expect(shown().positions[6]).toBeCloseTo(4, 4);
    // Fields follow the document.
    expect((screen.getByTestId("builder-cell-a") as HTMLInputElement).value).toBe("8");
    // Without scaling the atoms stay.
    click("builder-cell-scale-atoms");
    type("builder-cell-a", "6");
    click("builder-cell-apply");
    expect(edits()[1]).toMatchObject({ op: "set_cell", scaleAtoms: false });
    expect(shown().positions[6]).toBeCloseTo(4, 4);
    // An invalid angle disables Set cell.
    type("builder-cell-gamma", "0");
    click("builder-cell-apply");
    expect(edits()).toHaveLength(2);
    type("builder-cell-gamma", "90");
    // Wrap and centre.
    click("builder-cell-wrap");
    expect(edits()[2]).toEqual({ op: "wrap" });
    click("builder-cell-axis-a");
    type("builder-cell-vacuum", "5");
    click("builder-cell-center");
    expect(edits()[3]).toEqual({ op: "center", axes: [0, 2], vacuum: 5 });
    // No axis chosen: the button is inert.
    click("builder-cell-axis-a");
    click("builder-cell-axis-c");
    click("builder-cell-center");
    expect(edits()).toHaveLength(4);
    click("builder-cell-remove");
    expect(edits()[4]).toEqual({ op: "set_cell", box: null });
    expect(screen.getByTestId("builder-crystal-no-cell").textContent).toContain("no cell yet");
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toBe("No cell");
    // With no cell the wrap / remove buttons are inert and the fields show a default cell.
    click("builder-cell-wrap");
    click("builder-cell-remove");
    expect(edits()).toHaveLength(5);
    expect((screen.getByTestId("builder-cell-a") as HTMLInputElement).value).toBe("10");
  });

  it("does nothing while editing is paused", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 4, cubic: true });
    s().pushOp({ op: "wrap" });
    s().setShowOriginal(true);
    render(<CrystalSection />);
    click("builder-cell-apply");
    click("builder-cell-wrap");
    expect(edits()).toHaveLength(1);
  });
});

describe("CrystalSection — supercell", () => {
  it("previews the atom count and pushes a diagonal or matrix supercell", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 4, cubic: true });
    render(<CrystalSection />);
    click("builder-crystal-tab-supercell");
    expect(screen.getByTestId("builder-supercell-preview").textContent).toBe("8 images → 32 atoms");
    type("builder-supercell-nc", "1");
    expect(screen.getByTestId("builder-supercell-preview").textContent).toBe("4 images → 16 atoms");
    click("builder-supercell-apply");
    expect(edits()[0]).toMatchObject({ op: "supercell", matrix: [2, 0, 0, 0, 2, 0, 0, 0, 1] });
    expect(shown().nAtoms).toBe(16);
    click("builder-supercell-advanced");
    type("builder-supercell-m1", "1");
    type("builder-supercell-m3", "-1");
    expect(screen.getByTestId("builder-supercell-preview").textContent).toBe("2 images → 32 atoms");
    click("builder-supercell-apply");
    expect(edits()[1]).toMatchObject({ op: "supercell", matrix: [1, 1, 0, -1, 1, 0, 0, 0, 1] });
    expect(shown().nAtoms).toBe(32);
    // A singular matrix is refused.
    type("builder-supercell-m4", "1");
    type("builder-supercell-m3", "1");
    expect(screen.getByTestId("builder-supercell-preview").textContent).toBe("Invalid matrix");
    click("builder-supercell-apply");
    expect(edits()).toHaveLength(2);
  });

  it("needs a cell", () => {
    s().newCell(10);
    s().pushOp({ op: "set_cell", box: null });
    render(<CrystalSection />);
    click("builder-crystal-tab-supercell");
    expect(screen.getByTestId("builder-crystal-no-cell").textContent).toContain("needs a cell");
    expect(screen.queryByTestId("builder-supercell-apply")).toBeNull();
  });

  it("refuses a supercell beyond the atom limit", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 4, cubic: true });
    render(<CrystalSection />);
    click("builder-crystal-tab-supercell");
    type("builder-supercell-na", "500");
    type("builder-supercell-nb", "500");
    type("builder-supercell-nc", "2");
    // 4 atoms × 500 000 images.
    expect(screen.getByTestId("builder-supercell-preview").textContent).toBe(
      `2,000,000 atoms would exceed the ${MAX_ATOMS.toLocaleString("en-US")}-atom limit`,
    );
    click("builder-supercell-apply");
    expect(edits()).toHaveLength(0);
    type("builder-supercell-nc", "1");
    expect(screen.getByTestId("builder-supercell-preview").textContent).toBe(
      "250000 images → 1000000 atoms",
    );
  });
});

describe("CrystalSection — slab", () => {
  it("previews and cuts a slab, with the termination shift", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 3.61, cubic: true });
    render(<CrystalSection />);
    click("builder-crystal-tab-slab");
    expect(screen.getByTestId("builder-slab-preview").textContent).toMatch(
      /^16 atoms, .* Å thick$/,
    );
    type("builder-slab-layers", "2");
    type("builder-slab-vacuum", "5");
    type("builder-slab-h", "1");
    type("builder-slab-k", "0");
    type("builder-slab-l", "0");
    click("builder-slab-apply");
    expect(edits()[0]).toEqual(
      expect.objectContaining({ op: "slab", miller: [1, 0, 0], layers: 2, vacuum: 5 }),
    );
    expect(edits()[0]).not.toHaveProperty("shift");
    expect(shown().nAtoms).toBe(8);
    // Two cubic cells along x hold four (100) planes: 1.5 a thick, plus the vacuum.
    expect(shown().box![8]).toBeCloseTo(3.61 * 1.5 + 10, 3);
    // Zero Miller indices are refused with a message; a shift is recorded when set.
    type("builder-slab-h", "0");
    expect(screen.getByTestId("builder-slab-preview").textContent).toContain("not all zero");
    click("builder-slab-apply");
    expect(edits()).toHaveLength(1);
    type("builder-slab-l", "1");
    // The termination slider is a Mantine Slider: its thumb takes the keyboard.
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(screen.getByTestId("builder-slab-shift-value").textContent).toBe("0.01");
    click("builder-slab-apply");
    expect(edits()[1]).toMatchObject({ op: "slab", miller: [0, 0, 1], shift: 0.01 });
  });

  it("previews the thickness the cut would have and refuses a slab beyond the atom limit", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 3.61, cubic: true });
    render(<CrystalSection />);
    click("builder-crystal-tab-slab");
    type("builder-slab-layers", "3");
    type("builder-slab-vacuum", "10");
    // Each (111) repeat of the conventional cell is one 4-atom plane, so three
    // layers are 12 atoms spanning two interplanar spacings of a/√3.
    expect(screen.getByTestId("builder-slab-preview").textContent).toBe(
      `12 atoms, ${((2 * 3.61) / Math.sqrt(3)).toFixed(1)} Å thick`,
    );
    // Cutting the slab again stacks the whole structure: the count multiplies.
    click("builder-slab-apply");
    expect(shown().nAtoms).toBe(12);
    expect(screen.getByTestId("builder-slab-preview").textContent).toMatch(/^36 atoms, /);
    type("builder-slab-layers", "300000");
    expect(screen.getByTestId("builder-slab-preview").textContent).toBe(
      `3,600,000 atoms would exceed the ${MAX_ATOMS.toLocaleString("en-US")}-atom limit`,
    );
    click("builder-slab-apply");
    expect(edits()).toHaveLength(1);
    type("builder-slab-layers", "2");
    click("builder-slab-apply");
    expect(shown().nAtoms).toBe(24);
  });
});

describe("CrystalSection — symmetry", () => {
  it("offers to expand a file's symmetry operations once", () => {
    s().openStructure(cif(), null, "nacl.cif");
    render(<CrystalSection />);
    expect(screen.getByTestId("builder-crystal-symmetry").textContent).toContain(
      "2 symmetry operations",
    );
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

  it("is hidden for files without symmetry operations", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 3.61 });
    render(<CrystalSection />);
    expect(screen.queryByTestId("builder-crystal-symmetry")).toBeNull();
  });
});
