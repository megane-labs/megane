/**
 * megane Builder app shell: the Builder panel and its toolbar, the view
 * controls, the welcome card, the notice line, the keyboard shortcuts, and the click / drag handlers it
 * installs for the (mocked) 3D view.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

const { rendererStub, viewportProps, applyViewportState, exportSnapshot, parseStructureFile } =
  vi.hoisted(() => ({
    rendererStub: {
      setViewInsets: vi.fn(),
      resetCamera: vi.fn(),
      resetView: vi.fn(),
      alignCameraToAxis: vi.fn(),
      setBackgroundColor: vi.fn(),
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
import { useLibraryUi } from "@/builder/library/ui";
import { useToolsStore } from "@/builder/tools/store";
import type { BuilderToolInfo } from "@/builder/tools/contract";
import type { BuildHandlers } from "@/builder/types";
import type { Snapshot } from "@/types";
import { useThemeStore, themeToHex } from "@/stores/useThemeStore";

/** Water's shape with no hydrogens: O bonded to two C. */
function skeleton(): Snapshot {
  return { ...water(), elements: new Uint8Array([8, 6, 6]) };
}

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
/** Open the top bar's Save menu and pick a format. */
const save = (format: string) => {
  fireEvent.click(screen.getByTestId("builder-file"));
  fireEvent.click(screen.getByTestId(`builder-save-${format}`));
};

beforeEach(() => {
  localStorage.clear();
  useLibraryUi.setState({ sketch: null, galleryOpen: false });
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
    notice: null,
  });
  applyViewportState.mockClear();
  exportSnapshot.mockClear();
  parseStructureFile.mockReset();
  rendererStub.setViewInsets.mockClear();
  rendererStub.resetCamera.mockClear();
});

afterEach(() => {
  cleanup();
  useThemeStore.getState().setTheme("system");
});

describe("BuilderApp — empty state", () => {
  it("shows the welcome card and centres the view left of the panel", () => {
    render(<BuilderApp />);
    expect(screen.getByTestId("builder-welcome")).toBeTruthy();
    expect(screen.getByTestId("builder-file-name").textContent).toBe("No structure");
    expect(screen.getByTestId("builder-empty-hint").textContent).toContain("File menu");
    expect(shownAtoms()).toBe(0);
    // The panels float over the right of the view (372 px + the 12 px inset),
    // as the viewer's Pipeline panel does.
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 384);
    // The view is always in edit mode with the handlers installed.
    expect(viewportProps.current?.buildActive).toBe(true);
    expect(viewportProps.current?.buildHandlers).toBe(useBuilderStore.getState().handlers);
    // Nothing to save yet.
    fireEvent.click(screen.getByTestId("builder-file"));
    expect((screen.getByTestId("builder-save-xyz") as HTMLButtonElement).disabled).toBe(true);
  });

  it("clicks on the empty view do nothing", () => {
    render(<BuilderApp />);
    tool("add");
    // No document, nothing to set: the context bar waits for one.
    expect(screen.queryByTestId("builder-context-bar")).toBeNull();
    pick(null);
    expect(edits()).toEqual([]);
  });

  it("Place works with nothing open: the gallery shows and the first click starts a document", () => {
    render(<BuilderApp />);
    tool("place");
    expect(useBuilderStore.getState().tool).toBe("place");
    // The gallery takes the welcome card's place.
    expect(screen.getByTestId("builder-library")).toBeTruthy();
    expect(screen.queryByTestId("builder-welcome")).toBeNull();
    // Nothing chosen yet: a click does nothing.
    pick(null);
    expect(useBuilderStore.getState().source).toBeNull();
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:water")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    // A click on nothing without a point does nothing either.
    act(() => handlers().pick({ atomIndex: null, world: null, shiftKey: false }));
    expect(useBuilderStore.getState().source).toBeNull();
    pick(null, { world: [1, 2, 3] });
    expect(useBuilderStore.getState().fileName).toBe("untitled");
    expect(shownAtoms()).toBe(3);
    expect(edits()).toHaveLength(1);
  });

  it("the welcome card starts an empty cell through the New dialog", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-welcome-new"));
    fireEvent.click(screen.getByTestId("builder-new-cell"));
    expect(screen.queryByTestId("builder-new-dialog")).toBeNull();
    expect(screen.queryByTestId("builder-welcome")).toBeNull();
    expect(useBuilderStore.getState().source!.box![0]).toBe(10);
    expect(screen.getByTestId("builder-file-name").textContent).toContain("untitled");
    expect(applyViewportState).toHaveBeenCalled();
  });

  it("the welcome card and the top bar both reach the bulk form", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-welcome-bulk"));
    fireEvent.click(screen.getByTestId("builder-bulk-create"));
    expect(useBuilderStore.getState().fileName).toBe("Cu-fcc");
    expect(shownAtoms()).toBe(4);
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-bulk-item"));
    expect(screen.getByTestId("builder-new-replaces")).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-new-close"));
    expect(screen.queryByTestId("builder-new-dialog")).toBeNull();
  });
});

