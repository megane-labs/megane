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
      testGetProjectedAtomPositions: vi.fn(() => [
        { index: 0, sx: 500, sy: 500, depth: 0, element: 8 },
        { index: 1, sx: 40, sy: 50, depth: 0, element: 1 },
      ]),
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

import { BuilderApp, NOTICE_TIMEOUT_MS, formatUnavailable, isFlowFile } from "@/builder/BuilderApp";
import { AUTOSAVE_KEY, readAutosave, writeAutosave } from "@/builder/autosave";
import { createBuilderStore } from "@/builder/store";
import { useBuilderStore } from "@/builder/store";
import { useLibraryUi } from "@/builder/library/ui";
import { useToolsStore } from "@/builder/tools/store";
import type { BuilderToolInfo } from "@/builder/tools/contract";
import type { BuildDragGesture, BuildHandlers } from "@/builder/types";
import { HOVER_COLORS } from "@/builder/hover";
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

const NO_MODS = { shiftKey: false, mod: false, altKey: false };

/**
 * A drag of (dx, dy) px seen straight down z (screen right = +x, up = +y),
 * at 0.1 Å per pixel.
 */
function gesture(dx: number, dy: number): BuildDragGesture {
  return {
    from: [100, 100],
    to: [100 + dx, 100 + dy],
    right: [1, 0, 0],
    up: [0, 1, 0],
    toCamera: [0, 0, 1],
    worldPerPixel: 0.1,
    project: (p) => [100 + p[0] * 10, 100 - p[1] * 10],
  };
}

