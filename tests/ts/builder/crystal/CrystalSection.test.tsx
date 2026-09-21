/**
 * The sidebar's Crystal section: bulk crystals, cell editing, wrap / centre,
 * supercells, slabs and symmetry expansion, all as store actions or edit ops.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CrystalSection, MAX_ATOMS } from "@/builder/crystal/CrystalSection";
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
  });
});
afterEach(cleanup);

describe("CrystalSection — bulk", () => {
  it("creates a bulk crystal from the fields and from an example", () => {
    render(<CrystalSection />);
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toBe("No cell");
    click("builder-bulk-create");
    expect(s().fileName).toBe("Cu-fcc");
    expect(shown().nAtoms).toBe(4);
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toBe(
      "3.61 × 3.61 × 3.61 Å",
    );
    // Primitive cell, other element and constant.
    click("builder-bulk-cubic");
    type("builder-bulk-element-0", "au");
    type("builder-bulk-a", "4.08");
    click("builder-bulk-create");
    expect(s().fileName).toBe("Au-fcc");
    expect(shown().nAtoms).toBe(1);
    expect(shown().box![1]).toBeCloseTo(2.04, 5);
    // An example fills every field, including c/a for hcp.
    fireEvent.change(screen.getByTestId("builder-bulk-example"), { target: { value: "Mg (hcp)" } });
    expect((screen.getByTestId("builder-bulk-structure") as HTMLSelectElement).value).toBe("hcp");
    expect((screen.getByTestId("builder-bulk-covera") as HTMLInputElement).value).toBe("1.624");
    expect(screen.queryByTestId("builder-bulk-cubic")).toBeNull();
    click("builder-bulk-create");
    expect(s().fileName).toBe("Mg-hcp");
    expect(shown().nAtoms).toBe(2);
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toContain("120.00°");
    // An unknown example name is ignored.
    fireEvent.change(screen.getByTestId("builder-bulk-example"), { target: { value: "" } });
    expect(s().fileName).toBe("Mg-hcp");
  });

  it("shows the species the prototype needs and reports a bad element", () => {
    render(<CrystalSection />);
    fireEvent.change(screen.getByTestId("builder-bulk-structure"), {
      target: { value: "perovskite" },
    });
    expect(screen.getByTestId("builder-bulk-element-2")).toBeTruthy();
    type("builder-bulk-element-0", "Sr");
    type("builder-bulk-element-1", "Ti");
    type("builder-bulk-element-2", "Zz");
    click("builder-bulk-create");
    expect(screen.getByTestId("builder-crystal-error").textContent).toContain('Species X: "Zz"');
    expect(s().source).toBeNull();
    type("builder-bulk-element-2", "O");
    click("builder-bulk-create");
    expect(screen.queryByTestId("builder-crystal-error")).toBeNull();
    expect(shown().nAtoms).toBe(5);
    // A bad lattice constant is reported from the generator.
    type("builder-bulk-a", "0");
    click("builder-bulk-create");
    expect(screen.getByTestId("builder-crystal-error").textContent).toContain("positive");
  });
});

describe("CrystalSection — cell", () => {
  it("edits the cell parameters, scales atoms, wraps, centres and removes the cell", () => {
    s().newBulk({ structure: "fcc", elements: [29], a: 4, cubic: true });
    render(<CrystalSection />);
    click("builder-crystal-tab-cell");
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
    // With no cell the wrap / remove chips are inert and the fields show a default cell.
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
    click("builder-crystal-tab-cell");
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
    click("builder-supercell-apply");
    expect(edits()).toHaveLength(1);
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
    fireEvent.change(screen.getByTestId("builder-slab-shift"), { target: { value: "0.25" } });
    click("builder-slab-apply");
    expect(edits()[1]).toMatchObject({ op: "slab", miller: [0, 0, 1], shift: 0.25 });
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