describe("BuilderApp — editing", () => {
  beforeEach(() => {
    useBuilderStore.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "water.pdb");
  });

  it("Add places a free atom on empty space and a bonded one on an atom", () => {
    // A bare skeleton: no hydrogens to keep balanced.
    useBuilderStore.getState().openStructure(skeleton(), null, "skeleton.xyz");
    render(<BuilderApp />);
    tool("add");
    pick(null, { world: [5, 5, 5] });
    expect(edits()[0]).toMatchObject({ op: "add_atom", element: 6, position: [5, 5, 5] });
    expect(shownAtoms()).toBe(4);
    fireEvent.click(screen.getByTestId("builder-element-N"));
    fireEvent.click(screen.getByTestId("builder-bond-order-2"));
    expect(screen.getByTestId("builder-bond-order-2").getAttribute("aria-checked")).toBe("true");
    pick(0);
    expect(edits()[1]).toMatchObject({ op: "add_atom", element: 7, bondTo: 0, order: 2 });
    expect(shownAtoms()).toBe(5);
    expect(screen.getByTestId("builder-op-count").textContent).toBe("2 edits");
    expect(screen.getByTestId("builder-file-name").textContent).toContain("2 edits");
  });

  it("shows only the settings the current tool uses, in the Details panel", () => {
    render(<BuilderApp />);
    // Select needs neither an element nor a bond order: only its own settings.
    expect(screen.getByTestId("builder-context-label").textContent).toBe("Select");
    expect(screen.getByTestId("builder-select-box")).toBeTruthy();
    expect(screen.queryByTestId("builder-element-z")).toBeNull();
    expect(screen.queryByTestId("builder-bond-order")).toBeNull();
    expect(screen.queryByTestId("builder-adsorb-toggle")).toBeNull();
    tool("add");
    expect(screen.getByTestId("builder-context-label").textContent).toBe("Add atom");
    expect(screen.getByTestId("builder-element-z")).toBeTruthy();
    expect(screen.getByTestId("builder-bond-order")).toBeTruthy();
    // The settings are in the Details panel, not over the view.
    expect(
      screen.getByTestId("builder-sidebar").querySelector('[data-testid="builder-element-z"]'),
    ).toBeTruthy();
    tool("bond");
    expect(screen.queryByTestId("builder-element-z")).toBeNull();
    expect(screen.getByTestId("builder-bond-order")).toBeTruthy();
    tool("element");
    expect(screen.getByTestId("builder-element-z")).toBeTruthy();
    expect(screen.queryByTestId("builder-bond-order")).toBeNull();
    tool("place");
    expect(screen.getByTestId("builder-adsorb-toggle")).toBeTruthy();
    tool("delete");
    expect(screen.queryByTestId("builder-context-bar")).toBeNull();
    // The status bar always names the tool.
    expect(screen.getByTestId("builder-status-tool").textContent).toContain("Delete (D)");
  });

  it("Delete removes the clicked atom; Element changes it; Bond joins two", () => {
    useBuilderStore.getState().openStructure(skeleton(), null, "skeleton.xyz");
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

  it("Add on a hydrogen replaces it and Element rebalances hydrogens, each one undo step", () => {
    render(<BuilderApp />);
    tool("add");
    // Water's H becomes a C with three H of its own: methanol.
    pick(1);
    const methanol = useBuilderStore.getState().result!.snapshot;
    expect(Array.from(methanol.elements).sort()).toEqual([1, 1, 1, 1, 6, 8]);
    // Setting that C to O leaves a peroxide H–O–O–H.
    tool("element");
    fireEvent.click(screen.getByTestId("builder-element-O"));
    pick(1);
    expect(Array.from(useBuilderStore.getState().result!.snapshot.elements).sort()).toEqual([
      1, 1, 8, 8,
    ]);
    // One Undo per click, and Redo restores the whole click.
    fireEvent.click(screen.getByTestId("builder-undo"));
    expect(shownAtoms()).toBe(6);
    fireEvent.click(screen.getByTestId("builder-undo"));
    expect(shownAtoms()).toBe(3);
    expect(edits()).toHaveLength(0);
    act(() => {
      useBuilderStore.getState().redo();
    });
    expect(shownAtoms()).toBe(6);
  });

  it("Select and the selection actions, which appear only with a selection", () => {
    render(<BuilderApp />);
    expect(screen.queryByTestId("builder-selection")).toBeNull();
    pick(1);
    pick(2, { shiftKey: true });
    expect(screen.getByTestId("builder-selected-count").textContent).toBe("2 atoms selected");
    expect(screen.getByTestId("builder-status-selection").textContent).toBe("2 selected");
    expect(viewportProps.current?.previewIndices).toEqual([1, 2]);
    fireEvent.click(screen.getByTestId("builder-set-element-selected"));
    expect(edits()[0]).toEqual({ op: "set_element", atoms: [1, 2], element: 6 });
    fireEvent.click(screen.getByTestId("builder-delete-selected"));
    expect(edits()[1]).toEqual({ op: "delete_atoms", atoms: [1, 2] });
    expect(shownAtoms()).toBe(1);
    expect(screen.queryByTestId("builder-selection")).toBeNull();
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
    // The gallery closed once a molecule was chosen; the picker reopens it,
    // and choosing the same molecule again turns Place off.
    expect(screen.queryByTestId("builder-library")).toBeNull();
    expect(screen.getByTestId("builder-place-fragment").textContent).toContain("Water");
    fireEvent.click(screen.getByTestId("builder-place-fragment"));
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:water")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    expect(useBuilderStore.getState().tool).toBe("select");
  });

  it("Place on atoms stamps the molecule above the clicked atom when an adsorption height is set", () => {
    render(<BuilderApp />);
    tool("place");
    fireEvent.click(
      screen
        .getByTestId("builder-library-item-preset:water")
        .querySelector('[data-testid="builder-library-place"]')!,
    );
    // Typing a height while the option is off leaves atom clicks inert.
    fireEvent.change(screen.getByTestId("builder-adsorb-height"), { target: { value: "3" } });
    expect(useBuilderStore.getState().adsorbHeight).toBeNull();
    pick(0);
    expect(edits()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBe(3);
    pick(0);
    expect(edits()).toHaveLength(1);
    const src = useBuilderStore.getState().source!;
    expect(edits()[0]).toMatchObject({
      op: "add_fragment",
      translate: [src.positions[0], src.positions[1], src.positions[2] + 3],
    });
    // Unticking restores inert atom clicks; ticking again restores the height.
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBeNull();
    pick(0);
    expect(edits()).toHaveLength(1);
    fireEvent.click(screen.getByTestId("builder-adsorb-toggle"));
    expect(useBuilderStore.getState().adsorbHeight).toBe(3);
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
    fireEvent.click(screen.getByTestId("builder-resume-editing"));
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
    save("pdb");
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
    const [snapshot, format, name, labels] = exportSnapshot.mock.calls[0] as unknown[];
    expect((snapshot as Snapshot).nAtoms).toBe(2);
    expect(format).toBe("pdb");
    expect(name).toBe("water.pdb");
    expect(labels).toEqual(["HOH", "HOH", "HOH"]);
    save("xyz");
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(2));
  });

  it("New from the top bar replaces the document", () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-cell-item"));
    fireEvent.change(screen.getByTestId("builder-new-cell-edge"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("builder-new-cell"));
    expect(useBuilderStore.getState().source!.box![0]).toBe(15);
    expect(edits()).toEqual([]);
    expect(shownAtoms()).toBe(0);
  });

  it("the view controls reset the camera and look along an axis, as in the viewer", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-reset-view"));
    expect(rendererStub.resetCamera).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("view-axis-+x"));
    expect(rendererStub.alignCameraToAxis).toHaveBeenCalledWith("+x");
    // No cell: no lattice directions.
    expect(screen.queryByTestId("view-axis-+a")).toBeNull();
  });

  it("the theme button cycles the theme and the 3D view follows it", () => {
    act(() => useThemeStore.getState().setTheme("light"));
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-theme"));
    expect(useThemeStore.getState().theme).toBe("dark");
    expect(rendererStub.setBackgroundColor).toHaveBeenLastCalledWith(themeToHex("dark"));
    act(() => useThemeStore.getState().setTheme("light"));
    expect(rendererStub.setBackgroundColor).toHaveBeenLastCalledWith(themeToHex("light"));
  });

  it("collapses the panels to their stubs and gives the view back its full width", () => {
    render(<BuilderApp />);
    // History starts closed with no edits; Details open.
    expect(screen.getByTestId("panel-history").getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(screen.getByTestId("panel-details-toggle"));
    expect(screen.getByTestId("panel-details").getAttribute("data-collapsed")).toBe("true");
    expect(screen.queryByTestId("builder-sidebar")).toBeNull();
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 0);
    // History alone still covers the right of the view.
    fireEvent.click(screen.getByTestId("panel-history-toggle"));
    expect(screen.getByTestId("builder-history")).toBeTruthy();
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 384);
    fireEvent.click(screen.getByTestId("panel-history-toggle"));
    // Opening a form reveals a collapsed Details panel.
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-cell-item"));
    expect(screen.getByTestId("panel-details").getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByTestId("builder-new-dialog")).toBeTruthy();
    expect(rendererStub.setViewInsets).toHaveBeenLastCalledWith(0, 384);
  });

  it("a Python tool's form replaces an open form and reveals the Details panel", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("panel-details-toggle"));
    const tool: BuilderToolInfo = {
      name: "liquid_box",
      label: "Liquid box",
      tooltip: "Fill a box.",
      description: "Fill a box.",
      category: "bulk",
      apply: "new_document",
      document: "none",
      stochastic: false,
      expectedSeconds: null,
      inputSchema: {},
      fields: [],
      formError: null,
    };
    act(() => useToolsStore.getState().openForm(tool));
    expect(screen.getByTestId("panel-details").getAttribute("data-collapsed")).toBe("false");
    expect(screen.getByTestId("builder-tool-dialog")).toBeTruthy();
    // A menu form closes the tool's form in turn.
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-bulk-item"));
    expect(screen.queryByTestId("builder-tool-dialog")).toBeNull();
    expect(useToolsStore.getState().openTool).toBeNull();
    expect(screen.getByTestId("builder-new-dialog")).toBeTruthy();
  });

  it("shows one form at a time in the Details panel", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-cell-item"));
    expect(screen.getByTestId("builder-new-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-tools"));
    fireEvent.click(screen.getByTestId("builder-tools-server"));
    expect(screen.getByTestId("builder-tools-dialog")).toBeTruthy();
    expect(screen.queryByTestId("builder-new-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-tools-dialog-close"));
    // With no form open, the panel is back to the current tool's settings.
    expect(screen.getByTestId("builder-context-bar")).toBeTruthy();
    // A tool without settings says so.
    tool("move");
    expect(screen.getByTestId("builder-empty-hint").textContent).toContain("Move has no settings");
  });
});