/** Start a drag the way the view does, inside `act` so the app re-renders. */
function startDrag(atom: number, mods = NO_MODS): boolean {
  let ok = false;
  act(() => {
    ok = handlers().dragStart(atom, mods);
  });
  return ok;
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
    snap: false,
    drag: null,
    notice: null,
    hydrogenMode: "auto",
  });
  // A question a test left open would hold the keyboard in the next one.
  useBuilderStore.getState().resolveConfirm(false);
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
    expect(screen.getByTestId("builder-select-all")).toBeTruthy();
    expect(screen.getByTestId("builder-snap")).toBeTruthy();
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
    // Delete changes atoms, so its only setting is how hydrogens are kept.
    tool("delete");
    expect(screen.getByTestId("builder-context-label").textContent).toBe("Delete");
    expect(screen.getByTestId("builder-hydrogens")).toBeTruthy();
    expect(screen.queryByTestId("builder-element-z")).toBeNull();
    expect(screen.queryByTestId("builder-bond-order")).toBeNull();
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
    // Plain ops, without hydrogen bookkeeping (covered in editActions.test.ts).
    useBuilderStore.getState().setHydrogenMode("off");
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

  it("Move drags write one step, a zero-length drag leaves none, and the selection moves together", () => {
    render(<BuilderApp />);
    tool("move");
    expect(startDrag(0)).toBe(true);
    // The grabbed atom becomes the selection, so the halo shows what moves.
    expect(useBuilderStore.getState().selected).toEqual([0]);
    act(() => handlers().dragMove(gesture(10, 0)));
    act(() => handlers().dragMove(gesture(20, 0)));
    act(() => handlers().dragEnd());
    expect(edits()).toEqual([{ op: "move_atoms", atoms: [0], delta: [2, 0, 0] }]);
    // Zero-length drag: nothing left behind, redo stack untouched.
    act(() => useBuilderStore.getState().undo());
    expect(startDrag(1)).toBe(true);
    act(() => handlers().dragEnd());
    expect(edits()).toHaveLength(0);
    expect(useBuilderStore.getState().redoStack).toHaveLength(1);
    act(() => useBuilderStore.getState().redo());
    // Grabbing a selected atom drags the whole selection.
    act(() => useBuilderStore.getState().setSelected([1, 2]));
    expect(startDrag(2)).toBe(true);
    act(() => handlers().dragMove(gesture(0, -10)));
    act(() => handlers().dragEnd());
    expect(edits()[1]).toEqual({ op: "move_atoms", atoms: [1, 2], delta: [0, 1, 0] });
    expect(useBuilderStore.getState().drag).toBeNull();
    // Other tools refuse the drag; a bare click with Move selects.
    tool("add");
    expect(startDrag(0)).toBe(false);
    tool("move");
    pick(0);
    expect(useBuilderStore.getState().selected).toEqual([0]);
  });

  it("a press asks Select and Move what a drag from there does", () => {
    render(<BuilderApp />);
    const press = (atom: number | null) => handlers().pressAction(atom, NO_MODS);
    // Select: the selection moves, anything else turns the view as in the
    // viewer, or draws a box while Box is on.
    act(() => useBuilderStore.getState().setSelected([1]));
    expect(press(1)).toBe("move");
    expect(press(2)).toBe("camera");
    expect(press(null)).toBe("camera");
    act(() => useBuilderStore.getState().setBoxSelect(true));
    expect(press(1)).toBe("move");
    expect(press(2)).toBe("box");
    expect(press(null)).toBe("box");
    // Move: any atom moves, empty space turns the view; Box is Select's only.
    tool("move");
    expect(press(2)).toBe("move");
    expect(press(null)).toBe("camera");
    // The other tools leave drags to the camera, as does a paused document.
    tool("add");
    expect(press(1)).toBe("camera");
    tool("select");
    act(() => useBuilderStore.getState().setShowOriginal(true));
    expect(press(1)).toBe("camera");
  });

  it("Ctrl drags turn the selection about its centre as one step; Esc cancels a drag", () => {
    render(<BuilderApp />);
    act(() => useBuilderStore.getState().setSelected([0, 1, 2]));
    expect(startDrag(0, { ...NO_MODS, mod: true })).toBe(true);
    expect(screen.getByTestId("builder-status-drag").textContent).toBe("Rotate");
    expect(screen.getByTestId("builder-tool-hint").textContent).toContain("lock an axis");
    // 180 px at 0.5°/px: half a turn about the screen's up axis (y).
    act(() => handlers().dragMove(gesture(360, 0)));
    expect(screen.getByTestId("builder-status-drag").textContent).toBe("Rotate 180.0°");
    act(() => handlers().dragEnd());
    const shown = useBuilderStore.getState().result!.snapshot.positions;
    const c = [0, 0.586 * (2 / 3), 0];
    // Half a turn about y through the centre mirrors x and z around it.
    expect(shown[3]).toBeCloseTo(2 * c[0] - 0.757, 5);
    expect(shown[4]).toBeCloseTo(0.586, 5);
    expect(edits().length).toBeGreaterThan(1);
    act(() => useBuilderStore.getState().undo());
    expect(edits()).toEqual([]);

    // Esc mid-drag puts everything back and ends the drag.
    act(() => useBuilderStore.getState().setSelected([0, 1, 2]));
    expect(startDrag(0)).toBe(true);
    act(() => handlers().dragMove(gesture(10, 0)));
    expect(edits()).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(edits()).toEqual([]);
    expect(useBuilderStore.getState().drag).toBeNull();
    // The selection survives the cancelled drag (the Builder's Esc did not run).
    expect(useBuilderStore.getState().selected).toEqual([0, 1, 2]);
  });

  it("an axis key locks a drag, Snap rounds it, and tool keys wait for the drag to end", () => {
    render(<BuilderApp />);
    tool("move");
    fireEvent.click(screen.getByTestId("builder-snap"));
    expect(useBuilderStore.getState().snap).toBe(true);
    expect(startDrag(1)).toBe(true);
    fireEvent.keyDown(window, { key: "x" });
    expect(useBuilderStore.getState().drag?.axis).toBe("x");
    expect(screen.getByTestId("builder-status-drag").textContent).toBe("Move · locked to x · snap");
    // 12.7 px right and 30 px down: only the x part counts, snapped to 0.1 Å.
    act(() => handlers().dragMove(gesture(12.7, 30)));
    expect(edits()).toEqual([{ op: "move_atoms", atoms: [1], delta: [1.3, 0, 0] }]);
    expect(screen.getByTestId("builder-status-drag").textContent).toBe(
      "Move 1.30 Å along x · snap",
    );
    // A tool key would switch tools; during a drag it does nothing.
    fireEvent.keyDown(window, { key: "d" });
    expect(useBuilderStore.getState().tool).toBe("move");
    // Pressing the axis again frees it; "a" needs a cell, so it stays free.
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "a" });
    expect(useBuilderStore.getState().drag?.axis).toBeNull();
    act(() => handlers().dragMove(gesture(10, -10)));
    expect(edits()[0]).toEqual({ op: "move_atoms", atoms: [1], delta: [1, 1, 0] });
    act(() => handlers().dragEnd());
    fireEvent.keyDown(window, { key: "x" });
    expect(useBuilderStore.getState().drag).toBeNull();
  });

  it("marks atoms a drag brings too close and says so when it ends", () => {
    render(<BuilderApp />);
    tool("move");
    expect(startDrag(1)).toBe(true);
    // H1 onto H2 (1.514 Å to the left): not bonded, so a close contact.
    act(() => handlers().dragMove(gesture(-14.5, 0)));
    expect(useBuilderStore.getState().drag?.contacts).toEqual([1, 2]);
    expect(viewportProps.current?.warningIndices).toEqual([1, 2]);
    expect(screen.getByTestId("builder-status-drag").textContent).toContain("2 atoms too close");
    act(() => handlers().dragEnd());
    expect(viewportProps.current?.warningIndices).toBeNull();
    expect(useBuilderStore.getState().notice?.text).toContain("close contact");
  });

  it("box selection replaces, adds to or takes from the selection", () => {
    render(<BuilderApp />);
    const box = (indices: number[], mode: "replace" | "add" | "subtract") =>
      act(() => handlers().boxSelect(indices, mode));
    box([1, 2], "replace");
    expect(useBuilderStore.getState().selected).toEqual([1, 2]);
    box([2, 0], "add");
    expect(useBuilderStore.getState().selected).toEqual([1, 2, 0]);
    box([1], "subtract");
    expect(useBuilderStore.getState().selected).toEqual([2, 0]);
  });

  it("marks the atom under the pointer in the colour of what a click would do", () => {
    render(<BuilderApp />);
    const hover = (atomIndex: number | null) =>
      act(() =>
        (viewportProps.current?.onHover as (i: unknown) => void)(
          atomIndex === null ? null : { kind: "atom", atomIndex, position: [0, 0, 0] },
        ),
      );
    hover(1);
    expect(viewportProps.current?.hoverIndices).toEqual([1]);
    expect(viewportProps.current?.hoverColor).toBe(HOVER_COLORS.select);
    tool("delete");
    expect(viewportProps.current?.hoverColor).toBe(HOVER_COLORS.delete);
    hover(null);
    expect(viewportProps.current?.hoverIndices).toBeNull();
  });

  it("the Transform form moves and turns the selection by numbers, one step each", () => {
    render(<BuilderApp />);
    act(() => useBuilderStore.getState().setSelected([1, 2]));
    fireEvent.change(screen.getByTestId("builder-transform-dx"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("builder-transform-dz"), { target: { value: "-2" } });
    fireEvent.click(screen.getByTestId("builder-transform-move"));
    expect(edits()).toEqual([{ op: "move_atoms", atoms: [1, 2], delta: [1, 0, -2] }]);
    // Half a turn about z through the two hydrogens' centre swaps them.
    fireEvent.change(screen.getByTestId("builder-transform-angle"), { target: { value: "180" } });
    fireEvent.click(screen.getByTestId("builder-transform-rotate"));
    const p = useBuilderStore.getState().result!.snapshot.positions;
    expect(p[3]).toBeCloseTo(1 - 0.757, 4);
    expect(p[6]).toBeCloseTo(1 + 0.757, 4);
    expect(useBuilderStore.getState().edits).toHaveLength(3);
    // Without a cell only x, y and z are offered; a bad number is reported.
    const axes = [...screen.getByTestId("builder-transform-axis").querySelectorAll("option")];
    expect(axes.map((o) => o.textContent)).toEqual(["x", "y", "z"]);
    fireEvent.change(screen.getByTestId("builder-transform-dy"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("builder-transform-move"));
    expect(useBuilderStore.getState().notice?.level).toBe("error");
    fireEvent.change(screen.getByTestId("builder-transform-angle"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("builder-transform-rotate"));
    expect(useBuilderStore.getState().notice?.text).toContain("degrees");
    expect(useBuilderStore.getState().edits).toHaveLength(3);
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
    // Each step reads as what the user did, naming the atom.
    expect(screen.getByTestId("builder-op-list").textContent).toContain("Delete H #2");
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
    expect(startDrag(0)).toBe(false);
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
    // One label per atom left, each still its own atom's.
    expect(labels).toEqual(["HOH", "HOH"]);
    expect(useBuilderStore.getState().savedVersion).toBe(useBuilderStore.getState().docVersion);
    save("xyz");
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(2));
  });

  it("a download that fails says why and leaves the edits unsaved", async () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    exportSnapshot.mockRejectedValueOnce(new Error("blocked"));
    save("xyz");
    await waitFor(() =>
      expect(screen.getByTestId("builder-notice").textContent).toContain("Could not save: blocked"),
    );
    const s = useBuilderStore.getState();
    expect(s.savedVersion).not.toBe(s.docVersion);
  });

  it("saves the edited structure while the original is shown", async () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    act(() => useBuilderStore.getState().setShowOriginal(true));
    save("xyz");
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
    expect((exportSnapshot.mock.calls[0][0] as Snapshot).nAtoms).toBe(2);
  });

  it("New from the top bar replaces the document, once unsaved edits may go", async () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-cell-item"));
    fireEvent.change(screen.getByTestId("builder-new-cell-edge"), { target: { value: "15" } });
    // An unsaved edit: the app asks, and "Cancel" keeps the document and the form.
    fireEvent.click(screen.getByTestId("builder-new-cell"));
    expect(screen.getByTestId("builder-confirm").textContent).toContain(
      "Starting a new structure replaces the open structure (water.pdb)",
    );
    fireEvent.click(screen.getByTestId("builder-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("builder-confirm")).toBeNull());
    expect(useBuilderStore.getState().fileName).toBe("water.pdb");
    expect(edits()).toHaveLength(1);
    expect(screen.getByTestId("builder-new-dialog")).toBeTruthy();
    // "Discard edits" goes ahead.
    fireEvent.click(screen.getByTestId("builder-new-cell"));
    fireEvent.click(screen.getByTestId("builder-confirm-ok"));
    await waitFor(() => expect(useBuilderStore.getState().source!.box![0]).toBe(15));
    expect(edits()).toEqual([]);
    expect(shownAtoms()).toBe(0);
    expect(screen.queryByTestId("builder-new-dialog")).toBeNull();
  });

  it("a bulk crystal over unsaved edits asks first, and reports a refused spec after", async () => {
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-bulk-item"));
    fireEvent.change(screen.getByTestId("builder-bulk-a"), { target: { value: "-1" } });
    fireEvent.click(screen.getByTestId("builder-bulk-create"));
    fireEvent.click(screen.getByTestId("builder-confirm-ok"));
    await waitFor(() => expect(screen.getByTestId("builder-new-error")).toBeTruthy());
    expect(useBuilderStore.getState().fileName).toBe("water.pdb");
    fireEvent.change(screen.getByTestId("builder-bulk-a"), { target: { value: "3.61" } });
    fireEvent.click(screen.getByTestId("builder-bulk-create"));
    fireEvent.click(screen.getByTestId("builder-confirm-ok"));
    await waitFor(() => expect(useBuilderStore.getState().fileName).toBe("Cu-fcc"));
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
    // Every tool has settings now (Delete keeps hydrogens balanced): no hint.
    tool("delete");
    expect(screen.queryByTestId("builder-empty-hint")).toBeNull();
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

  it("Ctrl+O opens the file picker and Ctrl+S saves in the document's own format", async () => {
    render(<BuilderApp />);
    const input = screen.getByTestId("builder-open-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(click).toHaveBeenCalledTimes(1);
    // water.pdb saves as PDB, and the File menu puts the hint on that format.
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(1));
    expect(exportSnapshot.mock.calls[0][1]).toBe("pdb");
    fireEvent.click(screen.getByTestId("builder-file"));
    expect(screen.getByTestId("builder-save-pdb").textContent).toContain("Ctrl+S");
    expect(screen.getByTestId("builder-save-xyz").textContent).not.toContain("Ctrl+S");
    // A format Megane does not write falls back to XYZ.
    act(() => useBuilderStore.getState().openStructure(water(), null, "water.gro"));
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(exportSnapshot).toHaveBeenCalledTimes(2));
    expect(exportSnapshot.mock.calls[1][1]).toBe("xyz");
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
    // A second clean-up cannot start while the first runs.
    fireEvent.click(screen.getByTestId("builder-structure"));
    const again = screen.getByTestId("builder-structure-cleanup") as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect(again.title).toContain("already running");
  });
});

