/**
 * megane Builder app shell: the top bar, the sidebar, the welcome card, and
 * the click / drag handlers it installs for the (mocked) 3D view.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

const { rendererStub, viewportProps, applyViewportState, exportSnapshot, parseStructureFile } =
  vi.hoisted(() => ({
    rendererStub: {
      setViewInsets: vi.fn(),
      resetCamera: vi.fn(),
      alignCameraToAxis: vi.fn(),
    },
    viewportProps: { current: null as Record<string, unknown> | null },
    applyViewportState: vi.fn(),
    exportSnapshot: vi.fn(async () => "x.xyz"),
    parseStructureFile: vi.fn(),
  }));

vi.mock("@/components/Viewport", async () => {
  const React = await import("react");
  return {
    Viewport: (props: Record<string, unknown>) => {
      viewportProps.current = props;
      React.useEffect(() => {
        (props.onRendererReady as ((r: unknown) => void) | undefined)?.(rendererStub);
      }, []);
      return React.createElement("div", { "data-testid": "viewport-stub" });
    },
  };
});
vi.mock("@/components/Tooltip", () => ({ Tooltip: () => null }));
vi.mock("@/pipeline/apply", () => ({ applyViewportState }));
vi.mock("@/export/structureExport", async () => {
  const actual = await vi.importActual<typeof import("@/export/structureExport")>(
    "@/export/structureExport",
  );
  return { ...actual, exportSnapshot };
});
vi.mock("@/parsers/structure", () => ({ parseStructureFile }));

import { BuilderApp } from "@/builder/BuilderApp";
import { useBuilderStore } from "@/builder/store";
import type { BuildHandlers } from "@/builder/types";
import type { Snapshot } from "@/types";

function water(): Snapshot {
  return {
    nAtoms: 3,
    nBonds: 2,
    nFileBonds: 2,
    positions: new Float32Array([0, 0, 0, 0.757, 0.586, 0, -0.757, 0.586, 0]),
    elements: new Uint8Array([8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

function handlers(): BuildHandlers {
  const h = useBuilderStore.getState().handlers;
  if (!h) throw new Error("Builder handlers not installed");
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

const tool = (t: string) => fireEvent.click(screen.getByTestId(`builder-tool-${t}`));
const edits = () => useBuilderStore.getState().edits;
const shownAtoms = () =>
  Number(screen.getByTestId("megane-builder").getAttribute("data-atom-count"));

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
    element: 6,
    bondOrder: 1,
    selected: [],
    pendingBondAtom: null,
    handlers: null,
    placeSource: null,
    adsorbHeight: null,
  });
  applyViewportState.mockClear();
  exportSnapshot.mockClear();
  parseStructureFile.mockReset();
  rendererStub.setViewInsets.mockClear();
  rendererStub.resetCamera.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("BuilderApp — empty state", () => {
  it("shows the welcome card and reserves the sidebar in the frustum", () => {
    render(<BuilderApp />);
    expect(screen.getByTestId("builder-welcome")).toBeTruthy();
    expect(screen.getByTestId("builder-file-name").textContent).toBe("No structure");
    expect(shownAtoms()).toBe(0);
    expect(rendererStub.setViewInsets).toHaveBeenCalledWith(0, 332);
    // The view is always in edit mode with the handlers installed.
    expect(viewportProps.current?.buildActive).toBe(true);
    expect(viewportProps.current?.buildHandlers).toBe(useBuilderStore.getState().handlers);
    // Nothing to save yet.
    expect((screen.getByTestId("builder-save-xyz") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clicks on the empty view do nothing", () => {
    render(<BuilderApp />);
    tool("add");
    pick(null);
    expect(edits()).toEqual([]);
  });

  it("New starts a 10 Å cell and the welcome card goes away", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-welcome-new"));
    expect(screen.queryByTestId("builder-welcome")).toBeNull();
    expect(useBuilderStore.getState().source!.box![0]).toBe(10);
    expect(screen.getByTestId("builder-file-name").textContent).toContain("untitled");
    expect(applyViewportState).toHaveBeenCalled();
  });
});

describe("BuilderApp — editing", () => {
  beforeEach(() => {
    useBuilderStore.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "water.pdb");
  });

  it("Add places a free atom on empty space and a bonded one on an atom", () => {
    render(<BuilderApp />);
    tool("add");
    pick(null, { world: [5, 5, 5] });
    expect(edits()[0]).toMatchObject({ op: "add_atom", element: 6, position: [5, 5, 5] });
    expect(shownAtoms()).toBe(4);
    fireEvent.click(screen.getByTestId("builder-element-N"));
    fireEvent.change(screen.getByTestId("builder-bond-order"), { target: { value: "2" } });
    pick(0);
    expect(edits()[1]).toMatchObject({ op: "add_atom", element: 7, bondTo: 0, order: 2 });
    expect(shownAtoms()).toBe(5);
    expect(screen.getByTestId("builder-op-count").textContent).toBe("2 edits");
    expect(screen.getByTestId("builder-file-name").textContent).toContain("2 edits");
  });

  it("Delete removes the clicked atom; Element changes it; Bond joins two", () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    expect(edits()).toEqual([{ op: "delete_atoms", atoms: [2] }]);
    expect(shownAtoms()).toBe(2);
    tool("element");
    fireEvent.click(screen.getByTestId("builder-element-O"));
    pick(1);
    expect(edits()[1]).toEqual({ op: "set_element", atoms: [1], element: 8 });
    tool("bond");
    pick(0);
    expect(screen.getByTestId("builder-tool-hint").textContent).toContain("First atom: #0");
    pick(0); // same atom again: still pending
    expect(useBuilderStore.getState().pendingBondAtom).toBe(0);
    pick(1);
    expect(edits()[2]).toEqual({ op: "add_bond", a: 0, b: 1, order: 1 });
    expect(useBuilderStore.getState().pendingBondAtom).toBeNull();
    // Empty space with Delete / Element / Bond does nothing.
    tool("delete");
    pick(null);
    expect(edits()).toHaveLength(3);
  });

  it("Select and the selection actions", () => {
    render(<BuilderApp />);
    pick(1);
    pick(2, { shiftKey: true });
    expect(screen.getByTestId("builder-selected-count").textContent).toBe("2 atoms selected.");
    expect(viewportProps.current?.previewIndices).toEqual([1, 2]);
    fireEvent.click(screen.getByTestId("builder-set-element-selected"));
    expect(edits()[0]).toEqual({ op: "set_element", atoms: [1, 2], element: 6 });
    fireEvent.click(screen.getByTestId("builder-delete-selected"));
    expect(edits()[1]).toEqual({ op: "delete_atoms", atoms: [1, 2] });
    expect(shownAtoms()).toBe(1);
    expect(screen.getByTestId("builder-selected-count").textContent).toBe("No atoms selected.");
    pick(0);
    pick(null);
    expect(useBuilderStore.getState().selected).toEqual([]);
    pick(0);
    fireEvent.click(screen.getByTestId("builder-clear-selection"));
    expect(useBuilderStore.getState().selected).toEqual([]);
  });

  it("Move drags write one op, a zero-length drag leaves none, and the selection moves together", () => {
    render(<BuilderApp />);
    tool("move");
    expect(handlers().dragStart(0)).toBe(true);
    act(() => handlers().dragMove([1, 0, 0]));
    act(() => handlers().dragMove([2, 0, 0]));
    act(() => handlers().dragEnd());
    expect(edits()).toEqual([{ op: "move_atoms", atoms: [0], delta: [2, 0, 0] }]);
    // Zero-length drag: nothing left behind, redo stack untouched.
    expect(handlers().dragStart(1)).toBe(true);
    act(() => handlers().dragEnd());
    expect(edits()).toHaveLength(1);
    expect(useBuilderStore.getState().redoStack).toEqual([]);
    // Grabbing a selected atom drags the whole selection.
    act(() => useBuilderStore.getState().setSelected([1, 2]));
    expect(handlers().dragStart(2)).toBe(true);
    act(() => handlers().dragMove([0, 1, 0]));
    act(() => handlers().dragEnd());
    expect(edits()[1]).toEqual({ op: "move_atoms", atoms: [1, 2], delta: [0, 1, 0] });
    // Other tools refuse the drag; a bare click with Move selects.
    tool("select");
    expect(handlers().dragStart(0)).toBe(false);
    tool("move");
    pick(0);
    expect(useBuilderStore.getState().selected).toEqual([0]);
  });

  it("Place stamps the chosen library molecule on empty space only", () => {
    render(<BuilderApp />);
    tool("place");
    expect(screen.getByTestId("builder-tool-hint").textContent).toContain("Choose a molecule");
    pick(null, { world: [5, 5, 5] });
    expect(edits()).toEqual([]);
    // Choose a preset from the library: the tool stays Place and the hint names it.
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:water")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    expect(useBuilderStore.getState().tool).toBe("place");
    expect(screen.getByTestId("builder-tool-hint").textContent).toContain("Placing Water");
    pick(0);
    expect(edits()).toEqual([]);
    pick(null, { world: [5, 5, 5] });
    expect(edits()).toHaveLength(1);
    expect(edits()[0]).toMatchObject({ op: "add_fragment", translate: [5, 5, 5] });
    expect(shownAtoms()).toBe(6);
    expect(useBuilderStore.getState().selected).toEqual([3, 4, 5]);
    expect(screen.getByTestId("builder-op-list").textContent).toMatch(/Add water-\d+ \(3 atoms\)/);
    // Choosing the same molecule again turns Place off.
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:water")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    expect(useBuilderStore.getState().tool).toBe("select");
  });

  it("Place on atoms stamps the molecule above the clicked atom when an adsorption height is set", () => {
    render(<BuilderApp />);
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:water")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    fireEvent.change(screen.getByTestId("builder-adsorb-height"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBe(3);
    pick(0);
    expect(edits()).toHaveLength(1);
    const src = useBuilderStore.getState().source!;
    expect(edits()[0]).toMatchObject({
      op: "add_fragment",
      translate: [src.positions[0], src.positions[1], src.positions[2] + 3],
    });
    // Changing the height while on updates the store; turning it off restores inert atom clicks.
    fireEvent.change(screen.getByTestId("builder-adsorb-height"), { target: { value: "1.5" } });
    expect(useBuilderStore.getState().adsorbHeight).toBe(1.5);
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBeNull();
    pick(0);
    expect(edits()).toHaveLength(1);
  });

  it("Undo / Redo / Clear all from the sidebar and the top bar", () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    pick(1);
    expect(shownAtoms()).toBe(1);
    fireEvent.click(screen.getByTestId("builder-undo"));
    expect(shownAtoms()).toBe(2);
    fireEvent.click(screen.getByTestId("builder-topbar-redo"));
    expect(shownAtoms()).toBe(1);
    fireEvent.click(screen.getByTestId("builder-topbar-undo"));
    fireEvent.click(screen.getByTestId("builder-redo"));
    expect(shownAtoms()).toBe(1);
    expect(screen.getByTestId("builder-op-list").textContent).toContain("Delete 1 atom");
    fireEvent.click(screen.getByTestId("builder-clear-ops"));
    expect(edits()).toEqual([]);
    expect(shownAtoms()).toBe(3);
  });

  it("Show original previews the file and pauses editing until turned off", () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.click(screen.getByTestId("builder-show-original"));
    expect(shownAtoms()).toBe(3);
    expect(screen.getByTestId("builder-paused")).toBeTruthy();
    pick(1);
    expect(edits()).toHaveLength(1);
    expect(handlers().dragStart(0)).toBe(false);
    fireEvent.click(screen.getByTestId("builder-show-original"));
    expect(shownAtoms()).toBe(2);
    expect(screen.queryByTestId("builder-paused")).toBeNull();
  });

  it("keeps the camera across edits (revision key) and surfaces warnings", () => {
    render(<BuilderApp />);
    const key = viewportProps.current?.preserveCameraKey;
    act(() => useBuilderStore.getState().pushOp({ op: "delete_atoms", atoms: [99] }));
    expect(viewportProps.current?.preserveCameraKey).not.toBe(key);
    expect(screen.getByTestId("builder-warnings").textContent).toContain("unknown atom 99");
  });

  it("saves the shown structure with the document's name and labels", async () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.click(screen.getByTestId("builder-save-pdb"));
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
    const [snapshot, format, name, labels] = exportSnapshot.mock.calls[0] as unknown[];
    expect((snapshot as Snapshot).nAtoms).toBe(2);
    expect(format).toBe("pdb");
    expect(name).toBe("water.pdb");
    expect(labels).toEqual(["HOH", "HOH", "HOH"]);
    fireEvent.click(screen.getByTestId("builder-export-xyz"));
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(2));
  });

  it("New empty cell from the sidebar replaces the document", () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.change(screen.getByTestId("builder-new-cell-edge"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("builder-new-cell"));
    expect(useBuilderStore.getState().source!.box![0]).toBe(15);
    expect(edits()).toEqual([]);
    expect(shownAtoms()).toBe(0);
    fireEvent.change(screen.getByTestId("builder-new-cell-edge"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("builder-new-cell"));
    expect(useBuilderStore.getState().source!.box![0]).toBe(15);
  });

  it("Reset View and the axis buttons drive the renderer", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("reset-view-btn"));
    expect(rendererStub.resetCamera).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("view-axis-+x"));
    expect(rendererStub.alignCameraToAxis).toHaveBeenCalledWith("+x");
  });
});

describe("BuilderApp — Open", () => {
  it("parses the chosen file into a new document", async () => {
    parseStructureFile.mockResolvedValue({
      snapshot: water(),
      labels: ["HOH", "HOH", "HOH"],
      frames: [],
      meta: null,
      vectorChannels: [],
      scalarChannels: [],
      warnings: [],
    });
    render(<BuilderApp />);
    const input = screen.getByTestId("builder-open-input") as HTMLInputElement;
    const file = new File(["x"], "water.pdb");
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("builder-file-name").textContent).toBe("water.pdb"),
    );
    expect(parseStructureFile).toHaveBeenCalledWith(file);
    expect(shownAtoms()).toBe(3);
    expect(screen.queryByTestId("builder-welcome")).toBeNull();
  });

  it("reports a file that does not parse and keeps the document", async () => {
    parseStructureFile.mockRejectedValue(new Error("no atoms"));
    useBuilderStore.getState().newCell(10);
    render(<BuilderApp />);
    fireEvent.change(screen.getByTestId("builder-open-input"), {
      target: { files: [new File(["x"], "broken.pdb")] },
    });
    await waitFor(() => expect(screen.getByTestId("builder-open-error")).toBeTruthy());
    expect(screen.getByTestId("builder-open-error").textContent).toContain("broken.pdb");
    expect(useBuilderStore.getState().fileName).toBe("untitled");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByTestId("builder-open-error")).toBeNull();
  });

  it("the Open buttons forward to the hidden file input", () => {
    render(<BuilderApp />);
    const input = screen.getByTestId("builder-open-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("builder-open"));
    fireEvent.click(screen.getByTestId("builder-welcome-open"));
    expect(click).toHaveBeenCalledTimes(2);
  });
});
