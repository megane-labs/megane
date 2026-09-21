/**
 * The Builder's keyboard shortcuts: the key table, the typing guard, and what
 * each action does to the store.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TOOL_KEYS,
  isTypingTarget,
  resolveShortcut,
  runShortcut,
  type ShortcutKey,
} from "@/builder/shortcuts";
import { createBuilderStore } from "@/builder/store";
import { PRESET_MOLECULES } from "@/builder/library/presets";
import type { Snapshot } from "@/types";

function key(k: string, mods: Partial<ShortcutKey> = {}): ShortcutKey {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
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

describe("resolveShortcut", () => {
  it("maps every tool key to its tool", () => {
    for (const [tool, k] of Object.entries(TOOL_KEYS)) {
      expect(resolveShortcut(key(k.toLowerCase()))).toEqual({ kind: "tool", tool });
      // Upper case (Caps Lock) picks the same tool; Shift does not.
      expect(resolveShortcut(key(k))).toEqual({ kind: "tool", tool });
      expect(resolveShortcut(key(k.toLowerCase(), { shiftKey: true }))).toBeNull();
    }
  });

  it("maps undo, redo, open, save and the bare keys", () => {
    expect(resolveShortcut(key("z", { ctrlKey: true }))).toEqual({ kind: "undo" });
    expect(resolveShortcut(key("z", { metaKey: true }))).toEqual({ kind: "undo" });
    expect(resolveShortcut(key("z", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "redo" });
    expect(resolveShortcut(key("y", { ctrlKey: true }))).toEqual({ kind: "redo" });
    expect(resolveShortcut(key("o", { ctrlKey: true }))).toEqual({ kind: "open" });
    expect(resolveShortcut(key("s", { metaKey: true }))).toEqual({ kind: "save" });
    expect(resolveShortcut(key("Escape"))).toEqual({ kind: "escape" });
    expect(resolveShortcut(key("Delete"))).toEqual({ kind: "delete_selected" });
    expect(resolveShortcut(key("Backspace"))).toEqual({ kind: "delete_selected" });
    expect(resolveShortcut(key("r"))).toEqual({ kind: "reset_view" });
  });

  it("ignores anything else, and every Alt combination", () => {
    expect(resolveShortcut(key("q"))).toBeNull();
    expect(resolveShortcut(key("F5"))).toBeNull();
    expect(resolveShortcut(key("k", { ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(key("s", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(resolveShortcut(key("a", { altKey: true }))).toBeNull();
    expect(resolveShortcut(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("is true for text fields and editables, false for the rest", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not implement isContentEditable; set it directly.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });
});

describe("runShortcut", () => {
  const host = { open: vi.fn(), save: vi.fn(), resetView: vi.fn() };
  let api = createBuilderStore();

  beforeEach(() => {
    api = createBuilderStore();
    host.open.mockClear();
    host.save.mockClear();
    host.resetView.mockClear();
  });

  it("switches tools", () => {
    expect(runShortcut({ kind: "tool", tool: "bond" }, api, host)).toBe(true);
    expect(api.getState().tool).toBe("bond");
  });

  it("undoes and redoes only when there is something to move", () => {
    expect(runShortcut({ kind: "undo" }, api, host)).toBe(false);
    api.getState().openStructure(water(), null, "w.xyz");
    api.getState().pushOp({ op: "delete_atoms", atoms: [2] });
    expect(runShortcut({ kind: "undo" }, api, host)).toBe(true);
    expect(api.getState().result!.snapshot.nAtoms).toBe(3);
    expect(runShortcut({ kind: "redo" }, api, host)).toBe(true);
    expect(api.getState().result!.snapshot.nAtoms).toBe(2);
    expect(runShortcut({ kind: "redo" }, api, host)).toBe(false);
  });

  it("deletes the selection, and does nothing without one or while paused", () => {
    api.getState().openStructure(water(), null, "w.xyz");
    expect(runShortcut({ kind: "delete_selected" }, api, host)).toBe(false);
    api.getState().setSelected([1, 2]);
    expect(runShortcut({ kind: "delete_selected" }, api, host)).toBe(true);
    expect(api.getState().edits).toEqual([{ op: "delete_atoms", atoms: [1, 2] }]);
    expect(api.getState().selected).toEqual([]);
    // Paused: the preview is shown, so a key must not write an op.
    api.getState().setSelected([0]);
    api.getState().setShowOriginal(true);
    expect(runShortcut({ kind: "delete_selected" }, api, host)).toBe(false);
    expect(api.getState().edits).toHaveLength(1);
  });

  it("Escape drops the pending bond, then the selection, then the place tool", () => {
    api.getState().openStructure(water(), null, "w.xyz");
    expect(runShortcut({ kind: "escape" }, api, host)).toBe(false);
    api.getState().setSelected([0]);
    api.getState().setPendingBondAtom(1);
    expect(runShortcut({ kind: "escape" }, api, host)).toBe(true);
    expect(api.getState().pendingBondAtom).toBeNull();
    expect(api.getState().selected).toEqual([0]);
    expect(runShortcut({ kind: "escape" }, api, host)).toBe(true);
    expect(api.getState().selected).toEqual([]);
    api.getState().setPlaceSource(PRESET_MOLECULES[0]);
    expect(runShortcut({ kind: "escape" }, api, host)).toBe(true);
    expect(api.getState().placeSource).toBeNull();
    expect(api.getState().tool).toBe("select");
  });

  it("forwards open, save and reset view to the app, and never saves nothing", () => {
    expect(runShortcut({ kind: "open" }, api, host)).toBe(true);
    expect(host.open).toHaveBeenCalledTimes(1);
    expect(runShortcut({ kind: "save" }, api, host)).toBe(false);
    expect(host.save).not.toHaveBeenCalled();
    api.getState().newCell(10);
    expect(runShortcut({ kind: "save" }, api, host)).toBe(true);
    expect(host.save).toHaveBeenCalledTimes(1);
    expect(runShortcut({ kind: "reset_view" }, api, host)).toBe(true);
    expect(host.resetView).toHaveBeenCalledTimes(1);
  });
});
