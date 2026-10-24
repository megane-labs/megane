/**
 * XRPanel: the control panel that floats below the structure in a session.
 *
 * A headset hides the page, and with hand tracking (Quest 3 hands, XREAL)
 * there are no buttons to press either, so everything the immersive view can
 * do without the page lives here: trajectory playback (play / pause, step,
 * scrub), the measure mode, putting the structure back in front of you, and
 * leaving. It is pointed at with a controller or hand ray and pressed with
 * the trigger or a pinch (see `XRSessionController`).
 *
 * A page that edits the structure (megane Builder) hands the panel its own
 * controls instead (`XRPanelState.edit`): a status line, rows of buttons it
 * describes — tools, elements, options, a whole periodic table — and actions
 * before Reset and Exit. The panel lays them out and reports presses back as
 * `edit:<id>`; what they mean stays with the page. That panel is wider, as
 * tall as its rows need (`panelSize`), and floats a little lower.
 *
 * The panel is a canvas texture on a plane in reference space (on the XR rig),
 * {@link XR_PANEL_DISTANCE} ahead and {@link XR_PANEL_DROP} below the eyes. It
 * stays where it is while you look around and glides back in front of you
 * once you turn or walk away from it (`panelOutOfReach`). Layout, hit-testing
 * and drawing are plain functions of the panel's state so they can be tested
 * without a headset.
 */

import * as THREE from "three";
import {
  panelOutOfReach,
  panelPose,
  rayHitsPanel,
  XR_EDIT_PANEL_PLACEMENT,
  XR_PANEL_FOLLOW_RATE,
  XR_PANEL_PLACEMENT,
} from "./xrMath";
import { createCanvas, roundedRect, XR_FONT_FAMILY } from "./xrText";

/** The panel's controls; a page's own buttons are `edit:<id>` (see `XREditPanel`). */
export type XRPanelControl =
  | "prev"
  | "play"
  | "next"
  | "scrub"
  | "measure"
  | "clear"
  | "reset"
  | "exit"
  | `edit:${string}`;

/** One of a page's buttons on the editing panel. */
export interface XREditButton {
  /** Reported back on a press; unique on the panel. */
  id: string;
  label: string;
  /** Drawn switched on: the current tool, element, option. */
  active?: boolean;
  /** False draws it dimmed and ignores presses (default true). */
  enabled?: boolean;
  /** Width relative to the others in its row (default 1). */
  span?: number;
  /** A colour bar along the bottom (CSS colour): an element's colour. */
  swatch?: string;
  /** No button, just `span` of empty room: aligns a grid (the periodic table). */
  spacer?: boolean;
}

/** What a page that edits the structure puts on the panel. */
export interface XREditPanel {
  /** The status line: what the next press does (the tool and its settings). */
  title: string;
  /** Right of the title: what is open, what is selected. */
  summary?: string;
  /** The line under it: a hint, a notice, a drag's readout. */
  detail?: string;
  /** How `detail` reads: dim (a hint), plain (info) or red (an error). */
  detailLevel?: "hint" | "info" | "error";
  /** Rows of buttons, top to bottom. */
  rows: XREditButton[][];
  /** The bottom row's buttons, before the panel's own Reset and Exit. */
  actions: XREditButton[];
}

/** What the panel shows. */
export interface XRPanelState {
  /** Trajectory playback; null when there is nothing to play. */
  playback: { frame: number; total: number; playing: boolean } | null;
  /** The measure mode; null where the page offers no measurement. */
  measure: { active: boolean; hasSelection: boolean; label: string | null } | null;
  /**
   * A page's editing controls (megane Builder): when set, the panel shows
   * these and its Reset / Exit instead of playback and measuring.
   */
  edit?: XREditPanel | null;
}

/** A control's rectangle on the panel canvas (pixels). */
export interface XRPanelRect {
  id: XRPanelControl;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
  /** The button it draws (editing panel only; Reset and Exit have stand-ins). */
  button?: XREditButton;
}

/** The panel's size in metres and canvas pixels. */
export interface XRPanelSize {
  width: number;
  height: number;
  pxWidth: number;
  pxHeight: number;
}

/** A ray on a control: `fraction` is how far along the scrub bar (0–1). */
export interface XRPanelHit {
  id: XRPanelControl;
  fraction: number;
  distance: number;
}