describe("BuilderApp — selecting and the atom menu", () => {
  beforeEach(() => {
    useBuilderStore.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "water.pdb");
  });

  it("a right-click on an atom opens its menu where the pointer was, and hides the tooltip", () => {
    render(<BuilderApp />);
    type RightClick = (i: number, x: number, y: number) => void;
    act(() => (viewportProps.current?.onAtomRightClick as RightClick)(1, 40, 50));
    const menu = screen.getByTestId("builder-atom-menu");
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("50px");
    fireEvent.click(screen.getByTestId("builder-atom-menu-molecule"));
    expect(useBuilderStore.getState().selected).toEqual([0, 1, 2]);
    expect(screen.queryByTestId("builder-atom-menu")).toBeNull();
  });

  it("the Menu key opens the selected atom's menu at the atom, or mid-view when it is off screen", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 10, top: 20, width: 200, height: 100 } as DOMRect);
    try {
      render(<BuilderApp />);
      act(() => useBuilderStore.getState().setSelected([1]));
      fireEvent.keyDown(window, { key: "F10", shiftKey: true });
      let menu = screen.getByTestId("builder-atom-menu");
      expect(menu.style.left).toBe("50px");
      expect(menu.style.top).toBe("70px");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByTestId("builder-atom-menu")).toBeNull();

      act(() => useBuilderStore.getState().setSelected([0]));
      fireEvent.keyDown(window, { key: "ContextMenu" });
      menu = screen.getByTestId("builder-atom-menu");
      expect(menu.style.left).toBe("110px");
      expect(menu.style.top).toBe("70px");
    } finally {
      rect.mockRestore();
    }
  });

  it("the atom menu does not open over a preview", () => {
    act(() => useBuilderStore.getState().setPreview({ op: "center", axes: [0], vacuum: 3 }));
    render(<BuilderApp />);
    type RightClick = (i: number, x: number, y: number) => void;
    act(() => (viewportProps.current?.onAtomRightClick as RightClick)(0, 1, 1));
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

describe("BuilderApp — unsaved edits", () => {
  const parsedWater = () => ({
    snapshot: water(),
    labels: null,
    frames: [],
    meta: null,
    vectorChannels: [],
    scalarChannels: [],
    warnings: [],
  });

  it("asks before File › Open replaces unsaved edits; Cancel keeps them", async () => {
    parseStructureFile.mockResolvedValue(parsedWater());
    useBuilderStore.getState().openStructure(water(), null, "mine.xyz");
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    fireEvent.change(screen.getByTestId("builder-open-input"), {
      target: { files: [new File(["x"], "other.pdb")] },
    });
    await waitFor(() =>
      expect(screen.getByTestId("builder-confirm").textContent).toContain(
        "Opening other.pdb replaces the open structure (mine.xyz) and its history of 1 edit",
      ),
    );
    fireEvent.click(screen.getByTestId("builder-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("builder-confirm")).toBeNull());
    expect(useBuilderStore.getState().fileName).toBe("mine.xyz");
    expect(edits()).toHaveLength(1);
  });

  it("warns before the page is left with unsaved edits, and autosaves them", () => {
    useBuilderStore.getState().openStructure(water(), null, "mine.xyz");
    const { unmount } = render(<BuilderApp />);
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(leave()).toBe(false);
    tool("delete");
    pick(2);
    expect(leave()).toBe(true);
    unmount();
    expect(readAutosave()?.fileName).toBe("mine.xyz");
    expect(leave()).toBe(false);
  });

  it("offers an autosave while nothing is open: Restore brings back the edits as Undo steps", () => {
    const old = createBuilderStore();
    old.getState().openStructure(water(), ["HOH", "HOH", "HOH"], "kept.pdb");
    old.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    old.getState().pushOps([
      { op: "move_atoms", atoms: [0], delta: [1, 0, 0] },
      { op: "move_atoms", atoms: [1], delta: [1, 0, 0] },
    ]);
    writeAutosave(old.getState());
    render(<BuilderApp />);
    expect(screen.getByTestId("builder-restore-text").textContent).toContain(
      "Unsaved edits to kept.pdb from today at",
    );
    fireEvent.click(screen.getByTestId("builder-restore-ok"));
    expect(screen.queryByTestId("builder-restore")).toBeNull();
    expect(useBuilderStore.getState().fileName).toBe("kept.pdb");
    expect(screen.getByTestId("builder-op-count").textContent).toBe("2 edits");
    expect(screen.getByTestId("builder-notice").textContent).toContain(
      "Restored kept.pdb with 2 unsaved edits.",
    );
    fireEvent.click(screen.getByTestId("builder-topbar-undo"));
    expect(edits()).toHaveLength(1);
  });

  it("Discard drops the autosave; opening something else hides the offer", () => {
    const old = createBuilderStore();
    old.getState().openStructure(water(), null, null as unknown as string);
    old.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    writeAutosave(old.getState());
    const { unmount } = render(<BuilderApp />);
    expect(screen.getByTestId("builder-restore-text").textContent).toContain(
      "an untitled structure",
    );
    fireEvent.click(screen.getByTestId("builder-restore-discard"));
    expect(screen.queryByTestId("builder-restore")).toBeNull();
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
    unmount();

    writeAutosave(old.getState());
    render(<BuilderApp />);
    expect(screen.getByTestId("builder-restore")).toBeTruthy();
    act(() => useBuilderStore.getState().newCell(10));
    expect(screen.queryByTestId("builder-restore")).toBeNull();
  });

  it("an open document is not covered by an autosave offer", () => {
    const old = createBuilderStore();
    old.getState().openStructure(water(), null, "kept.pdb");
    old.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    writeAutosave(old.getState());
    useBuilderStore.getState().openStructure(water(), null, "open.pdb");
    render(<BuilderApp />);
    expect(screen.queryByTestId("builder-restore")).toBeNull();
  });
});

describe("BuilderApp — notices, drops and the File menu", () => {
  afterEach(() => vi.useRealTimers());

  it("an info notice goes after a while; an error stays", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    render(<BuilderApp />);
    act(() => useBuilderStore.getState().reportInfo("first"));
    act(() => vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1000));
    // A new notice restarts the clock.
    act(() => useBuilderStore.getState().reportInfo("second"));
    act(() => vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1000));
    expect(screen.getByTestId("builder-notice").textContent).toContain("second");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByTestId("builder-notice")).toBeNull();
    act(() => useBuilderStore.getState().reportError("broken"));
    act(() => vi.advanceTimersByTime(NOTICE_TIMEOUT_MS * 2));
    expect(screen.getByTestId("builder-notice").textContent).toContain("broken");
  });

  it("opens the first of several dropped files; a flow file asks for Flow mode", async () => {
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
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(["x"], "flow.megane-flow.json")] },
    });
    expect(useBuilderStore.getState().notice?.text).toBe(
      "Switch to Flow mode to open the flow file flow.megane-flow.json.",
    );
    expect(parseStructureFile).not.toHaveBeenCalled();
    fireEvent.drop(zone, {
      dataTransfer: { files: [new File(["x"], "a.xyz"), new File(["y"], "b.xyz")] },
    });
    await waitFor(() => expect(useBuilderStore.getState().fileName).toBe("a.xyz"));
    expect(parseStructureFile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("builder-notice").textContent).toContain("1 other file was ignored");
  });

  it("File › Insert molecule from library… picks Place and opens its gallery", () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-new-cell-item"));
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-file-library"));
    expect(useBuilderStore.getState().tool).toBe("place");
    expect(useLibraryUi.getState().galleryOpen).toBe(true);
    expect(screen.queryByTestId("builder-new-dialog")).toBeNull();
    expect(screen.getByTestId("builder-library")).toBeTruthy();
  });

  it('"?" and File › Keyboard shortcuts… list the shortcuts; Escape closes the list', () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    render(<BuilderApp />);
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    const card = screen.getByTestId("builder-shortcuts");
    expect(screen.getByTestId("builder-shortcuts-tools").textContent).toContain("Delete tool");
    expect(screen.getByTestId("builder-shortcuts-general").textContent).toContain("+S");
    expect(screen.getByTestId("builder-shortcuts-drag").textContent).toContain("Shift+Drag");
    expect(card).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-shortcuts")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-file"));
    fireEvent.click(screen.getByTestId("builder-shortcuts-item"));
    expect(screen.getByTestId("builder-shortcuts")).toBeTruthy();
    fireEvent.click(screen.getByTestId("builder-shortcuts-close"));
    expect(screen.queryByTestId("builder-shortcuts")).toBeNull();
    // A Python tool's form takes its place.
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    act(() =>
      useToolsStore.setState({
        openTool: { name: "t", description: "", inputSchema: {} } as unknown as BuilderToolInfo,
      }),
    );
    expect(screen.queryByTestId("builder-shortcuts")).toBeNull();
    act(() => useToolsStore.setState({ openTool: null }));
  });

  it("pauses the rail's Undo and Redo while a preview is open, saying why", () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    render(<BuilderApp />);
    tool("delete");
    pick(2);
    const undo = screen.getByTestId("builder-topbar-undo") as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    act(() => useBuilderStore.getState().setPreview({ op: "wrap" }));
    expect(undo.disabled).toBe(true);
    expect(undo.title).toContain("preview");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(edits()).toHaveLength(1);
    expect(screen.getByTestId("builder-notice").textContent).toContain("preview");
  });

  it("shows a loading line while the Flow editor loads", () => {
    render(<BuilderApp />);
    fireEvent.click(screen.getByTestId("builder-mode-flow"));
    expect(screen.getByTestId("builder-flow-loading").textContent).toBe("Loading Flow editor…");
    fireEvent.click(screen.getByTestId("builder-mode-manual"));
    expect(screen.queryByTestId("builder-flow-loading")).toBeNull();
  });
});

describe("BuilderApp helpers", () => {
  it("formatUnavailable explains a format that needs a cell", () => {
    expect(formatUnavailable({ label: "CIF", needsCell: true }, false)).toBe(
      "CIF needs a unit cell, and this structure has none",
    );
    expect(formatUnavailable({ label: "CIF", needsCell: true }, true)).toBeNull();
    expect(formatUnavailable({ label: "XYZ" }, false)).toBeNull();
  });

  it("isFlowFile knows a flow graph by its extension", () => {
    expect(isFlowFile({ name: "a.megane-flow.json" })).toBe(true);
    expect(isFlowFile({ name: "A.JSON" })).toBe(true);
    expect(isFlowFile({ name: "a.pdb" })).toBe(false);
  });
});
