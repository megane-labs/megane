/**
 * Build panel tests. The panel is driven two ways: through its own chips
 * (tool / element / history / export) and through the pick / drag handlers it
 * installs in the build store for the Viewport. Both paths must end in ops on
 * the primary loader's edit list — the panel never touches atom arrays itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

const { exportSnapshot } = vi.hoisted(() => ({ exportSnapshot: vi.fn(async () => "x.xyz") }));
vi.mock("@/export/structureExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/export/structureExport")>();
  return { ...actual, exportSnapshot };
});

import { usePipelineStore } from "@/pipeline/store";
import { usePipelineUIStore } from "@/stores/usePipelineUIStore";
import { useBuildStore } from "@/stores/useBuildStore";
import { BuildPanel, placeBondedAtom, describeOp, newAtomId } from "@/components/BuildPanel";
import type { EditOp, LoadStructureParams } from "@/pipeline/types";
import type { Snapshot } from "@/types";

function water(box: Float32Array | null = null): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function loadPipeline(withReplicate = false) {
  const nodes: Record<string, unknown>[] = [
    {
      type: "load_structure",
      id: "loader-1",
      position: { x: 0, y: 0 },
      fileName: "water.xyz",
      hasTrajectory: false,
      hasCell: withReplicate,
      enabled: true,
    },
    {
      type: "viewport",
      id: "viewport-1",
      position: { x: 0, y: 400 },
      perspective: false,
      cellAxesVisible: true,
      enabled: true,
    },
  ];
  const edges: Record<string, string>[] = [];
  if (withReplicate) {
    nodes.push({
      type: "replicate",
      id: "rep-1",
      position: { x: 0, y: 200 },
      nx: 2,
      ny: 1,
      nz: 1,
      enabled: true,
    });
    edges.push(
      { source: "loader-1", target: "rep-1", sourceHandle: "particle", targetHandle: "particle" },
      { source: "loader-1", target: "rep-1", sourceHandle: "cell", targetHandle: "cell" },
      { source: "rep-1", target: "viewport-1", sourceHandle: "particle", targetHandle: "particle" },
    );
  } else {
    edges.push({
      source: "loader-1",
      target: "viewport-1",
      sourceHandle: "particle",
      targetHandle: "particle",
    });
  }
  usePipelineStore.getState().deserialize({ version: 3, nodes, edges } as never);
  usePipelineStore.getState().setNodeSnapshot("loader-1", {
    snapshot: water(withReplicate ? new Float32Array([10, 0, 0, 0, 10, 0, 0, 0, 10]) : null),
    frames: null,
    meta: null,
    labels: null,
  });
}

function ops(): EditOp[] {
  const n = usePipelineStore.getState().nodes.find((x) => x.id === "loader-1");
  return (n?.data.params as LoadStructureParams | undefined)?.edits ?? [];
}

function handlers() {
  const h = useBuildStore.getState().handlers;
  if (!h) throw new Error("Build handlers not installed");
  return h;
}

function pick(
  atomIndex: number | null,
  extra: Partial<{ shiftKey: boolean; world: [number, number, number] }> = {},
) {
  act(() => {
    handlers().pick({
      atomIndex,
      world: extra.world ?? (atomIndex === null ? [5, 5, 5] : null),
      shiftKey: extra.shiftKey ?? false,
    });
  });
}

function setTool(tool: string) {
  fireEvent.click(screen.getByTestId(`build-tool-${tool}`));
}

describe("BuildPanel", () => {
  beforeEach(() => {
    usePipelineUIStore.setState({ mode: "editor", buildOpen: true });
    usePipelineStore.setState({ editsBypassed: false });
    useBuildStore.setState({
      tool: "select",
      element: 6,
      bondOrder: 1,
      selected: [],
      pendingBondAtom: null,
      redoStack: [],
      handlers: null,
    });
    exportSnapshot.mockClear();
    loadPipeline();
  });

  afterEach(() => {
    cleanup();
  });

  it("prompts to load a structure when nothing is loaded", () => {
    usePipelineStore.getState().deserialize({
      version: 3,
      nodes: [
        {
          type: "viewport",
          id: "viewport-1",
          position: { x: 0, y: 0 },
          perspective: false,
          cellAxesVisible: true,
          enabled: true,
        },
      ],
      edges: [],
    });
    render(<BuildPanel />);
    expect(screen.getByText(/Load a structure/)).toBeTruthy();
    // Handlers are installed but inert without a structure.
    pick(0);
    expect(ops()).toHaveLength(0);
  });

  it("installs the Viewport handlers while mounted and removes them on unmount", () => {
    render(<BuildPanel />);
    expect(useBuildStore.getState().handlers).not.toBeNull();
    cleanup();
    expect(useBuildStore.getState().handlers).toBeNull();
  });

  it("switches tools and reflects the hint", () => {
    render(<BuildPanel />);
    expect(screen.getByTestId("build-tool-select").getAttribute("aria-pressed")).toBe("true");
    setTool("add");
    expect(useBuildStore.getState().tool).toBe("add");
    expect(screen.getByTestId("build-tool-hint").textContent).toContain("bond length");
  });

  it("selects atoms with the Select tool (Shift extends, empty space clears)", () => {
    render(<BuildPanel />);
    pick(1);
    expect(useBuildStore.getState().selected).toEqual([1]);
    pick(2, { shiftKey: true });
    expect(useBuildStore.getState().selected).toEqual([1, 2]);
    expect(screen.getByTestId("build-selected-count").textContent).toBe("2 atoms selected.");
    pick(null, { shiftKey: true });
    expect(useBuildStore.getState().selected).toEqual([1, 2]);
    pick(null);
    expect(useBuildStore.getState().selected).toEqual([]);
    expect(ops()).toHaveLength(0);
  });

  it("Add tool: clicking an atom attaches a bonded atom, empty space places a free one", () => {
    render(<BuildPanel />);
    setTool("add");
    fireEvent.click(screen.getByTestId("build-element-N"));
    fireEvent.change(screen.getByTestId("build-bond-order"), { target: { value: "2" } });
    pick(0);
    let list = ops();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ op: "add_atom", element: 7, bondTo: 0, order: 2 });
    // The rendered structure grew by one atom.
    expect(usePipelineStore.getState().viewportState.particles[0].source.nAtoms).toBe(4);
    pick(null, { world: [3, 4, 5] });
    list = ops();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ op: "add_atom", element: 7, position: [3, 4, 5] });
    expect((list[1] as { bondTo?: unknown }).bondTo).toBeUndefined();
    expect(screen.getByTestId("build-op-count").textContent).toBe("2 edits");
    expect(screen.getByTestId("build-op-list").textContent).toContain("Add N bonded to #0");
  });

  it("Add tool: a click on a freshly added atom bonds to it by id, not by index", () => {
    render(<BuildPanel />);
    setTool("add");
    pick(0); // new atom becomes rendered index 3
    pick(3);
    const list = ops();
    expect(list).toHaveLength(2);
    const firstId = (list[0] as { id: string }).id;
    expect((list[1] as { bondTo: unknown }).bondTo).toBe(firstId);
  });

  it("Bond tool: two clicks create a bond; the first click is shown as pending", () => {
    render(<BuildPanel />);
    setTool("bond");
    pick(1);
    expect(useBuildStore.getState().pendingBondAtom).toBe(1);
    expect(screen.getByTestId("build-tool-hint").textContent).toContain("First atom: #1");
    pick(1); // same atom again keeps it pending
    expect(useBuildStore.getState().pendingBondAtom).toBe(1);
    pick(2);
    expect(useBuildStore.getState().pendingBondAtom).toBeNull();
    expect(ops()).toEqual([{ op: "add_bond", a: 1, b: 2, order: 1 }]);
    pick(null); // empty space with the bond tool does nothing
    expect(ops()).toHaveLength(1);
  });

  it("Delete and Element tools write one op per click", () => {
    render(<BuildPanel />);
    setTool("delete");
    pick(1);
    expect(ops()).toEqual([{ op: "delete_atoms", atoms: [1] }]);
    expect(usePipelineStore.getState().viewportState.particles[0].source.nAtoms).toBe(2);
    setTool("element");
    fireEvent.change(screen.getByTestId("build-element-z"), { target: { value: "9" } });
    // Rendered index 1 is now the original atom 2.
    pick(1);
    expect(ops()[1]).toEqual({ op: "set_element", atoms: [2], element: 9 });
    // Out-of-range Z is ignored.
    fireEvent.change(screen.getByTestId("build-element-z"), { target: { value: "500" } });
    expect(useBuildStore.getState().element).toBe(9);
    pick(null);
    expect(ops()).toHaveLength(2);
  });

  it("Move tool: drags become a single move op, a zero-length drag leaves nothing", () => {
    render(<BuildPanel />);
    expect(handlers().dragStart(1)).toBe(false); // select tool: no drag
    setTool("move");
    pick(1); // a bare click selects
    expect(useBuildStore.getState().selected).toEqual([1]);
    let started = false;
    act(() => {
      started = handlers().dragStart(1);
    });
    expect(started).toBe(true);
    expect(ops()).toEqual([{ op: "move_atoms", atoms: [1], delta: [0, 0, 0] }]);
    act(() => handlers().dragMove([1, 0, 0]));
    act(() => handlers().dragMove([2, 0, 0]));
    expect(ops()).toEqual([{ op: "move_atoms", atoms: [1], delta: [2, 0, 0] }]);
    act(() => handlers().dragEnd());
    expect(ops()).toHaveLength(1);
    expect(usePipelineStore.getState().viewportState.particles[0].source.positions[3]).toBeCloseTo(
      2.757,
    );
    // Dragging an unselected atom moves just that atom; no movement → dropped.
    act(() => {
      handlers().dragStart(0);
    });
    expect(ops()).toHaveLength(2);
    act(() => handlers().dragEnd());
    expect(ops()).toHaveLength(1);
    act(() => handlers().dragEnd()); // idempotent
  });

  it("Move tool drags the whole selection when the grabbed atom is selected", () => {
    render(<BuildPanel />);
    setTool("select");
    pick(1);
    pick(2, { shiftKey: true });
    setTool("move");
    act(() => {
      handlers().dragStart(2);
    });
    act(() => handlers().dragMove([0, 1, 0]));
    act(() => handlers().dragEnd());
    expect(ops()).toEqual([{ op: "move_atoms", atoms: [1, 2], delta: [0, 1, 0] }]);
  });

  it("Undo / Redo / Clear all manage the history", () => {
    render(<BuildPanel />);
    setTool("delete");
    pick(1);
    pick(0);
    expect(ops()).toHaveLength(2);
    fireEvent.click(screen.getByTestId("build-undo"));
    expect(ops()).toHaveLength(1);
    expect(useBuildStore.getState().redoStack).toHaveLength(1);
    fireEvent.click(screen.getByTestId("build-redo"));
    expect(ops()).toHaveLength(2);
    expect(useBuildStore.getState().redoStack).toHaveLength(0);
    fireEvent.click(screen.getByTestId("build-undo"));
    // A new op after undo discards the redo stack.
    pick(0);
    expect(useBuildStore.getState().redoStack).toHaveLength(0);
    fireEvent.click(screen.getByTestId("build-clear-ops"));
    expect(ops()).toHaveLength(0);
    expect(usePipelineStore.getState().viewportState.particles[0].source.nAtoms).toBe(3);
    // Disabled chips are inert.
    fireEvent.click(screen.getByTestId("build-undo"));
    fireEvent.click(screen.getByTestId("build-redo"));
    expect(ops()).toHaveLength(0);
  });

  it("acts on the selection: delete selected / set element / clear", () => {
    render(<BuildPanel />);
    fireEvent.click(screen.getByTestId("build-delete-selected")); // nothing selected: no-op
    expect(ops()).toHaveLength(0);
    pick(1);
    pick(2, { shiftKey: true });
    fireEvent.click(screen.getByTestId("build-element-O"));
    fireEvent.click(screen.getByTestId("build-element-selected"));
    expect(ops()).toEqual([{ op: "set_element", atoms: [1, 2], element: 8 }]);
    fireEvent.click(screen.getByTestId("build-delete-selected"));
    expect(ops()[1]).toEqual({ op: "delete_atoms", atoms: [1, 2] });
    expect(useBuildStore.getState().selected).toEqual([]);
    pick(0);
    fireEvent.click(screen.getByTestId("build-clear-selection"));
    expect(useBuildStore.getState().selected).toEqual([]);
  });

  it("exports through the shared writer with the loader's file name", async () => {
    render(<BuildPanel />);
    fireEvent.click(screen.getByTestId("build-export-pdb"));
    await act(async () => {});
    expect(exportSnapshot).toHaveBeenCalledTimes(1);
    const [snap, format, fileName] = exportSnapshot.mock.calls[0] as unknown as [
      Snapshot,
      string,
      string,
    ];
    expect(snap.nAtoms).toBe(3);
    expect(format).toBe("pdb");
    expect(fileName).toBe("water.xyz");
  });

  it("Show in Editor switches the panel tab", () => {
    render(<BuildPanel />);
    fireEvent.click(screen.getByTestId("build-open-editor"));
    expect(usePipelineUIStore.getState().mode).toBe("editor");
  });

  it("pauses editing when a downstream node changes the atom count", () => {
    loadPipeline(true);
    render(<BuildPanel />);
    expect(screen.getByTestId("build-provenance-warning")).toBeTruthy();
    setTool("delete");
    pick(1);
    expect(ops()).toHaveLength(0);
    expect(handlers().dragStart(1)).toBe(false);
  });

  it("surfaces the loader's edit warnings", () => {
    render(<BuildPanel />);
    act(() => {
      usePipelineStore.getState().pushEditOp({ op: "delete_atoms", atoms: [99] });
    });
    expect(screen.getByTestId("build-warnings").textContent).toContain("unknown atom 99");
  });

  it("Show original previews the file as loaded and pauses editing until turned off", () => {
    render(<BuildPanel />);
    const toggle = () => screen.getByTestId("build-show-original");
    // Inert while there is nothing to hide.
    fireEvent.click(toggle());
    expect(usePipelineStore.getState().editsBypassed).toBe(false);

    setTool("delete");
    pick(1);
    expect(usePipelineStore.getState().viewportState.particles[0].source.nAtoms).toBe(2);
    fireEvent.click(toggle());
    expect(usePipelineStore.getState().editsBypassed).toBe(true);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(usePipelineStore.getState().viewportState.particles[0].source.nAtoms).toBe(3);
    expect(screen.getByTestId("build-provenance-warning").textContent).toContain("Show original");
    // The history is untouched and clicks do not write ops while previewing.
    expect(ops()).toHaveLength(1);
    pick(0);
    expect(ops()).toHaveLength(1);
    expect(handlers().dragStart(0)).toBe(false);

    fireEvent.click(toggle());
    expect(usePipelineStore.getState().editsBypassed).toBe(false);
    expect(screen.queryByTestId("build-provenance-warning")).toBeNull();
    expect(usePipelineStore.getState().viewportState.particles[0].source.nAtoms).toBe(2);
  });
});

describe("placeBondedAtom", () => {
  it("points away from the anchor's neighbours at covalent bond length", () => {
    const s = water();
    const p = placeBondedAtom(s, 0, 1); // O with two H above it → new H goes to -y
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeLessThan(0);
    const len = Math.hypot(p[0], p[1], p[2]);
    expect(len).toBeCloseTo(0.66 + 0.31, 5);
  });

  it("falls back to +x with no neighbours and +y with balanced ones", () => {
    const lone: Snapshot = { ...water(), nBonds: 0, bonds: new Uint32Array(0) };
    const p = placeBondedAtom(lone, 0, 6);
    expect(p[0]).toBeCloseTo(0.66 + 0.76, 5);
    expect(p[1]).toBe(0);
    const balanced: Snapshot = {
      ...water(),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, -1, 0, 0]),
    };
    const q = placeBondedAtom(balanced, 0, 6);
    expect(q[0]).toBeCloseTo(0, 5);
    expect(q[1]).toBeGreaterThan(0);
  });
});

describe("describeOp / newAtomId", () => {
  it("describes every op kind", () => {
    expect(describeOp({ op: "add_atom", id: "a", element: 6, position: [0, 0, 0] })).toBe("Add C");
    expect(
      describeOp({ op: "add_atom", id: "a", element: 6, position: [0, 0, 0], bondTo: "b" }),
    ).toBe("Add C bonded to b");
    expect(describeOp({ op: "delete_atoms", atoms: [1, 2] })).toBe("Delete 2 atoms");
    expect(describeOp({ op: "move_atoms", atoms: [1], delta: [1, 0, 0] })).toBe(
      "Move 1 atom by (1.00, 0.00, 0.00) Å",
    );
    expect(describeOp({ op: "set_element", atoms: [1], element: 8 })).toBe("Set 1 atom to O");
    expect(describeOp({ op: "add_bond", a: 0, b: 1, order: 2 })).toBe("Bond #0 – #1 (order 2)");
    expect(describeOp({ op: "add_bond", a: 0, b: 1 })).toBe("Bond #0 – #1");
    expect(describeOp({ op: "delete_bond", a: 0, b: 1 })).toBe("Remove bond #0 – #1");
    expect(
      describeOp({ op: "add_fragment", id: "f", elements: [6], positions: [0, 0, 0], bonds: [] }),
    ).toBe('Add fragment "f" (1 atoms)');
    expect(describeOp({ op: "set_cell", box: null })).toBe("Remove cell");
    expect(describeOp({ op: "set_cell", box: [1, 0, 0, 0, 1, 0, 0, 0, 1] })).toBe("Set cell");
    expect(describeOp({ op: "bogus" } as unknown as EditOp)).toBe("bogus");
  });

  it("hands out unique ids", () => {
    expect(newAtomId()).not.toBe(newAtomId());
  });
});
