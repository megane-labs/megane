/**
 * Keyboard shortcuts of the Builder.
 *
 * `resolveShortcut` maps a key event to an action and nothing else, so the
 * table is testable without a DOM; `useBuilderShortcuts` listens on the
 * window and dispatches. Keys are ignored while a text field, a select or a
 * dialog has the keyboard, so typing a lattice constant never switches tools.
 */

import { useEffect, type RefObject } from "react";
import type { StoreApi } from "zustand";
import type { BuilderStore } from "./store";
import { deleteAtoms } from "./editActions";
import { historyLock } from "./history";
import type { BuildTool } from "./types";

export type ShortcutAction =
  | { kind: "tool"; tool: BuildTool }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "delete_selected" }
  | { kind: "escape" }
  | { kind: "select_all" }
  | { kind: "open" }
  | { kind: "save" }
  | { kind: "reset_view" }
  | { kind: "help" };

/** The key that selects each tool, shown on the rail and in tooltips. */
export const TOOL_KEYS: Record<BuildTool, string> = {
  select: "S",
  add: "A",
  bond: "B",
  delete: "D",
  move: "M",
  element: "E",
  place: "P",
};

const KEY_TO_TOOL: Record<string, BuildTool> = Object.fromEntries(
  (Object.entries(TOOL_KEYS) as [BuildTool, string][]).map(([tool, key]) => [
    key.toLowerCase(),
    tool,
  ]),
);

/** The part of a `KeyboardEvent` the table reads. */
export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The action `key` stands for, or null when it is not a shortcut. */
export function resolveShortcut(key: ShortcutKey): ShortcutAction | null {
  const mod = key.ctrlKey || key.metaKey;
  const k = key.key.length === 1 ? key.key.toLowerCase() : key.key;
  if (mod && !key.altKey) {
    switch (k) {
      case "z":
        return key.shiftKey ? { kind: "redo" } : { kind: "undo" };
      case "y":
        return key.shiftKey ? null : { kind: "redo" };
      case "o":
        return key.shiftKey ? null : { kind: "open" };
      case "s":
        return key.shiftKey ? null : { kind: "save" };
      case "a":
        return key.shiftKey ? null : { kind: "select_all" };
      default:
        return null;
    }
  }
  if (key.altKey) return null;
  switch (k) {
    case "Escape":
      return { kind: "escape" };
    case "Delete":
    case "Backspace":
      return key.shiftKey ? null : { kind: "delete_selected" };
    case "r":
      return key.shiftKey ? null : { kind: "reset_view" };
    // Shift + / on most layouts; whatever produces "?" on the others.
    case "?":
      return { kind: "help" };
    default: {
      if (key.shiftKey) return null;
      const tool = KEY_TO_TOOL[k];
      return tool ? { kind: "tool", tool } : null;
    }
  }
}

/** Whether keyboard input belongs to `target` (a text field, a select, an editable). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

export interface ShortcutHost {
  open: () => void;
  save: () => void;
  resetView: () => void;
  /** Show the keyboard-shortcut card. */
  help?: () => void;
}

/** One row of the keyboard-shortcut card: the keys and what they do. */
export interface ShortcutEntry {
  keys: string;
  action: string;
}

/**
 * Every shortcut `resolveShortcut` knows besides the tool keys (`TOOL_KEYS`,
 * which the card lists with the tools' names), with `mod` (⌘ or Ctrl) in
 * the keys.
 */
export function generalShortcuts(mod: string): ShortcutEntry[] {
  return [
    { keys: `${mod}+O`, action: "Open a structure file" },
    { keys: `${mod}+S`, action: "Save in the document's own format" },
    { keys: `${mod}+Z`, action: "Undo" },
    { keys: `${mod}+Shift+Z  /  ${mod}+Y`, action: "Redo" },
    { keys: `${mod}+A`, action: "Select every atom" },
    { keys: "Delete  /  Backspace", action: "Delete the selected atoms" },
    { keys: "Esc", action: "Cancel a bond, clear the selection, drop the Place molecule" },
    { keys: "R", action: "Reset the view" },
    { keys: "?", action: "Show this list" },
  ];
}