/** Canvas pixels per metre of panel. */
export const XR_PANEL_PX_PER_M = 2560;
/** Panel size in metres and in canvas pixels (2560 px/m). */
export const XR_PANEL_WIDTH = 0.3;
export const XR_PANEL_HEIGHT = 0.15;
export const XR_PANEL_PX_WIDTH = 768;
export const XR_PANEL_PX_HEIGHT = 384;
/** The viewer's panel. */
export const XR_PANEL_COMPACT: XRPanelSize = {
  width: XR_PANEL_WIDTH,
  height: XR_PANEL_HEIGHT,
  pxWidth: XR_PANEL_PX_WIDTH,
  pxHeight: XR_PANEL_PX_HEIGHT,
};
/** Width of the editing panel (canvas pixels): 45 cm. */
export const XR_EDIT_PANEL_PX_WIDTH = 1152;

const MARGIN = 24;
const GAP = 16;
const STATUS_Y = 46;
const PLAYBACK_Y = 92;
const PLAYBACK_H = 96;
const ACTION_Y = 220;
const ACTION_H = XR_PANEL_PX_HEIGHT - MARGIN - ACTION_Y;

// The editing panel: the status block, then the page's rows, then the
// actions. Up to EDIT_ROOMY_ROWS rows get large buttons; more (the periodic
// table) get a tighter grid.
const EDIT_TITLE_Y = 40;
const EDIT_DETAIL_Y = 80;
const EDIT_ROWS_Y = 108;
const EDIT_ROOMY_ROWS = 4;
const EDIT_ROW_H = 84;
const EDIT_ROW_GAP = 12;
const EDIT_GRID_ROW_H = 56;
const EDIT_GRID_GAP = 6;
const EDIT_ACTION_GAP = 20;
const EDIT_ACTION_H = 84;
/** Smallest a button label shrinks to before it is cut short (px). */
const MIN_LABEL_PX = 16;

const COLORS = {
  panel: "rgba(15, 23, 42, 0.88)",
  button: "#334155",
  hover: "#475569",
  pressed: "#1e40af",
  active: "#2563eb",
  disabled: "#1e293b",
  text: "#f8fafc",
  dimText: "#64748b",
  hintText: "#94a3b8",
  error: "#f87171",
  track: "#475569",
  fill: "#3b82f6",
};

/** The panel's own Reset and Exit, as buttons of the editing panel's bottom row. */
const RESET_BUTTON: XREditButton = { id: "reset", label: "Reset" };
const EXIT_BUTTON: XREditButton = { id: "exit", label: "Exit" };

/** Row height and gap of an editing panel with `rows` rows of buttons. */
function editRowMetrics(rows: number): { h: number; gap: number } {
  return rows > EDIT_ROOMY_ROWS
    ? { h: EDIT_GRID_ROW_H, gap: EDIT_GRID_GAP }
    : { h: EDIT_ROW_H, gap: EDIT_ROW_GAP };
}

/** Canvas height of an editing panel with `rows` rows above its actions. */
function editPanelPxHeight(rows: number): number {
  const { h, gap } = editRowMetrics(rows);
  const content = rows > 0 ? rows * h + (rows - 1) * gap + EDIT_ACTION_GAP : 0;
  return EDIT_ROWS_Y + content + EDIT_ACTION_H + MARGIN;
}

/** The panel's size for `state`: the viewer's, or as tall as the page's rows need. */
export function panelSize(state: XRPanelState): XRPanelSize {
  if (!state.edit) return XR_PANEL_COMPACT;
  const pxHeight = editPanelPxHeight(state.edit.rows.length);
  return {
    width: XR_EDIT_PANEL_PX_WIDTH / XR_PANEL_PX_PER_M,
    height: pxHeight / XR_PANEL_PX_PER_M,
    pxWidth: XR_EDIT_PANEL_PX_WIDTH,
    pxHeight,
  };
}

