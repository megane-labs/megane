/**
 * megane Builder in a headset (WebXR): the `XREditBridge` that puts the
 * Builder's controls on the immersive panel and lets the hands edit the
 * document, so the page is not needed while the headset hides it.
 *
 * The panel mirrors the desktop shell. Its top row is the tool rail; the two
 * rows under it are the current tool's settings from the Details panel (the
 * element, with the whole periodic table a press away; the bond order; how
 * hydrogens are kept; Snap and the selection commands; the library molecule
 * to place and *Place on atoms*); the bottom row is Undo, Redo, Delete
 * selected, Clean up, Show original and Save, before the panel's own Reset
 * and Exit. The status line says what a press does next, or the notice the
 * desktop would show, or a drag's readout.
 *
 * Presses in the room go through the same `BuildHandlers` as the mouse: a
 * pinch let go is a click with the current tool (`pick`), and a pinch that
 * moves a draggable atom drags it with the hand (`dragRigid`), so every edit
 * lands in the history exactly as a desktop one does. With no modifier keys
 * to hold, a click with Select or Move adds the atom to the selection or
 * takes it out (Ctrl-click on the desktop; a click on empty space clears it),
 * and the Bond tool's *Remove* switch stands in for Shift on the second atom.
 *
 * Opening, the Structure and Tools menus, the Inspector's fields, the
 * History list and Flow mode stay on the page.
 */

import type { StoreApi } from "zustand";
import { getColor, getElementSymbol } from "../constants";
import type { XREditButton, XREditPanel } from "../renderer/xr/XRPanel";
import type { XREditBridge, XRHighlight, XRPressAction } from "../renderer/xr/XRSessionController";
import type { XRRigidMotion } from "../renderer/xr/xrMath";
import { BOND_ORDERS, HYDROGEN_MODES, QUICK_ELEMENTS } from "./ContextBar";
import { TABLE_MAX_Z, tablePosition } from "./PeriodicTable";
import { TOOLS, toolInfo } from "./ToolRail";
import { isCleanupRunning, runCleanup } from "./cleanup";
import { bondOrderName } from "./editActions";
import { moleculeOf } from "./geometry";
import { HOVER_COLORS, hoverHighlight } from "./hover";
import { DEFAULT_ADSORB_HEIGHT } from "./library/ui";
import type { LibraryMolecule } from "./library/types";
import { readoutLabel } from "./manipulate";
import { atomName } from "./placement";
import { runShortcut, type ShortcutAction } from "./shortcuts";
import { canEdit, isDirty, shownSnapshot, type BuilderStore, type HydrogenMode } from "./store";
import type { BuildModifiers, BuildTool } from "./types";

/** Library molecules on one page of the Place row. */
export const XR_LIBRARY_PAGE_SIZE = 5;

/** What the panel shows that the document store does not hold. */
export interface BuilderXRLocal {
  /** The tool settings, or the periodic table. */
  page: "main" | "table";
  /** Which page of the library the Place row shows. */
  libraryPage: number;
  /** The Bond tool removes the bond between the two atoms instead (Shift on the desktop). */
  unbond: boolean;
}

/** What the panel needs besides the store. */
export interface BuilderXRContext {
  /** The molecules Place can stamp: the library. */
  molecules: readonly LibraryMolecule[];
  /** Whether the page can save (⌘/Ctrl + S). */
  canSave: boolean;
  /** Whether a Clean up is running. */
  cleaning: boolean;
}

/** What the headset hands to the store besides it. */
export interface BuilderXRDeps {
  /** The library, read when the panel is drawn. */
  molecules: () => readonly LibraryMolecule[];
  /** Save the document in its own format, as ⌘/Ctrl + S does; none hides Save. */
  save?: () => void;
}

const NO_MODS: BuildModifiers = { shiftKey: false, mod: false, altKey: false };

