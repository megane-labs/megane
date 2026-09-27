/**
 * The molecule library as the Place tool's gallery (presets and user
 * molecules, Place / Add, Edit / remove), the shared host that owns the one
 * sketch dialog and file input, and the library actions (import, save a
 * selection) the Insert menu and the Inspector reuse.
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
import { LIBRARY_STORAGE_KEY, useLibraryStore } from "@/builder/library/store";
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
  useLibraryStore.setState({ user: [] });
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

/** The gallery with the host beside it, and a button for the Inspector's Save as fragment. */
function Library({ onClose = () => {} }: { onClose?: () => void }) {
  const { saveSelection } = useLibraryActions();
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
    fireEvent.click(button(user[0].id, "remove"));
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
  });
});