/** Lay `buttons` out across the editing panel at height `y`, sharing the width by span. */
function layoutEditRow(
  buttons: readonly XREditButton[],
  y: number,
  h: number,
  gap: number,
  rects: XRPanelRect[],
): void {
  const spans = buttons.reduce((sum, b) => sum + (b.span ?? 1), 0);
  if (spans <= 0) return;
  // Each unit of span is one cell plus the gap after it, so spans line up
  // from row to row (the periodic table's columns).
  const unit = (XR_EDIT_PANEL_PX_WIDTH - 2 * MARGIN + gap) / spans;
  let x = MARGIN;
  for (const button of buttons) {
    const w = unit * (button.span ?? 1) - gap;
    if (!button.spacer) {
      const id: XRPanelControl =
        button === RESET_BUTTON || button === EXIT_BUTTON
          ? (button.id as XRPanelControl)
          : `edit:${button.id}`;
      rects.push({ id, x, y, w, h, enabled: button.enabled ?? true, button });
    }
    x += w + gap;
  }
}

/** The editing panel's controls: the page's rows, then its actions with Reset and Exit. */
function layoutEditPanel(edit: XREditPanel): XRPanelRect[] {
  const rects: XRPanelRect[] = [];
  const { h, gap } = editRowMetrics(edit.rows.length);
  edit.rows.forEach((row, i) => layoutEditRow(row, EDIT_ROWS_Y + i * (h + gap), h, gap, rects));
  const actionY = editPanelPxHeight(edit.rows.length) - MARGIN - EDIT_ACTION_H;
  layoutEditRow(
    [...edit.actions, RESET_BUTTON, EXIT_BUTTON],
    actionY,
    EDIT_ACTION_H,
    EDIT_ROW_GAP,
    rects,
  );
  return rects;
}

/** Where each control sits for `state`; controls the state cannot use are left out. */
export function layoutPanel(state: XRPanelState): XRPanelRect[] {
  if (state.edit) return layoutEditPanel(state.edit);
  const rects: XRPanelRect[] = [];
  if (state.playback) {
    const canStep = state.playback.total > 1;
    let x = MARGIN;
    for (const id of ["prev", "play", "next"] as const) {
      rects.push({ id, x, y: PLAYBACK_Y, w: PLAYBACK_H, h: PLAYBACK_H, enabled: canStep });
      x += PLAYBACK_H + GAP;
    }
    rects.push({
      id: "scrub",
      x: x + GAP,
      y: PLAYBACK_Y,
      w: XR_PANEL_PX_WIDTH - MARGIN - x - GAP,
      h: PLAYBACK_H,
      enabled: canStep,
    });
  }
  const actions: { id: XRPanelControl; enabled: boolean }[] = [];
  if (state.measure) {
    actions.push({ id: "measure", enabled: true });
    actions.push({ id: "clear", enabled: state.measure.hasSelection });
  }
  actions.push({ id: "reset", enabled: true }, { id: "exit", enabled: true });
  const w = (XR_PANEL_PX_WIDTH - 2 * MARGIN - GAP * (actions.length - 1)) / actions.length;
  actions.forEach(({ id, enabled }, i) => {
    rects.push({ id, x: MARGIN + i * (w + GAP), y: ACTION_Y, w, h: ACTION_H, enabled });
  });
  return rects;
}

/**
 * The enabled control under panel coordinates `u` / `v` (0–1 from the top
 * left) of a panel of `size`, or null. With `grabbed` set, only that control
 * answers and its fraction follows `u` even past its edges — a scrub drag
 * that slides off the bar keeps scrubbing.
 */
export function hitControl(
  rects: readonly XRPanelRect[],
  u: number,
  v: number,
  grabbed: XRPanelControl | null = null,
  size: XRPanelSize = XR_PANEL_COMPACT,
): Omit<XRPanelHit, "distance"> | null {
  const x = u * size.pxWidth;
  const y = v * size.pxHeight;
  for (const r of rects) {
    if (!r.enabled) continue;
    const fraction = Math.min(1, Math.max(0, (x - r.x) / r.w));
    if (grabbed !== null) {
      if (r.id === grabbed) return { id: r.id, fraction };
      continue;
    }
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { id: r.id, fraction };
  }
  return null;
}

/** The trajectory frame a scrub `fraction` points at. */
export function scrubFrame(fraction: number, total: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * Math.max(0, total - 1));
}

const ACTION_LABEL: Partial<Record<XRPanelControl, string>> = {
  measure: "Measure",
  clear: "Clear",
  reset: "Reset",
  exit: "Exit",
};