/** What a press of each tool does, worded for hands. */
const HINTS: Record<BuildTool, string> = {
  select: "Pinch atoms to select or drop them; empty space clears. Drag a selected one to move.",
  move: "Pinch an atom and move your hand to carry it with its selection.",
  add: "Pinch an atom to attach a new one, or empty space to place one at the ray's end.",
  bond: "Pinch two atoms to bond them, or to change the order of their bond.",
  element: "Pinch an atom to change it to the chosen element.",
  delete: "Pinch an atom to delete it with its bonds.",
  place: "Pinch empty space to drop the molecule at the ray's end.",
};

/** CSS colour of element `z` as the view draws it. */
export function elementSwatch(z: number): string {
  const [r, g, b] = getColor(z).map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  return `rgb(${r}, ${g}, ${b})`;
}

function elementButton(z: number, current: number): XREditButton {
  return {
    id: `element:${z}`,
    label: getElementSymbol(z),
    active: z === current,
    swatch: elementSwatch(z),
  };
}

const spacer = (span: number): XREditButton => ({ id: "", label: "", spacer: true, span });

/** The status line's title: the tool and the settings a press uses. */
function title(s: BuilderStore, local: BuilderXRLocal): string {
  const label = toolInfo(s.tool).label;
  const sym = getElementSymbol(s.element);
  switch (s.tool) {
    case "add":
      return `${label} · ${sym} · ${bondOrderName(s.bondOrder)}`;
    case "element":
      return `${label} · ${sym}`;
    case "bond":
      return `${label} · ${local.unbond ? "remove" : bondOrderName(s.bondOrder)}`;
    case "place":
      return `${label} · ${s.placeSource?.name ?? "no molecule"}`;
    default:
      return label;
  }
}

/** Right of the title: the document's size, the selection, unsaved edits. */
function summary(s: BuilderStore): string {
  const shown = shownSnapshot(s);
  if (!shown) return "Nothing open";
  const parts = [`${shown.nAtoms} atom${shown.nAtoms === 1 ? "" : "s"}`];
  if (s.selected.length > 0) parts.push(`${s.selected.length} selected`);
  if (isDirty(s)) parts.push("unsaved");
  return parts.join(" · ");
}

/** The line under the title: the notice, a drag's readout, why editing waits, or what a press does. */
function detail(
  s: BuilderStore,
  local: BuilderXRLocal,
): Pick<XREditPanel, "detail" | "detailLevel"> {
  if (s.notice) return { detail: s.notice.text, detailLevel: s.notice.level };
  if (s.drag) {
    const parts = [s.drag.readout ? readoutLabel(s.drag.readout) : "Move"];
    if (s.snap) parts.push("snap");
    if (s.drag.contacts.length > 0) parts.push(`${s.drag.contacts.length} atoms too close`);
    return { detail: parts.join(" · "), detailLevel: "info" };
  }
  if (s.source && s.preview) {
    return {
      detail: "A preview is open on the page: Apply or Cancel it there to edit.",
      detailLevel: "info",
    };
  }
  if (s.source && s.showOriginal) {
    return { detail: "Showing the original: press Original again to edit.", detailLevel: "info" };
  }
  if (!s.source && s.tool !== "place") {
    return {
      detail: "Open a structure on the page, or choose Place to start one here.",
      detailLevel: "hint",
    };
  }
  let hint = HINTS[s.tool];
  const shown = shownSnapshot(s);
  if (s.tool === "bond" && local.unbond) hint = "Pinch two atoms to remove the bond between them.";
  if (s.tool === "bond" && shown && s.pendingBondAtom !== null) {
    hint = `Now pinch the atom to ${local.unbond ? "unbond from" : "bond to"} ${atomName(shown, s.pendingBondAtom)}; empty space lets go.`;
  }
  if (s.tool === "place") {
    if (!s.placeSource) hint = "Choose a molecule below.";
    else if (s.adsorbHeight !== null) {
      hint = "Pinch empty space to drop the molecule there, or an atom to put it on top.";
    }
  }
  return { detail: hint, detailLevel: "hint" };
}