/** What the modifiers and keys do during a drag of atoms in the view (`manipulate.ts`). */
export function dragShortcuts(mod: string): ShortcutEntry[] {
  return [
    { keys: "Drag", action: "Move the atom with its selection in the screen plane" },
    { keys: "Shift+Drag", action: "Move in depth" },
    { keys: `${mod}+Drag`, action: "Turn the selection about its centre" },
    { keys: `${mod}+Shift+Drag`, action: "Spin it about the line of sight" },
    { keys: "X Y Z  /  A B C", action: "During a drag: lock to an axis (again frees it)" },
    { keys: "Esc", action: "During a drag: cancel it" },
    { keys: `Shift / ${mod}+Click`, action: "Add to or take from the selection" },
  ];
}

/** Run `action` against the store and the app; returns whether it did anything. */
export function runShortcut(
  action: ShortcutAction,
  api: StoreApi<BuilderStore>,
  host: ShortcutHost,
): boolean {
  const s = api.getState();
  switch (action.kind) {
    case "tool":
      s.setTool(action.tool);
      return true;
    case "undo":
    case "redo": {
      // Paused while a preview or the original is on screen: say why
      // rather than doing nothing.
      const can = action.kind === "undo" ? s.edits.length > 0 : s.redoStack.length > 0;
      const lock = historyLock(s);
      if (lock) {
        if (!can) return false;
        s.reportInfo(lock);
        return true;
      }
      return (action.kind === "undo" ? s.undo() : s.redo()) !== null;
    }
    // The Delete tool's edit: hydrogens go with their atoms while they are
    // kept balanced, and the selection drops the deleted atoms.
    case "delete_selected":
      return deleteAtoms(s, s.selected);
    case "select_all":
      if (!s.source) return false;
      s.selectAll();
      return true;
    case "escape":
      if (s.pendingBondAtom !== null) {
        s.setPendingBondAtom(null);
        return true;
      }
      if (s.selected.length > 0) {
        s.clearSelected();
        return true;
      }
      if (s.tool === "place" && s.placeSource) {
        s.setPlaceSource(null);
        return true;
      }
      return false;
    case "open":
      host.open();
      return true;
    case "save":
      if (!s.source) return false;
      host.save();
      return true;
    case "reset_view":
      host.resetView();
      return true;
    case "help":
      if (!host.help) return false;
      host.help();
      return true;
  }
}

/**
 * Whether a key event belongs to the Builder. Without a scope (the web app,
 * which owns the window) every key does; embedded beside an IDE's own
 * editors, only keys pressed while the focus is inside the Builder do.
 */
export function inScope(
  target: EventTarget | null,
  scope: HTMLElement | null | undefined,
): boolean {
  if (scope === undefined) return true;
  return !!scope && target instanceof Node && scope.contains(target);
}

/**
 * Listen for the shortcuts on the window while mounted; with `scope`, only
 * for keys pressed while the focus is inside that element.
 */
export function useBuilderShortcuts(
  api: StoreApi<BuilderStore>,
  host: ShortcutHost,
  scope?: RefObject<HTMLElement | null>,
  /** False while the keys belong to something else (Flow mode's graph). */
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      // A drag in the view owns the keys (axis locks, Esc); see useBuilderHandlers.
      if (api.getState().drag) return;
      if (scope && !inScope(e.target, scope.current)) return;
      if (isTypingTarget(e.target)) return;
      // A modal dialog (the Ketcher sketcher, a confirm) owns the keyboard; the forms in
      // the Details panel (a Structure dialog, a new document, a Python tool,
      // the Place gallery) do not, so the tool keys keep working beside them.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]'))
        return;
      const action = resolveShortcut(e);
      if (!action) return;
      if (runShortcut(action, api, host)) e.preventDefault();
      else if (action.kind === "open" || action.kind === "save") e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api, host, scope, enabled]);
}