describe("BuilderApp — keyboard", () => {
  beforeEach(() => {
    useBuilderStore.getState().openStructure(water(), null, "water.pdb");
  });

  it("picks tools, undoes, deletes the selection and clears it", () => {
    render(<BuilderApp />);
    fireEvent.keyDown(window, { key: "b" });
    expect(useBuilderStore.getState().tool).toBe("bond");
    fireEvent.keyDown(window, { key: "s" });
    expect(useBuilderStore.getState().tool).toBe("select");
    pick(1);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(edits()).toEqual([{ op: "delete_atoms", atoms: [1] }]);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(edits()).toEqual([]);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(edits()).toHaveLength(1);
    pick(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useBuilderStore.getState().selected).toEqual([]);
    fireEvent.keyDown(window, { key: "r" });
    expect(rendererStub.resetCamera).toHaveBeenCalled();
  });

  it("ignores keys typed into a field or while a modal dialog is open", () => {
    render(<BuilderApp />);
    tool("add");
    const z = screen.getByTestId("builder-element-z");
    fireEvent.keyDown(z, { key: "b" });
    expect(useBuilderStore.getState().tool).toBe("add");
    // A form in the Details panel is not modal: its fields swallow keys, the
    // tool keys still work beside it.
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-cell-item"));
    const edge = screen.getByTestId("builder-new-dialog").querySelector("input")!;
    fireEvent.keyDown(edge, { key: "b" });
    expect(useBuilderStore.getState().tool).toBe("add");
    fireEvent.keyDown(window, { key: "b" });
    expect(useBuilderStore.getState().tool).toBe("bond");
    // A modal (the Ketcher sketcher) owns the keyboard.
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    try {
      fireEvent.keyDown(window, { key: "a" });
      expect(useBuilderStore.getState().tool).toBe("bond");
    } finally {
      modal.remove();
    }
  });

  it("Ctrl+O opens the file picker and Ctrl+S saves XYZ", async () => {
    render(<BuilderApp />);
    const input = screen.getByTestId("builder-open-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(click).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
    expect(exportSnapshot.mock.calls[0][1]).toBe("xyz");
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

  it("opens a file dropped on the view", async () => {
    parseStructureFile.mockResolvedValue({
      snapshot: water(),
      labels: null,
      frames: [],
      meta: null,
      vectorChannels: [],
      scalarChannels: [],
      warnings: [],
    });
    render(<BuilderApp />);
    const zone = screen.getByTestId("builder-dropzone");
    fireEvent.dragOver(zone);
    expect(screen.getByTestId("builder-drop-overlay")).toBeTruthy();
    fireEvent.dragLeave(zone);
    expect(screen.queryByTestId("builder-drop-overlay")).toBeNull();
    const file = new File(["x"], "dropped.xyz");
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("builder-file-name").textContent).toBe("dropped.xyz"),
    );
    // A drop with no file is ignored.
    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(parseStructureFile).toHaveBeenCalledTimes(1);
  });

  it("reports a file that does not parse in the notice line and keeps the document", async () => {
    parseStructureFile.mockRejectedValue(new Error("no atoms"));
    useBuilderStore.getState().newCell(10);
    render(<BuilderApp />);
    fireEvent.change(screen.getByTestId("builder-open-input"), {
      target: { files: [new File(["x"], "broken.pdb")] },
    });
    await waitFor(() => expect(screen.getByTestId("builder-notice")).toBeTruthy());
    const notice = screen.getByTestId("builder-notice");
    expect(notice.getAttribute("data-level")).toBe("error");
    expect(notice.textContent).toContain("broken.pdb");
    expect(useBuilderStore.getState().fileName).toBe("untitled");
    fireEvent.click(screen.getByTestId("builder-notice-dismiss"));
    expect(screen.queryByTestId("builder-notice")).toBeNull();
    // An empty change is ignored.
    fireEvent.change(screen.getByTestId("builder-open-input"), { target: { files: [] } });
    expect(parseStructureFile).toHaveBeenCalledTimes(1);
  });

  it("the Open buttons forward to the hidden file input", () => {
    render(<BuilderApp />);
    const input = screen.getByTestId("builder-open-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-open"));
    fireEvent.click(screen.getByTestId("builder-welcome-open"));
    expect(click).toHaveBeenCalledTimes(2);
  });
});