const hydrogenRow = (mode: HydrogenMode): XREditButton[] =>
  HYDROGEN_MODES.map((m) => ({
    id: `hydrogens:${m.value}`,
    label: `H ${m.label.toLowerCase()}`,
    active: mode === m.value,
  }));

function bondOrderRow(s: BuilderStore, local: BuilderXRLocal, withRemove: boolean): XREditButton[] {
  const row: XREditButton[] = BOND_ORDERS.map((o) => ({
    id: `order:${o.value}`,
    label: o.label,
    active: s.bondOrder === o.value && !(withRemove && local.unbond),
  }));
  if (withRemove) row.push({ id: "unbond", label: "Remove", active: local.unbond });
  return row;
}

function elementRow(s: BuilderStore): XREditButton[] {
  const row = QUICK_ELEMENTS.map((z) => elementButton(z, s.element));
  if (!QUICK_ELEMENTS.includes(s.element)) row.push(elementButton(s.element, s.element));
  row.push({ id: "page:table", label: "More…" });
  return row;
}

function libraryRows(s: BuilderStore, local: BuilderXRLocal, ctx: BuilderXRContext) {
  const pages = Math.max(1, Math.ceil(ctx.molecules.length / XR_LIBRARY_PAGE_SIZE));
  const page = Math.min(Math.max(0, local.libraryPage), pages - 1);
  const shown = ctx.molecules.slice(page * XR_LIBRARY_PAGE_SIZE, (page + 1) * XR_LIBRARY_PAGE_SIZE);
  const library: XREditButton[] = [
    { id: "library:prev", label: "‹", enabled: page > 0 },
    ...shown.map((m) => ({
      id: `place:${m.id}`,
      label: m.name,
      active: s.placeSource?.id === m.id,
      span: 2,
    })),
    ...(shown.length < XR_LIBRARY_PAGE_SIZE
      ? [spacer(2 * (XR_LIBRARY_PAGE_SIZE - shown.length))]
      : []),
    { id: "library:next", label: "›", enabled: page < pages - 1 },
  ];
  const height = s.adsorbHeight;
  const adsorb: XREditButton = {
    id: "adsorb",
    label: height === null ? "On atoms: off" : `On atoms: ${height} Å`,
    active: height !== null,
    span: 2,
  };
  return [library, [adsorb, spacer(5)]];
}

/** The tool's settings: two rows (either may be empty), so the rows never jump. */
function settingsRows(
  s: BuilderStore,
  local: BuilderXRLocal,
  ctx: BuilderXRContext,
): XREditButton[][] {
  const hasSelection = s.selected.length > 0;
  switch (s.tool) {
    case "select":
    case "move":
      return [
        [
          { id: "select:all", label: "All", enabled: !!s.source },
          { id: "select:invert", label: "Invert", enabled: !!s.source },
          { id: "select:clear", label: "Clear", enabled: hasSelection },
          { id: "select:molecule", label: "Molecule", enabled: hasSelection },
          { id: "select:element", label: "Same element", enabled: hasSelection, span: 1.5 },
        ],
        [{ id: "snap", label: "Snap", active: s.snap }, spacer(4.5)],
      ];
    case "add":
      return [elementRow(s), [...bondOrderRow(s, local, false), ...hydrogenRow(s.hydrogenMode)]];
    case "element":
      return [elementRow(s), [...hydrogenRow(s.hydrogenMode), spacer(4)]];
    case "bond":
      return [bondOrderRow(s, local, true), [...hydrogenRow(s.hydrogenMode), spacer(4)]];
    case "delete":
      return [[...hydrogenRow(s.hydrogenMode), spacer(4)], []];
    case "place":
      return libraryRows(s, local, ctx);
  }
}

