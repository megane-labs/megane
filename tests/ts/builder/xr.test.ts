/**
 * megane Builder in a headset (`builder/xr.ts`): what the immersive panel
 * shows for each tool and state, and what its buttons and the hands' presses
 * do to a real document through the handlers the app installs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as THREE from "three";
import type { StoreApi } from "zustand";

const { runCleanup } = vi.hoisted(() => ({ runCleanup: vi.fn(async () => {}) }));
vi.mock("@/builder/cleanup", async () => {
  const actual = await vi.importActual<typeof import("@/builder/cleanup")>("@/builder/cleanup");
  return { ...actual, runCleanup };
});

import {
  builderXRPanel,
  createBuilderXREdit,
  elementSwatch,
  periodicTableRows,
  XR_LIBRARY_PAGE_SIZE,
  type BuilderXRContext,
  type BuilderXRLocal,
} from "@/builder/xr";
import { createBuilderStore, editSteps, type BuilderStore } from "@/builder/store";
import { useBuilderHandlers } from "@/builder/useBuilderHandlers";
import { HOVER_COLORS } from "@/builder/hover";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import { DEFAULT_ADSORB_HEIGHT } from "@/builder/library/ui";
import type { XREditButton, XREditPanel } from "@/renderer/xr/XRPanel";
import type { Snapshot } from "@/types";

/** Ethane with explicit hydrogens: C0–C1, H 2–4 on C0, H 5–7 on C1. */
function ethane(): Snapshot {
  return {
    nAtoms: 8,
    nBonds: 7,
    nFileBonds: 7,
    positions: new Float32Array([
      0, 0, 0, 1.54, 0, 0, -0.36, 1.03, 0, -0.36, -0.51, 0.89, -0.36, -0.51, -0.89, 1.9, -1.03, 0,
      1.9, 0.51, 0.89, 1.9, 0.51, -0.89,
    ]),
    elements: new Uint8Array([6, 6, 1, 1, 1, 1, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4, 1, 5, 1, 6, 1, 7]),
    bondOrders: null,
    box: null,
    boxOrigin: null,
    atomChainIds: null,
    atomBFactors: null,
  };
}

/** Two waters, not bonded to each other: O0 H1 H2, O3 H4 H5. */
function waters(): Snapshot {
  return {
    ...ethane(),
    nAtoms: 6,
    nBonds: 4,
    nFileBonds: 4,
    positions: new Float32Array([
      0, 0, 0, 0.96, 0, 0, -0.24, 0.93, 0, 5, 0, 0, 5.96, 0, 0, 4.76, 0.93, 0,
    ]),
    elements: new Uint8Array([8, 1, 1, 8, 1, 1]),
    bonds: new Uint32Array([0, 1, 0, 2, 3, 4, 3, 5]),
  };
}

let api: StoreApi<BuilderStore>;
const s = () => api.getState();
const main = (): BuilderXRLocal => ({ page: "main", libraryPage: 0, unbond: false });
const ctx: BuilderXRContext = { molecules: PRESET_MOLECULES, canSave: true, cleaning: false };
const panel = (local = main(), c = ctx) => builderXRPanel(s(), local, c);
const ids = (row: XREditButton[]) => row.filter((b) => !b.spacer).map((b) => b.id);
const button = (p: XREditPanel, id: string) =>
  [...p.rows.flat(), ...p.actions].find((b) => b.id === id)!;

beforeEach(() => {
  api = createBuilderStore();
  runCleanup.mockClear();
});

