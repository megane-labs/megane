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
 * The panel is a canvas texture on a plane in reference space (on the XR rig),
 * {@link XR_PANEL_DISTANCE} ahead and {@link XR_PANEL_DROP} below the eyes. It
 * stays where it is while you look around and glides back in front of you
 * once you turn or walk away from it (`panelOutOfReach`). Layout, hit-testing
 * and drawing are plain functions of the panel's state so they can be tested
 * without a headset.
 */

import * as THREE from "three";
import { panelOutOfReach, panelPose, rayHitsPanel, XR_PANEL_FOLLOW_RATE } from "./xrMath";
import { createCanvas, roundedRect, XR_FONT_FAMILY } from "./xrText";

/** The panel's controls. */
export type XRPanelControl =
  | "prev"
  | "play"
  | "next"
  | "scrub"
  | "measure"
  | "clear"
  | "reset"
  | "exit";

/** What the panel shows. */
export interface XRPanelState {
  /** Trajectory playback; null when there is nothing to play. */
  playback: { frame: number; total: number; playing: boolean } | null;
  /** The measure mode; null where the page offers no measurement. */
  measure: { active: boolean; hasSelection: boolean; label: string | null } | null;
}

/** A control's rectangle on the panel canvas (pixels). */
export interface XRPanelRect {
  id: XRPanelControl;
  x: number;
  y: number;
  w: number;
  h: number;
  enabled: boolean;
}

/** A ray on a control: `fraction` is how far along the scrub bar (0–1). */
export interface XRPanelHit {
  id: XRPanelControl;
  fraction: number;
  distance: number;
}

/** Panel size in metres and in canvas pixels (2560 px/m). */
export const XR_PANEL_WIDTH = 0.3;
export const XR_PANEL_HEIGHT = 0.15;
export const XR_PANEL_PX_WIDTH = 768;
export const XR_PANEL_PX_HEIGHT = 384;

const MARGIN = 24;
const GAP = 16;
const STATUS_Y = 46;
const PLAYBACK_Y = 92;
const PLAYBACK_H = 96;
const ACTION_Y = 220;
const ACTION_H = XR_PANEL_PX_HEIGHT - MARGIN - ACTION_Y;

const COLORS = {
  panel: "rgba(15, 23, 42, 0.88)",
  button: "#334155",
  hover: "#475569",
  pressed: "#1e40af",
  active: "#2563eb",
  disabled: "#1e293b",
  text: "#f8fafc",
  dimText: "#64748b",
  track: "#475569",
  fill: "#3b82f6",
};

/** Where each control sits for `state`; controls the state cannot use are left out. */
export function layoutPanel(state: XRPanelState): XRPanelRect[] {
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
 * left), or null. With `grabbed` set, only that control answers and its
 * fraction follows `u` even past its edges — a scrub drag that slides off the
 * bar keeps scrubbing.
 */
export function hitControl(
  rects: readonly XRPanelRect[],
  u: number,
  v: number,
  grabbed: XRPanelControl | null = null,
): Omit<XRPanelHit, "distance"> | null {
  const x = u * XR_PANEL_PX_WIDTH;
  const y = v * XR_PANEL_PX_HEIGHT;
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

/** Draw the panel for `state` with `hovered` / `pressed` controls highlighted. */
export function drawPanel(
  ctx: CanvasRenderingContext2D,
  state: XRPanelState,
  rects: readonly XRPanelRect[],
  hovered: ReadonlySet<XRPanelControl>,
  pressed: ReadonlySet<XRPanelControl>,
): void {
  ctx.clearRect(0, 0, XR_PANEL_PX_WIDTH, XR_PANEL_PX_HEIGHT);
  ctx.fillStyle = COLORS.panel;
  roundedRect(ctx, 0, 0, XR_PANEL_PX_WIDTH, XR_PANEL_PX_HEIGHT, 32);
  ctx.fill();

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
    ctx.fillStyle = !r.enabled
      ? COLORS.disabled
      : pressed.has(r.id)
        ? COLORS.pressed
        : active
          ? COLORS.active
          : hovered.has(r.id)
            ? COLORS.hover
            : COLORS.button;
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

  /** Show `state`, highlighting the controls the rays hover and press. */
  update(
    state: XRPanelState,
    hovered: Iterable<XRPanelControl>,
    pressed: Iterable<XRPanelControl>,
  ): void {
    this.state = state;
    this.rects = layoutPanel(state);
    this.hovered = new Set(hovered);
    this.pressed = new Set(pressed);
    const key = JSON.stringify([state, [...this.hovered], [...this.pressed]]);
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    if (this.ctx) drawPanel(this.ctx, state, this.rects, this.hovered, this.pressed);
    this.texture.needsUpdate = true;
  }

  /**
   * The control `ray` (rig space) points at, or null. With `grabbed`, only
   * that control answers, even with the ray past its edge (a scrub drag).
   */
  hit(ray: THREE.Ray, grabbed: XRPanelControl | null = null): XRPanelHit | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateMatrix();
    const at = rayHitsPanel(
      ray,
      this.mesh.matrix,
      XR_PANEL_WIDTH,
      XR_PANEL_HEIGHT,
      grabbed === null,
    );
    if (!at) return null;
    const control = hitControl(this.rects, at.u, at.v, grabbed);
    return control ? { ...control, distance: at.distance } : null;
  }

  /** Whether `ray` lands anywhere on the panel (controls or not). */
  covers(ray: THREE.Ray): number | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateMatrix();
    return rayHitsPanel(ray, this.mesh.matrix, XR_PANEL_WIDTH, XR_PANEL_HEIGHT)?.distance ?? null;
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
    const target = panelPose(head, headQuaternion);
    if (!this.placed || snap) {
      this.mesh.position.copy(target.position);
      this.mesh.quaternion.copy(target.quaternion);
      this.mesh.visible = true;
      this.placed = true;
      this.following = false;
      return;
    }
    if (hold) return;
    if (!this.following && panelOutOfReach(this.mesh.position, head, headQuaternion)) {
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
    const local = new THREE.Vector3(
      ((r.x + r.w / 2) / XR_PANEL_PX_WIDTH - 0.5) * XR_PANEL_WIDTH,
      (0.5 - (r.y + r.h / 2) / XR_PANEL_PX_HEIGHT) * XR_PANEL_HEIGHT,
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
