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
import type { EditAtomRef } from "../pipeline/types";
import { canEdit, type BuilderStore } from "./store";
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
  | { kind: "reset_view" };

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
      return s.undo() !== null;
    case "redo":
      return s.redo() !== null;
    case "delete_selected": {
      if (!canEdit(s) || s.selected.length === 0) return false;
      const refs = s.selected
        .map((i) => (s.result && i < s.result.snapshot.nAtoms ? s.result.refAt(i) : null))
        .filter((r): r is EditAtomRef => r !== null);
      if (refs.length === 0) return false;
      s.clearSelected();
      s.pushOp({ op: "delete_atoms", atoms: refs });
      return true;
    }
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
      // A modal dialog (the Ketcher sketcher) owns the keyboard; the forms in
      // the Details panel (a Structure dialog, a new document, a Python tool,
      // the Place gallery) do not, so the tool keys keep working beside them.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const action = resolveShortcut(e);
      if (!action) return;
      if (runShortcut(action, api, host)) e.preventDefault();
      else if (action.kind === "open" || action.kind === "save") e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [api, host, scope, enabled]);
}