describe("builderXRPanel", () => {
  it("offers the tools and says what to do with nothing open", () => {
    const p = panel();
    expect(ids(p.rows[0])).toEqual([
      "tool:select",
      "tool:move",
      "tool:add",
      "tool:bond",
      "tool:element",
      "tool:delete",
      "tool:place",
    ]);
    expect(button(p, "tool:select").active).toBe(true);
    expect(p.title).toBe("Select");
    expect(p.summary).toBe("Nothing open");
    expect(p.detail).toContain("Open a structure on the page");
    expect(p.detailLevel).toBe("hint");
    for (const id of ["undo", "redo", "delete", "cleanup", "original", "save"]) {
      expect(button(p, id).enabled).toBe(false);
    }
    // Place works with nothing open: it asks for a molecule.
    s().setTool("place");
    expect(panel().detail).toBe("Choose a molecule below.");
  });

  it("shows Add atom's element, bond order and hydrogens", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    s().setTool("add");
    let p = panel();
    expect(p.title).toBe("Add atom · C · single");
    expect(p.summary).toBe("8 atoms");
    const elements = p.rows[1];
    expect(elements[0]).toMatchObject({ id: "element:6", label: "C", active: true });
    expect(elements[0].swatch).toBe(elementSwatch(6));
    expect(elements[elements.length - 1].id).toBe("page:table");
    expect(ids(p.rows[2])).toEqual([
      "order:1",
      "order:2",
      "order:3",
      "order:4",
      "hydrogens:auto",
      "hydrogens:on",
      "hydrogens:off",
    ]);
    expect(button(p, "order:1").active).toBe(true);
    expect(button(p, "hydrogens:auto").active).toBe(true);
    // An element off the quick row gets a button of its own.
    s().setElement(26);
    p = panel();
    expect(button(p, "element:26")).toMatchObject({ label: "Fe", active: true });
    expect(button(p, "element:6").active).toBe(false);
  });

  it("shows the Element, Bond and Delete tools' settings, keeping three rows", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    s().setTool("element");
    s().setElement(7);
    let p = panel();
    expect(p.title).toBe("Element · N");
    expect(ids(p.rows[2])).toEqual(["hydrogens:auto", "hydrogens:on", "hydrogens:off"]);
    s().setTool("bond");
    p = panel();
    expect(p.title).toBe("Bond · single");
    expect(ids(p.rows[1])).toEqual(["order:1", "order:2", "order:3", "order:4", "unbond"]);
    expect(p.detail).toContain("Pinch two atoms to bond them");
    s().setPendingBondAtom(0);
    expect(panel().detail).toBe("Now pinch the atom to bond to C #0; empty space lets go.");
    const unbond = { ...main(), unbond: true };
    p = panel(unbond);
    expect(p.title).toBe("Bond · remove");
    expect(button(p, "unbond").active).toBe(true);
    expect(button(p, "order:1").active).toBe(false);
    expect(p.detail).toContain("unbond from C #0");
    s().setPendingBondAtom(null);
    expect(panel(unbond).detail).toBe("Pinch two atoms to remove the bond between them.");
    s().setTool("delete");
    p = panel();
    expect(p.rows).toHaveLength(3);
    expect(ids(p.rows[1])).toEqual(["hydrogens:auto", "hydrogens:on", "hydrogens:off"]);
    expect(p.rows[2]).toEqual([]);
  });

  it("enables the selection commands once something is selected", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    for (const tool of ["select", "move"] as const) {
      s().setTool(tool);
      let p = panel();
      expect(button(p, "select:all").enabled).toBe(true);
      expect(button(p, "select:clear").enabled).toBe(false);
      expect(button(p, "select:molecule").enabled).toBe(false);
      s().setSelected([2, 3]);
      s().setSnap(true);
      p = panel();
      expect(button(p, "select:clear").enabled).toBe(true);
      expect(button(p, "select:element").enabled).toBe(true);
      expect(button(p, "snap").active).toBe(true);
      expect(button(p, "delete").enabled).toBe(true);
      expect(p.summary).toBe("8 atoms · 2 selected");
      s().clearSelected();
    }
  });

  it("pages through the library for Place, with On atoms", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    s().setPlaceSource(PRESET_MOLECULES[1]);
    let p = panel();
    expect(p.title).toBe(`Place · ${PRESET_MOLECULES[1].name}`);
    const first = ids(p.rows[1]);
    expect(first[0]).toBe("library:prev");
    expect(first.slice(1, -1)).toEqual(
      PRESET_MOLECULES.slice(0, XR_LIBRARY_PAGE_SIZE).map((m) => `place:${m.id}`),
    );
    expect(button(p, `place:${PRESET_MOLECULES[1].id}`).active).toBe(true);
    expect(button(p, "library:prev").enabled).toBe(false);
    expect(button(p, "library:next").enabled).toBe(true);
    expect(button(p, "adsorb")).toMatchObject({ label: "On atoms: off", active: false });
    expect(p.detail).toBe("Pinch empty space to drop the molecule at the ray's end.");
    // The last page is short: a spacer keeps the arrows where they were.
    const pages = Math.ceil(PRESET_MOLECULES.length / XR_LIBRARY_PAGE_SIZE);
    p = panel({ ...main(), libraryPage: 99 });
    expect(button(p, "library:next").enabled).toBe(false);
    if (PRESET_MOLECULES.length % XR_LIBRARY_PAGE_SIZE !== 0) {
      expect(p.rows[1].some((b) => b.spacer)).toBe(true);
    }
    expect(pages).toBeGreaterThan(1);
    s().setAdsorbHeight(2.5);
    p = panel();
    expect(button(p, "adsorb")).toMatchObject({ label: "On atoms: 2.5 Å", active: true });
    expect(p.detail).toContain("or an atom to put it on top");
    // No molecule at all: one page, nothing to page to.
    p = panel(main(), { ...ctx, molecules: [] });
    expect(ids(p.rows[1])).toEqual(["library:prev", "library:next"]);
  });

  it("puts the notice, a drag's readout, or why editing waits on the second line", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    s().reportError("Something failed");
    expect(panel()).toMatchObject({ detail: "Something failed", detailLevel: "error" });
    s().setNotice(null);
    s().setDrag({ mode: "translate", axis: null, readout: null, contacts: [] });
    expect(panel()).toMatchObject({ detail: "Move", detailLevel: "info" });
    s().setSnap(true);
    s().setDrag({
      mode: "translate",
      axis: null,
      readout: { kind: "move", value: 1, delta: [1, 0, 0], axis: null, turn: 0 },
      contacts: [3, 4],
    });
    expect(panel().detail).toBe("Move 1.00 Å (1.00, 0.00, 0.00) · snap · 2 atoms too close");
    s().setDrag(null);
    s().setPreview({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    expect(panel().detail).toContain("A preview is open on the page");
    s().setPreview(null);
    s().pushOp({ op: "move_atoms", atoms: [0], delta: [1, 0, 0] });
    s().setShowOriginal(true);
    const p = panel();
    expect(p.detail).toContain("Showing the original");
    expect(button(p, "original")).toMatchObject({ active: true, enabled: true });
    expect(p.summary).toBe("8 atoms · unsaved");
  });

  it("says when a Clean up runs, and leaves Save out where the page cannot save", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    let p = panel(main(), { ...ctx, cleaning: true });
    expect(button(p, "cleanup")).toMatchObject({ label: "Cleaning…", enabled: false });
    p = panel(main(), { ...ctx, canSave: false });
    expect(p.actions.map((b) => b.id)).not.toContain("save");
    expect(button(p, "cleanup").enabled).toBe(true);
  });

  it("shows the periodic table on its own page", () => {
    s().setElement(8);
    const p = panel({ ...main(), page: "table" });
    expect(p.title).toBe("Choose an element");
    expect(p.summary).toBe("Now: O");
    expect(p.rows).toHaveLength(9);
    expect(p.actions[0]).toMatchObject({ id: "page:main", label: "Back" });
    for (const row of p.rows) expect(row).toHaveLength(18);
    expect(p.rows[0][0].label).toBe("H");
    expect(p.rows[0][17].label).toBe("He");
    expect(p.rows[0][1].spacer).toBe(true);
    expect(button(p, "element:8").active).toBe(true);
    // The lanthanides start the first f-block row, under the third column.
    expect(p.rows[7][2].label).toBe("La");
  });
});

