/**
 * The File menu's item list: what each entry is called, when it is
 * offered, and what it calls.
 */

import { describe, it, expect, vi } from "vitest";
import { fileMenuItems } from "@/builder/topbarMenus";
import type { MenuAction, MenuItem } from "@/builder/Menu";

const actions = (items: MenuItem[]) => items.filter((i): i is MenuAction => "onSelect" in i);
const byId = (items: MenuItem[], id: string) => actions(items).find((i) => i.testId === id)!;

describe("fileMenuItems", () => {
  const make = (canSave: boolean) => {
    const a = {
      open: vi.fn(),
      newCell: vi.fn(),
      newBulk: vi.fn(),
      save: vi.fn(),
      formats: [
        { value: "pdb", label: "PDB" },
        { value: "xyz", label: "XYZ" },
      ],
      canSave,
      mod: "Ctrl",
    };
    return { a, items: fileMenuItems(a) };
  };

  it("opens, starts a new structure and saves in each format", () => {
    const { a, items } = make(true);
    expect(byId(items, "builder-open").label).toContain("Ctrl+O");
    byId(items, "builder-open").onSelect();
    byId(items, "builder-new-cell-item").onSelect();
    byId(items, "builder-new-bulk-item").onSelect();
    expect(a.open).toHaveBeenCalled();
    expect(a.newCell).toHaveBeenCalled();
    expect(a.newBulk).toHaveBeenCalled();
    // The shortcut hint sits on the first format only.
    expect(byId(items, "builder-save-pdb").label).toBe("Save PDB  (Ctrl+S)");
    expect(byId(items, "builder-save-xyz").label).toBe("Save XYZ");
    byId(items, "builder-save-xyz").onSelect();
    expect(a.save).toHaveBeenCalledWith("xyz");
    expect(byId(items, "builder-save-xyz").disabled).toBe(false);
  });

  it("puts the shortcut hint on the format ⌘/Ctrl+S writes and explains an unavailable one", () => {
    const save = vi.fn();
    const items = fileMenuItems({
      open: vi.fn(),
      newCell: vi.fn(),
      newBulk: vi.fn(),
      save,
      formats: [
        { value: "xyz", label: "XYZ" },
        { value: "pdb", label: "PDB" },
        { value: "cif", label: "CIF", unavailable: "CIF needs a unit cell" },
      ],
      quickFormat: "pdb",
      canSave: true,
      mod: "⌘",
    });
    expect(byId(items, "builder-save-xyz").label).toBe("Save XYZ");
    expect(byId(items, "builder-save-pdb").label).toBe("Save PDB  (⌘+S)");
    expect(byId(items, "builder-save-cif").disabled).toBe(true);
    expect(byId(items, "builder-save-cif").title).toBe("CIF needs a unit cell");
    expect(byId(items, "builder-save-xyz").title).toBeUndefined();
    // Neither the library nor the shortcut list is offered without its action.
    expect(items.some((i) => "testId" in i && i.testId === "builder-file-library")).toBe(false);
    expect(items.some((i) => "testId" in i && i.testId === "builder-shortcuts-item")).toBe(false);
  });

  it("offers the library and the keyboard shortcuts", () => {
    const library = vi.fn();
    const shortcuts = vi.fn();
    const items = fileMenuItems({
      open: vi.fn(),
      newCell: vi.fn(),
      newBulk: vi.fn(),
      save: vi.fn(),
      formats: [],
      canSave: false,
      library,
      shortcuts,
      mod: "Ctrl",
    });
    byId(items, "builder-file-library").onSelect();
    expect(library).toHaveBeenCalled();
    expect(byId(items, "builder-shortcuts-item").label).toContain("?");
    byId(items, "builder-shortcuts-item").onSelect();
    expect(shortcuts).toHaveBeenCalled();
  });

  it("disables Save with nothing open", () => {
    const { items } = make(false);
    expect(byId(items, "builder-save-pdb").disabled).toBe(true);
    expect(byId(items, "builder-open").disabled).toBeFalsy();
  });
});