function drawIcon(
  ctx: CanvasRenderingContext2D,
  id: XRPanelControl,
  r: XRPanelRect,
  playing: boolean,
): void {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const s = r.h * 0.2;
  ctx.beginPath();
  if (id === "play" && playing) {
    ctx.rect(cx - s, cy - s, s * 0.7, s * 2);
    ctx.rect(cx + s * 0.3, cy - s, s * 0.7, s * 2);
  } else if (id === "play") {
    ctx.moveTo(cx - s * 0.7, cy - s);
    ctx.lineTo(cx + s, cy);
    ctx.lineTo(cx - s * 0.7, cy + s);
    ctx.closePath();
  } else {
    // Step: a bar on the side it steps toward, and a triangle pointing there.
    const dir = id === "next" ? 1 : -1;
    ctx.moveTo(cx - dir * s * 0.8, cy - s);
    ctx.lineTo(cx + dir * s * 0.5, cy);
    ctx.lineTo(cx - dir * s * 0.8, cy + s);
    ctx.closePath();
    ctx.rect(dir > 0 ? cx + s * 0.55 : cx - s * 0.85, cy - s, s * 0.3, s * 2);
  }
  ctx.fill();
}

/** `text`, cut short with an ellipsis where it would run past `maxWidth` px. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** The fill of a button: dimmed, pressed, switched on, hovered or plain. */
function buttonFill(enabled: boolean, pressed: boolean, active: boolean, hovered: boolean): string {
  if (!enabled) return COLORS.disabled;
  if (pressed) return COLORS.pressed;
  if (active) return COLORS.active;
  return hovered ? COLORS.hover : COLORS.button;
}

