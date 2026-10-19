/**
 * What the Builder marks under the pointer: the atoms a click would act on,
 * in a colour that says what the click will do — blue to select, red to
 * delete, amber to change the element, violet to attach, bond or adsorb onto.
 * Nothing is marked while a drag runs, over empty space, or when a click on
 * the atom would do nothing.
 */

import type { BuildTool } from "./types";

export const HOVER_COLORS = {
  select: 0x3b82f6,
  delete: 0xef4444,
  element: 0xf59e0b,
  attach: 0x8b5cf6,
} as const;

export interface HoverHighlight {
  atoms: number[];
  color: number;
}

export interface HoverState {
  tool: BuildTool;
  editable: boolean;
  pendingBondAtom: number | null;
  /** The Place tool accepts clicks on atoms only with an adsorption height. */
  adsorbOnAtoms: boolean;
  dragging: boolean;
}

/** The highlight for the rendered atom `hovered` (null: none under the pointer). */
export function hoverHighlight(hovered: number | null, s: HoverState): HoverHighlight | null {
  if (hovered === null || s.dragging) return null;
  switch (s.tool) {
    case "select":
    case "move":
      return { atoms: [hovered], color: HOVER_COLORS.select };
    case "delete":
      return s.editable ? { atoms: [hovered], color: HOVER_COLORS.delete } : null;
    case "element":
      return s.editable ? { atoms: [hovered], color: HOVER_COLORS.element } : null;
    case "add":
      return s.editable ? { atoms: [hovered], color: HOVER_COLORS.attach } : null;
    case "bond":
      if (!s.editable) return null;
      return {
        atoms:
          s.pendingBondAtom === null || s.pendingBondAtom === hovered
            ? [hovered]
            : [s.pendingBondAtom, hovered],
        color: HOVER_COLORS.attach,
      };
    case "place":
      return s.editable && s.adsorbOnAtoms
        ? { atoms: [hovered], color: HOVER_COLORS.attach }
        : null;
  }
}
