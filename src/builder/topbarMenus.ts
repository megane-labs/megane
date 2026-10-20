/**
 * The File menu on the operations rail: the document (open, start a new
 * one, save it), the way into the molecule library, and the list of
 * keyboard shortcuts. A pure item list, so the rail and its tests read the
 * same thing. The camera lives on the view (Reset View and the axis buttons,
 * as in the viewer) and the theme at the foot of the rail.
 */

import type { MenuItem } from "./Menu";

/** A Save format as the File menu offers it. */
export interface FileMenuFormat {
  value: string;
  label: string;
  /** Why this format cannot be written now (e.g. it needs a cell); disables the item. */
  unavailable?: string | null;
}

export interface FileMenuActions {
  open: () => void;
  newCell: () => void;
  newBulk: () => void;
  /** One entry per export format; disabled while there is nothing to save. */
  formats: FileMenuFormat[];
  save: (format: string) => void;
  canSave: boolean;
  /** The format ⌘/Ctrl+S writes, whose item carries the hint; the first format by default. */
  quickFormat?: string;
  /** Switch to the Place tool with its library gallery open. */
  library?: () => void;
  /** Show the keyboard shortcuts. */
  shortcuts?: () => void;
  /** ⌘ or Ctrl, for the shortcut hints. */
  mod: string;
}

export function fileMenuItems(a: FileMenuActions): MenuItem[] {
  const quick = a.quickFormat ?? a.formats[0]?.value;
  return [
    {
      label: `Open…  (${a.mod}+O)`,
      testId: "builder-open",
      title: "Open a structure file (or drop one on the view)",
      onSelect: a.open,
    },
    { label: "New empty cell…", testId: "builder-new-cell-item", onSelect: a.newCell },
    { label: "New bulk crystal…", testId: "builder-new-bulk-item", onSelect: a.newBulk },
    ...(a.library
      ? [
          {
            label: "Insert molecule from library…",
            testId: "builder-file-library",
            title: "Pick a molecule from the library and place it with the Place tool (P)",
            onSelect: a.library,
          },
        ]
      : []),
    { separator: true },
    ...a.formats.map((f) => ({
      label: f.value === quick ? `Save ${f.label}  (${a.mod}+S)` : `Save ${f.label}`,
      testId: `builder-save-${f.value}`,
      disabled: !a.canSave || !!f.unavailable,
      ...(a.canSave && f.unavailable ? { title: f.unavailable } : {}),
      onSelect: () => a.save(f.value),
    })),
    ...(a.shortcuts
      ? [
          { separator: true as const },
          {
            label: "Keyboard shortcuts…  (?)",
            testId: "builder-shortcuts-item",
            onSelect: a.shortcuts,
          },
        ]
      : []),
  ];
}