/** The periodic table: periods 1–7, then the lanthanides and actinides, 18 cells a row. */
export function periodicTableRows(current: number, maxZ = TABLE_MAX_Z): XREditButton[][] {
  const grid = new Map<number, number>();
  let last = 0;
  for (let z = 1; z <= maxZ; z++) {
    const { row, col } = tablePosition(z);
    // Row 8 is the gap printed tables leave above the f block.
    const r = row > 8 ? row - 2 : row - 1;
    grid.set(r * 18 + col - 1, z);
    last = Math.max(last, r);
  }
  const rows: XREditButton[][] = [];
  for (let r = 0; r <= last; r++) {
    const row: XREditButton[] = [];
    for (let c = 0; c < 18; c++) {
      const z = grid.get(r * 18 + c);
      row.push(z === undefined ? spacer(1) : elementButton(z, current));
    }
    rows.push(row);
  }
  return rows;
}

/** The actions row, before Reset and Exit. */
function actions(s: BuilderStore, ctx: BuilderXRContext): XREditButton[] {
  const editable = canEdit(s);
  const shown = shownSnapshot(s);
  const out: XREditButton[] = [
    { id: "undo", label: "Undo", enabled: s.edits.length > 0 },
    { id: "redo", label: "Redo", enabled: s.redoStack.length > 0 },
    { id: "delete", label: "Delete sel.", enabled: editable && s.selected.length > 0 },
    {
      id: "cleanup",
      label: ctx.cleaning ? "Cleaning…" : "Clean up",
      enabled: editable && !ctx.cleaning && (shown?.nAtoms ?? 0) > 0,
    },
    {
      id: "original",
      label: "Original",
      active: s.showOriginal,
      enabled: !!s.source && (s.edits.length > 0 || s.showOriginal),
    },
  ];
  if (ctx.canSave) out.push({ id: "save", label: "Save", enabled: !!s.source });
  return out;
}

/** The headset panel for the Builder's state `s`. */
export function builderXRPanel(
  s: BuilderStore,
  local: BuilderXRLocal,
  ctx: BuilderXRContext,
): XREditPanel {
  if (local.page === "table") {
    return {
      title: "Choose an element",
      summary: `Now: ${getElementSymbol(s.element)}`,
      detail: "Pinch an element: Add atom and Element use it.",
      detailLevel: "hint",
      rows: periodicTableRows(s.element),
      actions: [{ id: "page:main", label: "Back", span: 2 }, spacer(4)],
    };
  }
  const tools: XREditButton[] = TOOLS.map((t) => ({
    id: `tool:${t.value}`,
    label: t.label,
    active: s.tool === t.value,
  }));
  return {
    title: title(s, local),
    summary: summary(s),
    ...detail(s, local),
    rows: [tools, ...settingsRows(s, local, ctx)],
    actions: actions(s, ctx),
  };
}

/** Every atom of the molecules the selection touches. */
function selectedMolecules(s: BuilderStore): number[] {
  const shown = shownSnapshot(s);
  if (!shown) return s.selected;
  const out = new Set<number>();
  for (const i of s.selected) {
    if (i < 0 || i >= shown.nAtoms || out.has(i)) continue;
    for (const j of moleculeOf(shown, i)) out.add(j);
  }
  return [...out];
}

/** Every atom of an element the selection has. */
function selectedElements(s: BuilderStore): number[] {
  const shown = shownSnapshot(s);
  if (!shown) return s.selected;
  const wanted = new Set(s.selected.filter((i) => i < shown.nAtoms).map((i) => shown.elements[i]));
  return Array.from(shown.elements.keys()).filter((i) => wanted.has(shown.elements[i]));
}

/** The panel's shortcuts need no page: the headset never opens or saves through them. */
const NO_PAGE = { open: () => {}, save: () => {}, resetView: () => {} };

/**
 * The bridge for the Builder whose document is `api`: the panel and the
 * hands' presses, through the handlers the mounted app installed.
 */
