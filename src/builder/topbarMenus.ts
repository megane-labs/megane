/**
 * The top bar's File and View menus. File holds the document (open, start
 * a new one, save it); View holds the camera (reset, look along an axis) and
 * the theme. Pure item lists, so the bar and its tests read the same thing.
 */

import type { MenuItem } from "./Menu";
import type { ViewAxis } from "../renderer/cameraOrientation";
import { CARTESIAN_VIEW_AXES, LATTICE_VIEW_AXES } from "../renderer/cameraOrientation";
import type { Theme } from "../stores/useThemeStore";

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

const THEME_LABELS: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

/** `+a` → `+a`, `-x` → `−x`: a real minus sign in the menu. */
function axisLabel(axis: ViewAxis): string {
  return axis.replace("-", "−");
}

export interface ViewMenuActions {
  resetView: () => void;
  align: (axis: ViewAxis) => void;
  /** The a / b / c directions are offered only with a cell. */
  hasCell: boolean;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export function viewMenuItems(a: ViewMenuActions): MenuItem[] {
  const axisItems = (axes: readonly ViewAxis[]): MenuItem[] =>
    axes.map((axis) => ({
      label: `Look along ${axisLabel(axis)}`,
      testId: `builder-view-axis-${axis}`,
      onSelect: () => a.align(axis),
    }));
  return [
    {
      label: "Reset view  (R)",
      testId: "builder-view-reset",
      title: "Fit the structure in the standard orientation",
      onSelect: a.resetView,
    },
    { separator: true },
    { caption: "Look along" },
    ...(a.hasCell ? axisItems(LATTICE_VIEW_AXES) : []),
    ...axisItems(CARTESIAN_VIEW_AXES),
    { separator: true },
    { caption: "Theme" },
    ...(["system", "light", "dark"] as Theme[]).map((t) => ({
      // An em space stands in for the tick so the names line up (HTML would
      // collapse ordinary spaces).
      label: `${a.theme === t ? "✓" : "\u2003"}\u2002${THEME_LABELS[t]}`,
      testId: `builder-theme-${t}`,
      onSelect: () => a.setTheme(t),
    })),
  ];
}
