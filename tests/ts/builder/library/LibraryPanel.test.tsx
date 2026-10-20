/**
 * The molecule library as the Place tool's gallery (presets and user
 * molecules, Place / Add, Edit / remove), the shared host that owns the one
 * sketch dialog and file input, and the library actions (import, save a
 * selection) the Inspector reuses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import type { Snapshot } from "@/types";

const { parseStructureFile, sketchModalProps } = vi.hoisted(() => ({
  parseStructureFile: vi.fn(),
  sketchModalProps: { current: null as Record<string, unknown> | null },
}));
vi.mock("@/parsers/structure", () => ({ parseStructureFile, parseStructureText: vi.fn() }));
vi.mock("@/builder/library/SketchModal", () => ({
  SketchModal: (props: Record<string, unknown>) => {
    sketchModalProps.current = props;
    return <div data-testid="sketch-modal-stub" />;
  },
}));

import { LibraryHost, LibraryPanel } from "@/builder/library/LibraryPanel";
import { useLibraryActions, useLibraryUi } from "@/builder/library/ui";
import { useBuilderStore } from "@/builder/store";
import {
  LIBRARY_STORAGE_KEY,
  PERSIST_FAILED_NOTICE,
  useLibraryStore,
} from "@/builder/library/store";
import { uniqueName } from "@/builder/library/ui";
import { STRUCTURE_ACCEPT } from "@/parsers/fileNames";
import { PRESET_MOLECULES } from "@/builder/library/presets";

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

const item = (id: string) => screen.getByTestId(`builder-library-item-${id}`);
const button = (id: string, name: string) =>
  within(item(id)).getByTestId(`builder-library-${name}`);
const shown = () => useBuilderStore.getState().result!.snapshot;

beforeEach(() => {
  localStorage.clear();
  useLibraryStore.setState({ user: [], persistFailed: false, persistNoticeShown: false });
  useBuilderStore.getState().resolveConfirm(false);
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
    notice: null,
  });
  parseStructureFile.mockReset();
  sketchModalProps.current = null;
  useLibraryUi.setState({ sketch: null, galleryOpen: false });
});
afterEach(() => cleanup());

const useLibraryActionsRef: { current: ReturnType<typeof useLibraryActions> | null } = {
  current: null,
};

/** The gallery with the host beside it, and a button for the Inspector's Save as fragment. */
function Library({ onClose = () => {} }: { onClose?: () => void }) {
  const actions = useLibraryActions();
  useLibraryActionsRef.current = actions;
  const { saveSelection } = actions;
  return (
    <>
      <LibraryPanel onClose={onClose} />
      <LibraryHost />
      <button data-testid="builder-library-save-selection" onClick={saveSelection} />
    </>
  );
}