/** Draw the editing panel: the page's status block and buttons. */
function drawEditPanel(
  ctx: CanvasRenderingContext2D,
  edit: XREditPanel,
  rects: readonly XRPanelRect[],
  hovered: ReadonlySet<XRPanelControl>,
  pressed: ReadonlySet<XRPanelControl>,
): void {
  const width = XR_EDIT_PANEL_PX_WIDTH;
  const inner = width - 2 * MARGIN;
  ctx.textBaseline = "middle";
  ctx.font = `400 26px ${XR_FONT_FAMILY}`;
  const summary = edit.summary ? fitText(ctx, edit.summary, inner * 0.4) : "";
  const summaryWidth = summary ? ctx.measureText(summary).width + GAP : 0;
  if (summary) {
    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.hintText;
    ctx.fillText(summary, width - MARGIN, EDIT_TITLE_Y);
  }
  ctx.textAlign = "left";
  ctx.font = `600 30px ${XR_FONT_FAMILY}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText(fitText(ctx, edit.title, inner - summaryWidth), MARGIN, EDIT_TITLE_Y);
  if (edit.detail) {
    ctx.font = `400 24px ${XR_FONT_FAMILY}`;
    ctx.fillStyle =
      edit.detailLevel === "error"
        ? COLORS.error
        : edit.detailLevel === "info"
          ? COLORS.text
          : COLORS.hintText;
    ctx.fillText(fitText(ctx, edit.detail, inner), MARGIN, EDIT_DETAIL_Y);
  }

  for (const r of rects) {
    const button = r.button!;
    ctx.fillStyle = buttonFill(r.enabled, pressed.has(r.id), !!button.active, hovered.has(r.id));
    roundedRect(ctx, r.x, r.y, r.w, r.h, Math.min(18, r.h / 4));
    ctx.fill();
    if (button.swatch) {
      ctx.fillStyle = button.swatch;
      roundedRect(ctx, r.x + 8, r.y + r.h - 12, r.w - 16, 6, 3);
      ctx.fill();
    }
    // The label at up to 26 px (less on a short grid row), shrunk to fit
    // the button before it is cut short.
    const room = r.w - 12;
    let fontPx = Math.min(26, Math.floor(r.h * 0.42));
    ctx.font = `600 ${fontPx}px ${XR_FONT_FAMILY}`;
    while (fontPx > MIN_LABEL_PX && ctx.measureText(button.label).width > room) {
      fontPx -= 2;
      ctx.font = `600 ${fontPx}px ${XR_FONT_FAMILY}`;
    }
    ctx.fillStyle = r.enabled ? COLORS.text : COLORS.dimText;
    ctx.textAlign = "center";
    ctx.fillText(fitText(ctx, button.label, room), r.x + r.w / 2, r.y + r.h / 2);
  }
}

/** Draw the panel for `state` with `hovered` / `pressed` controls highlighted. */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  state: XRPanelState,
  rects: readonly XRPanelRect[],
  hovered: ReadonlySet<XRPanelControl>,
  pressed: ReadonlySet<XRPanelControl>,
): void {
  const size = panelSize(state);
  ctx.clearRect(0, 0, size.pxWidth, size.pxHeight);
  ctx.fillStyle = COLORS.panel;
  roundedRect(ctx, 0, 0, size.pxWidth, size.pxHeight, 32);
  ctx.fill();
  if (state.edit) {
    drawEditPanel(ctx, state.edit, rects, hovered, pressed);
    return;
  }

  ctx.textBaseline = "middle";
  ctx.font = `600 30px ${XR_FONT_FAMILY}`;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "left";
  const { playback, measure } = state;
  ctx.fillText(
    playback ? `Frame ${playback.frame + 1} / ${playback.total}` : "Megane",
    MARGIN,
    STATUS_Y,
  );
  const status = measure?.label ?? (measure?.active ? "Point at an atom, then pinch" : "");
  if (status) {
    ctx.textAlign = "right";
    ctx.fillStyle = measure?.label ? COLORS.text : COLORS.dimText;
    ctx.fillText(status, XR_PANEL_PX_WIDTH - MARGIN, STATUS_Y);
  }
  if (!playback) {
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.dimText;
    ctx.fillText("No trajectory to play", MARGIN, PLAYBACK_Y + PLAYBACK_H / 2);
  }

  for (const r of rects) {
    const textColor = r.enabled ? COLORS.text : COLORS.dimText;
    if (r.id === "scrub") {
      const total = playback?.total ?? 1;
      const fraction = total > 1 ? (playback?.frame ?? 0) / (total - 1) : 0;
      const cy = r.y + r.h / 2;
      ctx.fillStyle = COLORS.track;
      roundedRect(ctx, r.x, cy - 6, r.w, 12, 6);
      ctx.fill();
      ctx.fillStyle = COLORS.fill;
      roundedRect(ctx, r.x, cy - 6, Math.max(12, r.w * fraction), 12, 6);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = hovered.has("scrub") || pressed.has("scrub") ? COLORS.fill : textColor;
      ctx.arc(r.x + r.w * fraction, cy, pressed.has("scrub") ? 22 : 18, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const active =
      (r.id === "measure" && measure?.active) || (r.id === "play" && playback?.playing);
    ctx.fillStyle = buttonFill(r.enabled, pressed.has(r.id), !!active, hovered.has(r.id));
    roundedRect(ctx, r.x, r.y, r.w, r.h, 20);
    ctx.fill();
    ctx.fillStyle = textColor;
    const label = ACTION_LABEL[r.id];
    if (label) {
      ctx.textAlign = "center";
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
    } else {
      drawIcon(ctx, r.id, r, playback?.playing ?? false);
    }
  }
}

const _q = new THREE.Quaternion();
const _normal = new THREE.Vector3();

export class XRPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: THREE.CanvasTexture;
  private state: XRPanelState = { playback: null, measure: null };
  private rects: XRPanelRect[] = layoutPanel(this.state);
  /** The canvas and plane's size now (see `panelSize`). */
  private size: XRPanelSize = XR_PANEL_COMPACT;
  private hovered = new Set<XRPanelControl>();
  private pressed = new Set<XRPanelControl>();
  /** What the canvas shows now; redrawn only when this changes. */
  private drawnKey = "";
  private placed = false;
  private following = false;

  constructor() {
    const { canvas, ctx } = createCanvas(XR_PANEL_PX_WIDTH, XR_PANEL_PX_HEIGHT);
    this.canvas = canvas;
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(XR_PANEL_WIDTH, XR_PANEL_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        // Always readable, even when a large structure reaches past it.
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.mesh.name = "megane-xr-panel";
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
  }

  /** The controls on the panel now (for the E2E probe). */
  get controls(): XRPanelControl[] {
    return this.rects.filter((r) => r.enabled).map((r) => r.id);
  }

  /** Whether the panel shows a page's editing controls. */
  get editing(): boolean {
    return !!this.state.edit;
  }

  /** Show `state`, highlighting the controls the rays hover and press. */
  update(
    state: XRPanelState,
    hovered: Iterable<XRPanelControl>,
    pressed: Iterable<XRPanelControl>,
  ): void {
    // The editing panel floats elsewhere: put it in front again.
    if (!!state.edit !== this.editing) this.placed = false;
    this.state = state;
    this.rects = layoutPanel(state);
    this.resize(panelSize(state));
    this.hovered = new Set(hovered);
    this.pressed = new Set(pressed);
    const key = JSON.stringify([state, [...this.hovered], [...this.pressed]]);
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    if (this.ctx) drawPanel(this.ctx, state, this.rects, this.hovered, this.pressed);
    this.texture.needsUpdate = true;
  }

  /**
   * Resize the canvas and the plane to `size`. The texture is let go so three
   * allocates one of the new size: it cannot grow one in place.
   */
  private resize(size: XRPanelSize): void {
    const now = this.size;
    if (size.pxWidth === now.pxWidth && size.pxHeight === now.pxHeight) return;
    this.size = size;
    this.canvas.width = size.pxWidth;
    this.canvas.height = size.pxHeight;
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(size.width, size.height);
    this.drawnKey = "";
  }

  /**
   * The control `ray` (rig space) points at, or null. With `grabbed`, only
   * that control answers, even with the ray past its edge (a scrub drag).
   */
  hit(ray: THREE.Ray, grabbed: XRPanelControl | null = null): XRPanelHit | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateMatrix();
    const { width, height } = this.size;
    const at = rayHitsPanel(ray, this.mesh.matrix, width, height, grabbed === null);
    if (!at) return null;
    const control = hitControl(this.rects, at.u, at.v, grabbed, this.size);
    return control ? { ...control, distance: at.distance } : null;
  }

  /** Whether `ray` lands anywhere on the panel (controls or not). */
  covers(ray: THREE.Ray): number | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateMatrix();
    const { width, height } = this.size;
    return rayHitsPanel(ray, this.mesh.matrix, width, height)?.distance ?? null;
  }

  /**
   * Keep the panel in reach of a head at `head` / `headQuaternion` (rig
   * space): placed in front on the first call or with `snap`, then left alone
   * until it falls out of reach, when it glides back over a fraction of a
   * second. `hold` (a hand is using it) keeps it still.
   */
  follow(
    head: THREE.Vector3,
    headQuaternion: THREE.Quaternion,
    dt: number,
    snap = false,
    hold = false,
  ): void {
    const placement = this.editing ? XR_EDIT_PANEL_PLACEMENT : XR_PANEL_PLACEMENT;
    const target = panelPose(head, headQuaternion, placement);
    if (!this.placed || snap) {
      this.mesh.position.copy(target.position);
      this.mesh.quaternion.copy(target.quaternion);
      this.mesh.visible = true;
      this.placed = true;
      this.following = false;
      return;
    }
    if (hold) return;
    if (!this.following && panelOutOfReach(this.mesh.position, head, headQuaternion, placement)) {
      this.following = true;
    }
    if (!this.following) return;
    const k = 1 - Math.exp(-XR_PANEL_FOLLOW_RATE * dt);
    this.mesh.position.lerp(target.position, k);
    this.mesh.quaternion.slerp(target.quaternion, k);
    if (this.mesh.position.distanceTo(target.position) < 0.01) this.following = false;
  }

  /** Forget the placement: the next {@link follow} puts the panel in front again. */
  reset(): void {
    this.placed = false;
    this.following = false;
    this.mesh.visible = false;
    this.hovered.clear();
    this.pressed.clear();
  }

  /**
   * A pose 15 cm in front of control `id`, aimed at its centre: where an
   * emulated controller has to be to press it (the E2E probe). Null when the
   * panel is hidden or the control is absent.
   */
  controlPose(
    id: XRPanelControl,
  ): { position: THREE.Vector3; quaternion: THREE.Quaternion } | null {
    const r = this.rects.find((rect) => rect.id === id);
    if (!r || !this.mesh.visible) return null;
    this.mesh.updateMatrix();
    const { width, height, pxWidth, pxHeight } = this.size;
    const local = new THREE.Vector3(
      ((r.x + r.w / 2) / pxWidth - 0.5) * width,
      (0.5 - (r.y + r.h / 2) / pxHeight) * height,
      0,
    ).applyMatrix4(this.mesh.matrix);
    _q.copy(this.mesh.quaternion);
    _normal.set(0, 0, 1).applyQuaternion(_q);
    return { position: local.addScaledVector(_normal, 0.15), quaternion: _q.clone() };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
    this.canvas.width = 0;
  }
}