describe("periodicTableRows and elementSwatch", () => {
  it("lays out as many periods as the elements need", () => {
    const rows = periodicTableRows(1, 10);
    expect(rows).toHaveLength(2);
    expect(rows[1].filter((b) => !b.spacer).map((b) => b.label)).toEqual([
      "Li",
      "Be",
      "B",
      "C",
      "N",
      "O",
      "F",
      "Ne",
    ]);
    expect(rows[0][0].active).toBe(true);
  });

  it("is the colour the view draws the element in", () => {
    expect(elementSwatch(1)).toBe("rgb(255, 255, 255)");
    expect(elementSwatch(8)).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});

describe("createBuilderXREdit", () => {
  const save = vi.fn();
  function mount(withHandlers = true) {
    if (withHandlers) renderHook(() => useBuilderHandlers(api));
    save.mockClear();
    return createBuilderXREdit(api, { molecules: () => PRESET_MOLECULES, save });
  }
  const press = (edit: ReturnType<typeof mount>, ...list: string[]) =>
    act(() => list.forEach((id) => edit.press(id)));

  it("picks tools, elements, orders and hydrogens from the panel", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    press(edit, "tool:bond");
    expect(s().tool).toBe("bond");
    press(edit, "page:table");
    expect(edit.local.page).toBe("table");
    expect(edit.panel().title).toBe("Choose an element");
    press(edit, "element:17");
    expect(s().element).toBe(17);
    expect(edit.local.page).toBe("main");
    press(edit, "page:table", "page:main");
    expect(edit.local.page).toBe("main");
    press(edit, "unbond");
    expect(edit.local.unbond).toBe(true);
    press(edit, "order:2");
    expect(s().bondOrder).toBe(2);
    expect(edit.local.unbond).toBe(false);
    press(edit, "hydrogens:off");
    expect(s().hydrogenMode).toBe("off");
    press(edit, "snap");
    expect(s().snap).toBe(true);
    press(edit, "nothing-like-this");
    expect(s().tool).toBe("bond");
  });

  it("runs the selection commands", () => {
    s().openStructure(waters(), null, "waters.xyz");
    const edit = mount();
    press(edit, "select:all");
    expect(s().selected).toHaveLength(6);
    press(edit, "select:clear");
    expect(s().selected).toEqual([]);
    s().setSelected([1]);
    press(edit, "select:molecule");
    expect([...s().selected].sort()).toEqual([0, 1, 2]);
    s().setSelected([4]);
    press(edit, "select:element");
    expect(s().selected).toEqual([1, 2, 4, 5]);
    press(edit, "select:invert");
    expect(s().selected).toEqual([0, 3]);
  });

  it("pages the library, chooses the molecule to place, and switches On atoms", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    press(edit, "library:prev");
    expect(edit.local.libraryPage).toBe(0);
    press(edit, "library:next");
    expect(edit.local.libraryPage).toBe(1);
    // Never past the last page.
    const last = Math.ceil(PRESET_MOLECULES.length / XR_LIBRARY_PAGE_SIZE) - 1;
    press(edit, ...Array(10).fill("library:next"));
    expect(edit.local.libraryPage).toBe(last);
    press(edit, `place:${PRESET_MOLECULES[2].id}`);
    expect(s().placeSource?.id).toBe(PRESET_MOLECULES[2].id);
    expect(s().tool).toBe("place");
    press(edit, "place:user:gone");
    expect(s().placeSource?.id).toBe(PRESET_MOLECULES[2].id);
    press(edit, "adsorb");
    expect(s().adsorbHeight).toBe(DEFAULT_ADSORB_HEIGHT);
    press(edit, "adsorb");
    expect(s().adsorbHeight).toBeNull();
  });

  it("undoes, redoes, deletes the selection, cleans up, shows the original and saves", () => {
    const edit = mount();
    press(edit, "save");
    expect(save).not.toHaveBeenCalled();
    act(() => s().openStructure(ethane(), null, "ethane.xyz"));
    s().setSelected([2]);
    press(edit, "delete");
    expect(s().result!.snapshot.nAtoms).toBe(7);
    press(edit, "undo");
    expect(s().result!.snapshot.nAtoms).toBe(8);
    press(edit, "redo");
    expect(s().result!.snapshot.nAtoms).toBe(7);
    press(edit, "original");
    expect(s().showOriginal).toBe(true);
    press(edit, "original");
    expect(s().showOriginal).toBe(false);
    press(edit, "cleanup");
    expect(runCleanup).toHaveBeenCalledWith(api);
    press(edit, "save");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores the panel while a drag owns the document", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    s().setDrag({ mode: "translate", axis: null, readout: null, contacts: [] });
    press(edit, "tool:delete", "undo");
    expect(s().tool).toBe("select");
  });

  it("clicks with the current tool: Select toggles, empty space clears", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    act(() => edit.click(2, null));
    act(() => edit.click(3, null));
    expect(s().selected).toEqual([2, 3]);
    act(() => edit.click(2, null));
    expect(s().selected).toEqual([3]);
    act(() => edit.click(null, [9, 9, 9]));
    expect(s().selected).toEqual([]);
  });

  it("adds an atom where an empty-space click lands, and deletes with Delete", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    press(edit, "tool:add", "element:8", "hydrogens:off");
    act(() => edit.click(null, [5, 6, 7]));
    const shown = s().result!.snapshot;
    expect(shown.nAtoms).toBe(9);
    expect(shown.elements[8]).toBe(8);
    expect(Array.from(shown.positions.slice(24, 27))).toEqual([5, 6, 7]);
    press(edit, "tool:delete");
    act(() => edit.click(8, null));
    expect(s().result!.snapshot.nAtoms).toBe(8);
  });

  it("bonds two atoms, or with Remove takes their bond away", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    press(edit, "tool:bond", "hydrogens:off", "unbond");
    act(() => edit.click(0, null));
    act(() => edit.click(1, null));
    expect(s().edits[0]).toEqual({ op: "delete_bond", a: 0, b: 1 });
    press(edit, "order:1");
    act(() => edit.click(0, null));
    act(() => edit.click(1, null));
    expect(s().edits[1]).toMatchObject({ op: "add_bond" });
  });

  it("says which presses drag and lights what a click would act on", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    // Select drags only what is selected; Move drags any atom.
    expect(edit.pressAction(2)).toBe("grab");
    s().setSelected([2]);
    expect(edit.pressAction(2)).toBe("drag");
    press(edit, "tool:move");
    expect(edit.pressAction(5)).toBe("drag");
    press(edit, "tool:delete");
    expect(edit.pressAction(5)).toBe("grab");
    expect(edit.hover(5)).toEqual({ atoms: [5], color: HOVER_COLORS.delete });
    expect(edit.spaceCursor()).toBeNull();
    press(edit, "tool:add");
    expect(edit.spaceCursor()).toBe(HOVER_COLORS.attach);
    // Paused editing: nothing to place.
    s().setShowOriginal(true);
    expect(edit.spaceCursor()).toBeNull();
  });

  it("shows the Place cursor with a molecule chosen, even with nothing open", () => {
    const edit = mount();
    expect(edit.hover(0)).toBeNull();
    press(edit, "tool:place");
    expect(edit.spaceCursor()).toBeNull();
    press(edit, `place:${PRESET_MOLECULES[0].id}`);
    expect(edit.spaceCursor()).toBe(HOVER_COLORS.attach);
    // The first molecule placed starts a document.
    act(() => edit.click(null, [0, 0, 0]));
    expect(s().result!.snapshot.nAtoms).toBe(PRESET_MOLECULES[0].elements.length);
  });

  it("drags atoms with the hand's motion, as one step", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount();
    press(edit, "tool:move");
    let ok = false;
    act(() => {
      ok = edit.dragStart(1);
    });
    expect(ok).toBe(true);
    act(() =>
      edit.dragMove({
        pivot: new THREE.Vector3(1.54, 0, 0),
        rotation: new THREE.Quaternion(),
        translation: new THREE.Vector3(0, 0, 2),
      }),
    );
    act(() => edit.dragEnd());
    expect(s().result!.snapshot.positions[5]).toBeCloseTo(2, 6);
    expect(editSteps(s().edits)).toHaveLength(1);
    expect(s().drag).toBeNull();
  });

  it("does nothing without the app's handlers", () => {
    s().openStructure(ethane(), null, "ethane.xyz");
    const edit = mount(false);
    expect(edit.pressAction(0)).toBe("grab");
    expect(edit.dragStart(0)).toBe(false);
    expect(() => {
      edit.click(0, null);
      edit.dragMove({
        pivot: new THREE.Vector3(),
        rotation: new THREE.Quaternion(),
        translation: new THREE.Vector3(),
      });
      edit.dragEnd();
    }).not.toThrow();
    expect(s().edits).toHaveLength(0);
  });
});