export function createBuilderXREdit(
  api: StoreApi<BuilderStore>,
  deps: BuilderXRDeps,
): XREditBridge & { readonly local: BuilderXRLocal } {
  const local: BuilderXRLocal = { page: "main", libraryPage: 0, unbond: false };
  const shortcut = (kind: ShortcutAction["kind"]) =>
    runShortcut({ kind } as ShortcutAction, api, NO_PAGE);

  const press = (id: string) => {
    const s = api.getState();
    // A drag owns the document until it ends, as it owns the keys on the desktop.
    if (s.drag) return;
    const [kind, arg = ""] = id.split(/:(.*)/s);
    switch (kind) {
      case "tool":
        s.setTool(arg as BuildTool);
        return;
      case "element":
        s.setElement(Number(arg));
        local.page = "main";
        return;
      case "page":
        local.page = arg === "table" ? "table" : "main";
        return;
      case "order":
        s.setBondOrder(Number(arg));
        local.unbond = false;
        return;
      case "unbond":
        local.unbond = !local.unbond;
        return;
      case "hydrogens":
        s.setHydrogenMode(arg as HydrogenMode);
        return;
      case "select":
        if (arg === "all") shortcut("select_all");
        else if (arg === "invert") s.invertSelection();
        else if (arg === "clear") s.clearSelected();
        else if (arg === "molecule") s.setSelected(selectedMolecules(s));
        else if (arg === "element") s.setSelected(selectedElements(s));
        return;
      case "snap":
        s.setSnap(!s.snap);
        return;
      case "library": {
        const pages = Math.ceil(deps.molecules().length / XR_LIBRARY_PAGE_SIZE);
        const page = local.libraryPage + (arg === "next" ? 1 : -1);
        local.libraryPage = Math.max(0, Math.min(page, pages - 1));
        return;
      }
      case "place": {
        const molecule = deps.molecules().find((m) => m.id === arg);
        if (molecule) s.setPlaceSource(molecule);
        return;
      }
      case "adsorb":
        s.setAdsorbHeight(s.adsorbHeight === null ? DEFAULT_ADSORB_HEIGHT : null);
        return;
      case "undo":
      case "redo":
        shortcut(kind);
        return;
      case "delete":
        shortcut("delete_selected");
        return;
      case "cleanup":
        void runCleanup(api);
        return;
      case "original":
        s.setShowOriginal(!s.showOriginal);
        return;
      case "save":
        if (s.source) deps.save?.();
        return;
    }
  };

  return {
    local,
    panel: () =>
      builderXRPanel(api.getState(), local, {
        molecules: deps.molecules(),
        canSave: !!deps.save,
        cleaning: isCleanupRunning(api),
      }),
    press,
    pressAction(atom: number): XRPressAction {
      const handlers = api.getState().handlers;
      return handlers?.pressAction(atom, NO_MODS) === "move" ? "drag" : "grab";
    },
    hover(atom: number): XRHighlight | null {
      const s = api.getState();
      if (!s.source) return null;
      return hoverHighlight(atom, {
        tool: s.tool,
        editable: canEdit(s),
        pendingBondAtom: s.pendingBondAtom,
        adsorbOnAtoms: s.adsorbHeight !== null && !!s.placeSource,
        dragging: s.drag !== null,
        selected: s.selected,
      });
    },
    spaceCursor(): number | null {
      const s = api.getState();
      if (s.tool === "add" && canEdit(s)) return HOVER_COLORS.attach;
      if (s.tool === "place" && s.placeSource && (canEdit(s) || !s.source)) {
        return HOVER_COLORS.attach;
      }
      return null;
    },
    click(atom: number | null, point: [number, number, number] | null): void {
      const s = api.getState();
      const toggles = atom !== null && (s.tool === "select" || s.tool === "move");
      s.handlers?.pick({
        atomIndex: atom,
        world: point,
        shiftKey: s.tool === "bond" && local.unbond,
        mod: toggles,
      });
    },
    dragStart(atom: number): boolean {
      return api.getState().handlers?.dragStart(atom, NO_MODS) ?? false;
    },
    dragMove(motion: XRRigidMotion): void {
      const { pivot: p, rotation: q, translation: t } = motion;
      api.getState().handlers?.dragRigid({
        pivot: [p.x, p.y, p.z],
        rotation: [q.x, q.y, q.z, q.w],
        translation: [t.x, t.y, t.z],
      });
    },
    dragEnd(): void {
      api.getState().handlers?.dragEnd();
    },
  };
}