describe("LibraryPanel", () => {
  it("lists the presets, starts a document on Add with nothing open, and closes", () => {
    const onClose = vi.fn();
    render(<Library onClose={onClose} />);
    fireEvent.click(screen.getByTestId("builder-library-close"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId("builder-library-count").textContent).toBe(
      `${PRESET_MOLECULES.length} molecules`,
    );
    expect(item("preset:water").textContent).toContain("H2O");
    expect(within(item("preset:water")).queryByTestId("builder-library-remove")).toBeNull();
    fireEvent.click(button("preset:water", "add"));
    expect(useBuilderStore.getState().fileName).toBe("untitled");
    expect(shown().nAtoms).toBe(3);
  });

  it("Add is off while the original structure is shown", () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    useBuilderStore.getState().pushOp({ op: "wrap" });
    useBuilderStore.getState().setShowOriginal(true);
    render(<Library />);
    expect((button("preset:water", "add") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Add drops the molecule beside the structure and selects it", () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    render(<Library />);
    fireEvent.click(button("preset:methane", "add"));
    expect(shown().nAtoms).toBe(8);
    expect(useBuilderStore.getState().selected).toEqual([3, 4, 5, 6, 7]);
    // Beside: every methane atom sits past the water's max x plus the margin.
    for (let i = 3; i < 8; i++) expect(shown().positions[i * 3]).toBeGreaterThan(0.757 + 2 - 1e-6);
    // Adding again lands past the methane.
    fireEvent.click(button("preset:water", "add"));
    expect(shown().nAtoms).toBe(11);
    expect(shown().positions[8 * 3]).toBeGreaterThan(shown().positions[3 * 3]);
    // Not while the original is previewed.
    act(() => useBuilderStore.getState().setShowOriginal(true));
    fireEvent.click(button("preset:water", "add"));
    expect(useBuilderStore.getState().edits).toHaveLength(2);
  });

  it("Place toggles the place source and highlights the row", () => {
    render(<Library />);
    fireEvent.click(button("preset:benzene", "place"));
    expect(useBuilderStore.getState().tool).toBe("place");
    expect(useBuilderStore.getState().placeSource?.id).toBe("preset:benzene");
    expect(item("preset:benzene").getAttribute("data-placing")).toBe("true");
    fireEvent.click(button("preset:water", "place"));
    expect(useBuilderStore.getState().placeSource?.id).toBe("preset:water");
    expect(item("preset:benzene").getAttribute("data-placing")).toBeNull();
    fireEvent.click(button("preset:water", "place"));
    expect(useBuilderStore.getState().placeSource).toBeNull();
    expect(useBuilderStore.getState().tool).toBe("select");
  });

  it("imports a file into the user library, persists it, and can remove it", async () => {
    parseStructureFile.mockResolvedValue({
      snapshot: water(),
      labels: null,
      frames: [],
      meta: null,
      vectorChannels: [],
      scalarChannels: [],
      warnings: [],
    });
    render(<Library />);
    const input = screen.getByTestId("builder-library-import-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("builder-library-import"));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(["x"], "solvent.pdb")] } });
    await waitFor(() => expect(useBuilderStore.getState().notice).toBeTruthy());
    expect(useBuilderStore.getState().notice).toEqual({
      level: "info",
      text: "Added solvent to the library.",
    });
    const user = useLibraryStore.getState().user;
    expect(user).toHaveLength(1);
    expect(user[0].name).toBe("solvent");
    expect(user[0].formula).toBe("H2O");
    expect(JSON.parse(localStorage.getItem(LIBRARY_STORAGE_KEY)!)).toHaveLength(1);
    expect(screen.getByTestId("builder-library-count").textContent).toBe(
      `${PRESET_MOLECULES.length + 1} molecules`,
    );
    // Choose it for placing, then remove it: the place source is cleared too.
    fireEvent.click(button(user[0].id, "place"));
    expect(useBuilderStore.getState().placeSource?.id).toBe(user[0].id);
    expect(within(item(user[0].id)).queryByTestId("builder-library-edit")).toBeNull();
    // Remove asks first: No keeps it, Yes removes it.
    fireEvent.click(button(user[0].id, "remove"));
    expect(useBuilderStore.getState().confirm?.confirmLabel).toBe("Remove");
    await act(async () => useBuilderStore.getState().resolveConfirm(false));
    expect(useLibraryStore.getState().user).toHaveLength(1);
    fireEvent.click(button(user[0].id, "remove"));
    await act(async () => useBuilderStore.getState().resolveConfirm(true));
    expect(useLibraryStore.getState().user).toEqual([]);
    expect(useBuilderStore.getState().placeSource).toBeNull();
    // A file that does not parse is reported.
    parseStructureFile.mockRejectedValue(new Error("no atoms"));
    fireEvent.change(input, { target: { files: [new File(["x"], "bad.pdb")] } });
    await waitFor(() => expect(useBuilderStore.getState().notice?.level).toBe("error"));
    expect(useBuilderStore.getState().notice?.text).toContain("bad.pdb");
    // An empty change is ignored.
    fireEvent.change(input, { target: { files: [] } });
    expect(parseStructureFile).toHaveBeenCalledTimes(2);
  });

  it("saves the selection as a molecule", () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    render(<Library />);
    fireEvent.click(screen.getByTestId("builder-library-save-selection"));
    expect(useLibraryStore.getState().user).toEqual([]);
    act(() => useBuilderStore.getState().setSelected([0, 1]));
    fireEvent.click(screen.getByTestId("builder-library-save-selection"));
    const saved = useLibraryStore.getState().user[0];
    expect(saved.origin).toBe("selection");
    expect(saved.elements).toEqual([8, 1]);
    expect(saved.bonds).toEqual([[0, 1]]);
    expect(saved.formula).toBe("HO");
    // Named after the formula, and kept apart from a name already in the library.
    expect(saved.name).toBe("HO");
    fireEvent.click(screen.getByTestId("builder-library-save-selection"));
    expect(useLibraryStore.getState().user[1].name).toBe("HO (2)");
  });

  it("uniqueName numbers a name that is taken", () => {
    expect(uniqueName("Water", [])).toBe("Water");
    expect(uniqueName("Water", ["Water", "Water (2)"])).toBe("Water (3)");
  });

  it("the file input accepts structure files; a disabled Add says why", () => {
    useBuilderStore.getState().openStructure(water(), null, "w.xyz");
    useBuilderStore.getState().pushOp({ op: "wrap" });
    render(<Library />);
    expect(screen.getByTestId("builder-library-import-input").getAttribute("accept")).toBe(
      STRUCTURE_ACCEPT,
    );
    expect(button("preset:water", "add").getAttribute("title")).toContain("Add to the document");
    act(() => useBuilderStore.getState().setShowOriginal(true));
    expect(button("preset:water", "add").getAttribute("title")).toContain("original structure");
    act(() => {
      useBuilderStore.getState().setShowOriginal(false);
      useBuilderStore.getState().setPreview({ op: "wrap" });
    });
    expect(button("preset:water", "add").getAttribute("title")).toBe(
      "Add to the document now (inside the cell when there is room)",
    );
  });

  it("Add puts the molecule in the emptiest part of the cell and says where", () => {
    const cell = new Float32Array([12, 0, 0, 0, 12, 0, 0, 0, 12]);
    useBuilderStore.getState().openStructure({ ...water(), box: cell }, null, "w.xyz");
    render(<Library />);
    fireEvent.click(button("preset:methane", "add"));
    expect(shown().nAtoms).toBe(8);
    const notice = useBuilderStore.getState().notice!;
    expect(notice.level).toBe("info");
    expect(notice.text).toMatch(/^Added Methane in the emptiest part of the cell, at \(/);
    // Inside the cell, away from the water at the corner.
    const op = useBuilderStore.getState().edits[0] as { translate: number[] };
    for (const v of op.translate) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(12);
    }
    // Without a cell it goes beside the structure, and says so.
    act(() => useBuilderStore.getState().openStructure(water(), null, "w.xyz"));
    fireEvent.click(button("preset:methane", "add"));
    expect(useBuilderStore.getState().notice!.text).toMatch(/beside the structure/);
  });

  it("renames a user molecule in place: Enter keeps it, Escape does not", () => {
    const m = useLibraryStore.getState().addMolecule({
      name: "Old",
      formula: "C",
      origin: "file",
      elements: [6],
      positions: [0, 0, 0],
      bonds: [],
    });
    act(() => useBuilderStore.getState().setPlaceSource(m));
    render(<Library />);
    expect(within(item("preset:water")).queryByTestId("builder-library-rename")).toBeNull();
    fireEvent.click(button(m.id, "rename"));
    const input = screen.getByTestId("builder-library-rename-input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "  New  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useLibraryStore.getState().user[0].name).toBe("New");
    expect(useBuilderStore.getState().placeSource?.name).toBe("New");
    // Escape cancels (and leaves the gallery open); blank names are ignored.
    fireEvent.doubleClick(within(item(m.id)).getByTestId("builder-library-item-name"));
    fireEvent.change(screen.getByTestId("builder-library-rename-input"), {
      target: { value: "Other" },
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("builder-library-rename-input")).toBeNull();
    expect(useLibraryStore.getState().user[0].name).toBe("New");
    fireEvent.click(button(m.id, "rename"));
    fireEvent.change(screen.getByTestId("builder-library-rename-input"), {
      target: { value: "   " },
    });
    fireEvent.blur(screen.getByTestId("builder-library-rename-input"));
    expect(useLibraryStore.getState().user[0].name).toBe("New");
  });

  it("says once when the library cannot be saved", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    // The page-wide store writes to localStorage; simulate its first failure.
    useLibraryStore.setState({ persistFailed: true });
    render(<Library />);
    act(() => {
      useLibraryActionsRef.current!.keep({
        name: "A",
        formula: "C",
        origin: "file",
        elements: [6],
        positions: [0, 0, 0],
        bonds: [],
      });
    });
    expect(useBuilderStore.getState().notice?.text).toBe(
      `Added A to the library. ${PERSIST_FAILED_NOTICE}`,
    );
    act(() => {
      useLibraryActionsRef.current!.keep({
        name: "B",
        formula: "C",
        origin: "file",
        elements: [6],
        positions: [0, 0, 0],
        bonds: [],
      });
    });
    expect(useBuilderStore.getState().notice?.text).toBe("Added B to the library.");
    setItem.mockRestore();
  });

  it("a rename that cannot be saved says so once", () => {
    const m = useLibraryStore.getState().addMolecule({
      name: "Old",
      formula: "C",
      origin: "file",
      elements: [6],
      positions: [0, 0, 0],
      bonds: [],
    });
    useLibraryStore.setState({ persistFailed: true });
    render(<Library />);
    fireEvent.click(button(m.id, "rename"));
    const input = screen.getByTestId("builder-library-rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useBuilderStore.getState().notice?.text).toBe(PERSIST_FAILED_NOTICE);
  });

  it("Sketch… opens the dialog; Add keeps the result; Edit reopens a sketch", () => {
    render(<Library />);
    expect(screen.queryByTestId("sketch-modal-stub")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-library-sketch"));
    expect(screen.getByTestId("sketch-modal-stub")).toBeTruthy();
    expect(sketchModalProps.current?.initialMolfile).toBeUndefined();
    act(() => (sketchModalProps.current!.onClose as () => void)());
    expect(screen.queryByTestId("sketch-modal-stub")).toBeNull();
    fireEvent.click(screen.getByTestId("builder-library-sketch"));
    act(() =>
      (sketchModalProps.current!.onAdd as (d: unknown) => void)({
        name: "Sketched",
        formula: "C",
        origin: "sketch",
        elements: [6],
        positions: [0, 0, 0],
        bonds: [],
        molfile: "MOL",
        planar: true,
      }),
    );
    expect(screen.queryByTestId("sketch-modal-stub")).toBeNull();
    const user = useLibraryStore.getState().user;
    expect(user[0].name).toBe("Sketched");
    expect(item(user[0].id).textContent).toContain("flat");
    fireEvent.click(button(user[0].id, "edit"));
    expect(sketchModalProps.current?.initialMolfile).toBe("MOL");
    expect(sketchModalProps.current?.initialName).toBe("Sketched");
    // Editing can save over the molecule: same id, new content, the Place tool follows.
    act(() => useBuilderStore.getState().setPlaceSource(useLibraryStore.getState().user[0]));
    act(() =>
      (sketchModalProps.current!.onSave as (d: unknown) => void)({
        name: "Sketched v2",
        formula: "CO",
        origin: "sketch",
        elements: [6, 8],
        positions: [0, 0, 0, 1.2, 0, 0],
        bonds: [[0, 1]],
        molfile: "MOL2",
      }),
    );
    expect(screen.queryByTestId("sketch-modal-stub")).toBeNull();
    const after = useLibraryStore.getState().user;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: user[0].id, name: "Sketched v2", formula: "CO" });
    expect(useBuilderStore.getState().placeSource?.name).toBe("Sketched v2");
    expect(useBuilderStore.getState().notice?.text).toBe("Updated Sketched v2 in the library.");
    // A new sketch has no Save changes.
    fireEvent.click(screen.getByTestId("builder-library-sketch"));
    expect(sketchModalProps.current?.onSave).toBeUndefined();
  });

  it("saving over a molecule that is gone is reported", () => {
    const m = useLibraryStore.getState().addMolecule({
      name: "Gone",
      formula: "C",
      origin: "sketch",
      elements: [6],
      positions: [0, 0, 0],
      bonds: [],
      molfile: "MOL",
    });
    render(<Library />);
    fireEvent.click(button(m.id, "edit"));
    act(() => useLibraryStore.getState().removeMolecule(m.id));
    act(() =>
      (sketchModalProps.current!.onSave as (d: unknown) => void)({
        name: "X",
        formula: "C",
        origin: "sketch",
        elements: [6],
        positions: [0, 0, 0],
        bonds: [],
      }),
    );
    expect(useBuilderStore.getState().notice).toEqual({
      level: "error",
      text: "That molecule is no longer in the library.",
    });
  });
});
