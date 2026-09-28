/**
 * The Builder panel's File menu: the document (open, start a new one, save
 * it). A pure item list, so the panel and its tests read the same thing. The
 * camera lives on the view (Reset View and the axis buttons, as in the
 * viewer) and the theme on the panel's Others row.
 */

import type { MenuItem } from "./Menu";

export interface FileMenuActions {
  open: () => void;
  newCell: () => void;
  newBulk: () => void;
  /** One entry per export format; disabled while there is nothing to save. */
  formats: { value: string; label: string }[];
  save: (format: string) => void;
  canSave: boolean;
  /** ⌘ or Ctrl, for the shortcut hints. */
  mod: string;
}

export function fileMenuItems(a: FileMenuActions): MenuItem[] {
  return [
    {
      label: `Open…  (${a.mod}+O)`,
      testId: "builder-open",
      title: "Open a structure file (or drop one on the view)",
      onSelect: a.open,
    },
    { label: "New empty cell…", testId: "builder-new-cell-item", onSelect: a.newCell },
    { label: "New bulk crystal…", testId: "builder-new-bulk-item", onSelect: a.newBulk },
    { separator: true },
    ...a.formats.map((f, i) => ({
      label: i === 0 ? `Save ${f.label}  (${a.mod}+S)` : `Save ${f.label}`,
      testId: `builder-save-${f.value}`,
      disabled: !a.canSave,
      onSelect: () => a.save(f.value),
    })),
  ];
}