describe("BuilderApp — Structure and Tools menus", () => {
  const cu = () =>
    useBuilderStore.getState().newBulk({ structure: "fcc", elements: [29], a: 4, cubic: true });
  const menu = (trigger: string, item: string) => {
    fireEvent.click(screen.getByTestId(trigger));
    fireEvent.click(screen.getByTestId(item));
  };
  const viewAtoms = () => (viewportProps.current?.snapshot as Snapshot | null)?.nAtoms;

  it("a Structure dialog previews its op in the view, hides the context bar, and Apply commits", async () => {
    cu();
    render(<BuilderApp />);
    tool("add");
    expect(screen.getByTestId("builder-context-bar")).toBeTruthy();
    menu("builder-structure", "builder-structure-supercell");
    expect(screen.getByTestId("builder-crystal-dialog").getAttribute("data-kind")).toBe(
      "supercell",
    );
    expect(screen.queryByTestId("builder-context-bar")).toBeNull();
    await waitFor(() => expect(viewAtoms()).toBe(32));
    // The document is untouched while the view shows the preview.
    expect(shownAtoms()).toBe(4);
    expect(screen.getByTestId("builder-status-atoms").textContent).toBe("32 atoms · 0 bonds");
    expect(screen.getByTestId("builder-status-preview")).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-supercell-apply"));
    expect(shownAtoms()).toBe(32);
    expect(edits()[0]).toMatchObject({ op: "supercell" });
    expect(screen.queryByTestId("builder-crystal-dialog")).toBeNull();
    expect(screen.queryByTestId("builder-status-preview")).toBeNull();
    expect(screen.getByTestId("builder-context-bar")).toBeTruthy();
  });

  it("Wrap and Remove cell run straight from the menu; Set cell opens the Cell form", () => {
    cu();
    render(<BuilderApp />);
    menu("builder-structure", "builder-cell-wrap");
    expect(edits()).toEqual([{ op: "wrap" }]);
    menu("builder-structure", "builder-structure-cell");
    expect(screen.getByTestId("builder-crystal-dialog").getAttribute("data-kind")).toBe("cell");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-crystal-dialog")).toBeNull();
    menu("builder-structure", "builder-cell-remove");
    expect(edits()[1]).toEqual({ op: "set_cell", box: null });
    expect(screen.getByTestId("builder-crystal-cell-summary").textContent).toBe("No cell");
  });

  it("a new document closes an open Structure dialog and drops its preview", async () => {
    cu();
    render(<BuilderApp />);
    menu("builder-structure", "builder-structure-supercell");
    await waitFor(() => expect(useBuilderStore.getState().preview).not.toBeNull());
    act(() => useBuilderStore.getState().newCell(10));
    expect(screen.queryByTestId("builder-crystal-dialog")).toBeNull();
    expect(useBuilderStore.getState().preview).toBeNull();
  });

  it("the Structure menu waits for a document", () => {
    render(<BuilderApp />);
    expect((screen.getByTestId("builder-structure") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Tools › Tool server… opens the connection dialog", () => {
    render(<BuilderApp />);
    menu("builder-tools", "builder-tools-server");
    expect(screen.getByTestId("builder-tools-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-tools-dialog-close"));
    expect(screen.queryByTestId("builder-tools-dialog")).toBeNull();
  });

  it("the library has one way in, the Place tool: no Insert menu repeats its gallery", () => {
    cu();
    render(<BuilderApp />);
    expect(screen.queryByTestId("builder-insert")).toBeNull();
    tool("place");
    expect(screen.getByTestId("builder-library")).toBeTruthy();
    // The gallery holds what the Insert menu used to repeat: Sketch… and From file….
    fireEvent.click(screen.getByTestId("builder-library-sketch"));
    expect(useLibraryUi.getState().sketch).toEqual({});
    act(() => useLibraryUi.getState().closeSketch());
    const input = screen.getByTestId("builder-library-import-input") as HTMLInputElement;
    const pickFile = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("builder-library-import"));
    expect(pickFile).toHaveBeenCalled();
    // …and the Inspector keeps a selection as a molecule.
    tool("select");
    act(() => useBuilderStore.getState().setSelected([0, 1]));
    fireEvent.click(screen.getByTestId("builder-library-save-selection"));
    expect(useBuilderStore.getState().notice?.text).toContain("to the library");
  });

  it("fits the view when a Structure preview starts and ends", async () => {
    cu();
    render(<BuilderApp />);
    rendererStub.resetView.mockClear();
    menu("builder-structure", "builder-structure-supercell");
    await waitFor(() => expect(useBuilderStore.getState().preview).not.toBeNull());
    expect(rendererStub.resetView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("builder-crystal-cancel"));
    expect(rendererStub.resetView).toHaveBeenCalledTimes(2);
  });

  it("Structure › Clean up geometry runs on the whole structure", () => {
    cu();
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-structure"));
    expect(screen.getByTestId("builder-structure-cleanup").textContent).toBe("Clean up geometry");
    fireEvent.click(screen.getByTestId("builder-structure-cleanup"));
    expect(useBuilderStore.getState().notice?.text).toContain("Cleaning up");
  });
});

describe("BuilderApp — selecting and the atom menu", () => {
  beforeEach(() => {
    useBuilderStore.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "water.pdb");
  });

  it("box selection is on only with the Select tool and its Box toggle", () => {
    render(<BuilderApp />);
    expect(viewportProps.current?.boxSelectActive).toBe(false);
    fireEvent.click(screen.getByTestId("builder-select-box"));
    expect(viewportProps.current?.boxSelectActive).toBe(true);
    type BoxSelect = (i: number[], o: { additive: boolean }) => void;
    const box = (indices: number[], additive: boolean) =>
      act(() => (viewportProps.current?.onBoxSelect as BoxSelect)(indices, { additive }));
    box([1, 2], false);
    expect(useBuilderStore.getState().selected).toEqual([1, 2]);
    // Shift adds to the selection; a plain box replaces it.
    box([2, 4], true);
    expect(useBuilderStore.getState().selected).toEqual([1, 2, 4]);
    box([0], false);
    expect(useBuilderStore.getState().selected).toEqual([0]);
    tool("add");
    expect(viewportProps.current?.boxSelectActive).toBe(false);
  });

  it("a right-click on an atom opens its menu where the pointer was, and hides the tooltip", () => {
    render(<BuilderApp />);
    fireEvent.contextMenu(screen.getByTestId("builder-dropzone"), { clientX: 40, clientY: 50 });
    act(() => (viewportProps.current?.onAtomRightClick as (i: number) => void)(1));
    const menu = screen.getByTestId("builder-atom-menu");
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("50px");
    fireEvent.click(screen.getByTestId("builder-atom-menu-molecule"));
    expect(useBuilderStore.getState().selected).toEqual([0, 1, 2]);
    expect(screen.queryByTestId("builder-atom-menu")).toBeNull();
  });

  it("the atom menu does not open over a preview", () => {
    act(() => useBuilderStore.getState().setPreview({ op: "center", axes: [0], vacuum: 3 }));
    render(<BuilderApp />);
    act(() => (viewportProps.current?.onAtomRightClick as (i: number) => void)(0));
    expect(screen.queryByTestId("builder-atom-menu")).toBeNull();
  });

  it("tool keys keep working while the Place gallery is open", () => {
    render(<BuilderApp />);
    tool("place");
    expect(screen.getByTestId("builder-library")).toBeTruthy();
    fireEvent.keyDown(window, { key: "s" });
    expect(useBuilderStore.getState().tool).toBe("select");
  });

  it("the history lists Undo steps, not ops", () => {
    render(<BuilderApp />);
    act(() => {
      useBuilderStore.getState().pushOps([
        { op: "move_atoms", atoms: [1], delta: [1, 0, 0] },
        { op: "move_atoms", atoms: [2], delta: [0, 1, 0] },
      ]);
    });
    expect(screen.getByTestId("builder-op-count").textContent).toBe("1 edit");
    expect(screen.getByTestId("builder-file-name").textContent).toContain("1 edit");
    expect(screen.getByTestId("builder-op-list").textContent).toBe("Move 2 atoms");
  });
});
