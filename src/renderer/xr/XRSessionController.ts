/**
 * XRSessionController: runs the viewer inside an immersive WebXR session
 * (Quest Browser, Chrome + an OpenXR runtime, visionOS Safari).
 *
 * three.js does the stereo rendering (`renderer.xr`); this class owns what is
 * specific to megane:
 *
 * - the session lifecycle — entering from a button click, handing the frame
 *   loop from the desktop `requestAnimationFrame` loop to the session's, and
 *   restoring the desktop view when the session ends (from our Exit button or
 *   the headset's system menu);
 * - placing the structure in the room: the scene's own transform (`model`,
 *   Å → metres) puts it at arm's length, the same side up as the desktop view
 *   (see `computeXRPlacement`);
 * - the gestures that move it: grab with one controller or pinching hand to
 *   carry and turn it, with both to scale it, thumbsticks to zoom and spin,
 *   A / X to put it back in front of you;
 * - what replaces the page while it is hidden, usable with hands alone (Quest
 *   hand tracking, XREAL): the control panel (`XRPanel` — playback, measure
 *   mode, reset, exit), pointed at with the controller or hand ray and
 *   pressed with the trigger or a pinch; in measure mode the same ray picks
 *   atoms for the page's measurement; atom labels and the measurement readout
 *   as sprites (`xrLabels`); B / Y toggles playback;
 * - lighting the meshes from the viewer's side (`XRHeadLights`);
 * - small markers and pointing rays on the controllers, kept in reference
 *   space by a rig whose matrix undoes the scene's transform.
 *
 * A press (trigger or pinch) acts on what the ray points at — a panel
 * control, then (in measure mode) an atom — and grabs the structure only
 * when it points at neither; the grip always grabs.
 *
 * Nothing here runs outside a session, so the desktop view is untouched.
 */

import * as THREE from "three";
import type { Measurement } from "../../types";
import type { RayAtomHit } from "../Picking";
import { XRMeasureLabel, XRAtomLabels, type XRLabelSource } from "./xrLabels";
import { XRHeadLights } from "./xrLights";
import { XRPanel, scrubFrame, type XRPanelControl, type XRPanelState } from "./XRPanel";
import {
  computeXRPlacement,
  depthCueRange,
  modelScale,
  oneHandGrab,
  rayFromPose,
  stickSteer,
  twoHandGrab,
  XR_DEPTH_CUE_STRENGTH,
  XR_NEAR_CLIP,
  XR_NEAR_FADE,
  XR_PICK_MIN_RADIUS,
  type XRFocus,
} from "./xrMath";
import { getXRSystem, type MeganeXRMode } from "./xrSupport";

/** What the controller reads from (and tells) the renderer that owns it. */
export interface XRHost {
  getRenderer(): THREE.WebGLRenderer;
  getScene(): THREE.Scene;
  /** The desktop camera; its orientation seeds the placement. */
  getViewCamera(): THREE.Camera;
  /** Bounding sphere (Å) of the structure to place. */
  getFocus(): XRFocus;
  /** The session started (true) or ended (false). */
  onPresentingChange(presenting: boolean): void;
  /** The drawn atom `ray` (structure space, Å) points at, each picked at ≥ `minRadius` Å. */
  pickAtom(ray: THREE.Ray, minRadius: number): RayAtomHit | null;
  /** Mark atoms with the hover highlight; null clears it. */
  setHoverAtoms(atoms: number[] | null): void;
  /** The atoms selected for measuring, in order. */
  getSelectedAtoms(): readonly number[];
  /** The measurement of those atoms, once there are two or more. */
  getMeasurement(): Measurement | null;
  /** Write atom `index`'s current position (Å) to `out`; false when there is none. */
  getAtomPosition(index: number, out: THREE.Vector3): boolean;
  /** The per-atom labels on screen, if any. */
  getLabels(): XRLabelSource | null;
}

/** Trajectory playback as the page shows it. */
export interface XRPlaybackState {
  /** Current frame (0-based). */
  frame: number;
  total: number;
  playing: boolean;
}

/**
 * What the page lets the headset drive, so its own state (timeline,
 * Measurement panel) follows. Without it the panel offers neither playback
 * nor the measure mode (megane Builder).
 */
export interface XRBridge {
  playback?: {
    getState(): XRPlaybackState;
    togglePlay(): void;
    seek(frame: number): void;
  };
  measure?: {
    /** Add atom `index` to the measurement selection, or take it out. */
    toggleAtom(index: number): void;
    clear(): void;
  };
}

/** Session state for the UI and the E2E probe. */
export interface MeganeXRState {
  presenting: boolean;
  mode: MeganeXRMode | null;
  /** Frames drawn in the current (or last) session. */
  frames: number;
  /** Model scale, metres per Å. */
  scale: number;
  /** Where the model's origin sits in reference space (m). */
  position: [number, number, number];
  /** Controls the panel offers right now (empty outside a session). */
  panel: XRPanelControl[];
  /** Whether presses pick atoms to measure. */
  measuring: boolean;
  /** Atom labels on display. */
  labels: number;
}

/** Uniform the impostor shaders read to ray-cast exactly (see `shaders.ts`). */
export const EXACT_IMPOSTOR_UNIFORM = "uExactImpostor";

/** The immersive-only shading of the impostors (see `xrFinish` in `shaders.ts`). */
export interface XRShading {
  /** Depth-cue ramp, metres from the eye. */
  fogStart: number;
  fogEnd: number;
  /** How far toward `fogColor` the far end fades (0 = off). */
  fogStrength: number;
  fogColor: THREE.Color;
  /** 2 / per-eye viewport height in pixels: sizes the edge ramp's fringe. */
  pixel: number;
  /** Per-eye viewport size in pixels: what fat lines measure their width in. */
  eye: THREE.Vector2;
}

const BLACK = new THREE.Color(0x000000);
/** Per-eye viewport size assumed before three reports one (Quest 3 class). */
const DEFAULT_EYE_WIDTH = 1700;
const DEFAULT_EYE_HEIGHT = 1800;

/** xr-standard gamepad indices. */
const THUMBSTICK_X = 2;
const THUMBSTICK_Y = 3;
const BUTTON_RECENTER = 4; // A on the right controller, X on the left
const BUTTON_PLAY = 5; // B on the right controller, Y on the left

const MARKER_IDLE = 0x9aa4b2;
const MARKER_GRAB = 0xf59e0b;
const RAY_COLOR = 0xe2e8f0;
const RAY_ATOM_COLOR = 0x60a5fa;

/**
 * Switch every impostor material under `root` between the desktop shading
 * (`null`) and the immersive one: the exact perspective ray-cast, the near
 * fade, the depth cue, and alpha-to-coverage, which turns the shaders' edge
 * alpha into smooth silhouettes on the headset's multisampled buffer.
 * Transparent (blended) materials smooth their edges through blending
 * instead, so they keep alpha-to-coverage off.
 */
export function applyXRShading(root: THREE.Object3D, shading: XRShading | null): void {
  root.traverse((obj) => {
    const material = (obj as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    // Fat lines (polyhedron edges) size themselves by the viewport they are
    // drawn into; the desktop loop sets the canvas size back every frame.
    const line = material as
      | (THREE.Material & { isLineMaterial?: boolean; resolution?: THREE.Vector2 })
      | undefined;
    if (shading && line?.isLineMaterial) line.resolution?.copy(shading.eye);
    const uniforms = material?.uniforms;
    if (!material || !uniforms?.[EXACT_IMPOSTOR_UNIFORM]) return;
    uniforms[EXACT_IMPOSTOR_UNIFORM].value = shading ? 1 : 0;
    material.alphaToCoverage = shading !== null && !material.transparent;
    if (!shading) return;
    if (uniforms.uXRPixel) uniforms.uXRPixel.value = shading.pixel;
    uniforms.uXRNear?.value.set(XR_NEAR_CLIP, XR_NEAR_FADE);
    uniforms.uXRFog?.value.set(shading.fogStart, shading.fogEnd, shading.fogStrength);
    uniforms.uXRFogColor?.value.set(shading.fogColor.r, shading.fogColor.g, shading.fogColor.b);
  });
}

interface Hand {
  space: THREE.XRTargetRaySpace;
  source: XRInputSource | null;
  /** A select (trigger / pinch) press that grabs: it pointed at nothing. */
  selecting: boolean;
  /** A squeeze (grip) press: always grabs. */
  squeezing: boolean;
  /**
   * What the held select press acts on instead of grabbing: a panel control,
   * the panel's background, or an atom (already toggled).
   */
  press: XRPanelControl | "panel" | "atom" | null;
  /** The panel control the ray points at, or holds pressed. */
  hoverControl: XRPanelControl | null;
  marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  /** The pointing ray (unit length along −z, scaled to what it reaches) and its tip. */
  ray: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  tip: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  recenterDown: boolean;
  playDown: boolean;
}

function isControl(press: Hand["press"]): press is XRPanelControl {
  return press !== null && press !== "panel" && press !== "atom";
}

type Grab =
  | { kind: "one"; hand: Hand; startHand: THREE.Matrix4; startModel: THREE.Matrix4 }
  | {
      kind: "two";
      a: Hand;
      b: Hand;
      startA: THREE.Vector3;
      startB: THREE.Vector3;
      startModel: THREE.Matrix4;
    };

interface SavedView {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  background: THREE.Scene["background"];
  clearAlpha: number;
}

export class XRSessionController {
  private session: XRSession | null = null;
  /** True between the session request and the session taking over. */
  private starting = false;
  private mode: MeganeXRMode | null = null;
  /** User camera handed to `render`; three replaces it with the per-eye cameras. */
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  /** Child of the scene whose matrix cancels the model transform. */
  private readonly rig = new THREE.Group();
  private hands: Hand[] = [];
  private grab: Grab | null = null;
  private model = new THREE.Matrix4();
  /** The structure's bounding sphere when it was last placed. */
  private focus: XRFocus | null = null;
  /** Head pose (reference space) from the latest frame that had one. */
  private readonly head = new THREE.Vector3();
  private readonly headQuaternion = new THREE.Quaternion();
  private headTracked = false;
  private placed = false;
  private lastTime: number | null = null;
  private saved: SavedView | null = null;
  private frames = 0;
  private readonly listeners = new Set<(state: MeganeXRState) => void>();
  private bridge: XRBridge | null = null;
  /** Created on the first session: it needs a canvas. */
  private panel: XRPanel | null = null;
  private readonly lights = new XRHeadLights();
  private labels: XRAtomLabels | null = null;
  private measureLabel: XRMeasureLabel | null = null;
  private measuring = false;
  /** The hover highlight last sent to the host, as a key. */
  private hoverKey = "";
  /** The frame a scrub drag last asked for. */
  private lastScrub = -1;
  private readonly modelInverse = new THREE.Matrix4();

  constructor(private readonly host: XRHost) {
    this.rig.matrixAutoUpdate = false;
    this.rig.name = "megane-xr-rig";
  }

  get presenting(): boolean {
    return this.session !== null;
  }

  getState(): MeganeXRState {
    const p = new THREE.Vector3().setFromMatrixPosition(this.model);
    return {
      presenting: this.presenting,
      mode: this.mode,
      frames: this.frames,
      scale: modelScale(this.model),
      position: [p.x, p.y, p.z],
      panel: this.presenting ? (this.panel?.controls ?? []) : [],
      measuring: this.measuring,
      labels: this.presenting ? (this.labels?.count ?? 0) : 0,
    };
  }

  /** Let the headset drive the page's playback and measurement (null: neither). */
  setBridge(bridge: XRBridge | null): void {
    this.bridge = bridge;
    if (!bridge?.measure) this.setMeasuring(false);
  }

  /**
   * Where an emulated controller has to be (reference space) to point at
   * panel control `id`: the E2E probe's way to press it. Null outside a
   * session or when the panel lacks the control.
   */
  panelControlPose(
    id: XRPanelControl,
  ): { position: [number, number, number]; quaternion: [number, number, number, number] } | null {
    const pose = this.presenting ? this.panel?.controlPose(id) : null;
    if (!pose) return null;
    const { position: p, quaternion: q } = pose;
    return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
  }

  /** Subscribe to session start / end. Returns the unsubscribe function. */
  subscribe(listener: (state: MeganeXRState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start an immersive session. Must be called from a user gesture (a click):
   * `requestSession` is issued before the first `await` so the browser still
   * sees the activation.
   */
  async enter(mode: MeganeXRMode): Promise<void> {
    if (this.session || this.starting) return;
    const xr = getXRSystem();
    if (!xr) throw new Error("WebXR is not available in this browser.");
    this.starting = true;
    try {
      const session = await xr.requestSession(mode, {
        optionalFeatures: ["local-floor", "hand-tracking"],
      });
      try {
        await this.start(session, mode);
      } catch (err) {
        await session.end().catch(() => {});
        throw err;
      }
    } finally {
      this.starting = false;
    }
  }

  /** End the session; the desktop view comes back on its `end` event. */
  async exit(): Promise<void> {
    await this.session?.end();
  }

  dispose(): void {
    this.session?.end().catch(() => {});
    for (const hand of this.hands) {
      for (const mesh of [hand.marker, hand.ray, hand.tip]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
    this.panel?.dispose();
    this.labels?.dispose();
    this.measureLabel?.dispose();
    this.listeners.clear();
  }

  private async start(session: XRSession, mode: MeganeXRMode): Promise<void> {
    const renderer = this.host.getRenderer();
    const scene = this.host.getScene();
    // Seated / standing height comes from local-floor where the device has it.
    let spaceType: XRReferenceSpaceType = "local-floor";
    try {
      await session.requestReferenceSpace("local-floor");
    } catch {
      spaceType = "local";
    }

    this.session = session;
    this.mode = mode;
    this.frames = 0;
    this.placed = false;
    this.focus = null;
    this.headTracked = false;
    this.lastTime = null;
    this.saved = {
      position: scene.position.clone(),
      quaternion: scene.quaternion.clone(),
      scale: scene.scale.clone(),
      background: scene.background,
      clearAlpha: renderer.getClearAlpha(),
    };
    if (mode === "immersive-ar") {
      // Passthrough: let the camera feed show through around the structure.
      scene.background = null;
      renderer.setClearAlpha(0);
    }
    this.attachHands(renderer);
    scene.add(this.rig);
    this.panel ??= new XRPanel();
    this.panel.reset();
    this.rig.add(this.panel.mesh);
    this.lights.attach(scene, this.rig);
    this.labels ??= new XRAtomLabels();
    this.measureLabel ??= new XRMeasureLabel();
    scene.add(this.labels.group, this.measureLabel.sprite);
    this.measuring = false;
    this.hoverKey = "";
    this.host.onPresentingChange(true);

    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType(spaceType);
    renderer.xr.addEventListener("sessionend", this.onSessionEnd);
    try {
      await renderer.xr.setSession(session);
    } catch (err) {
      this.onSessionEnd();
      throw err;
    }
    renderer.setAnimationLoop(this.onFrame);
    this.notify();
  }

  /** Create the two controller / hand spaces once; they stay on the rig. */
  private attachHands(renderer: THREE.WebGLRenderer): void {
    if (this.hands.length > 0) return;
    for (let i = 0; i < 2; i++) {
      const space = renderer.xr.getController(i);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.008, 16, 12),
        new THREE.MeshBasicMaterial({ color: MARKER_IDLE }),
      );
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, 0, -1),
        ]),
        new THREE.LineBasicMaterial({
          color: RAY_COLOR,
          transparent: true,
          opacity: 0.8,
          depthTest: false,
        }),
      );
      ray.renderOrder = 1002;
      ray.visible = false;
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.004, 12, 8),
        new THREE.MeshBasicMaterial({ color: RAY_COLOR, depthTest: false }),
      );
      tip.renderOrder = 1002;
      tip.visible = false;
      space.add(marker, ray, tip);
      const hand: Hand = {
        space,
        source: null,
        selecting: false,
        squeezing: false,
        press: null,
        hoverControl: null,
        marker,
        ray,
        tip,
        recenterDown: false,
        playDown: false,
      };
      space.addEventListener("connected", (e) => {
        hand.source = e.data;
      });
      space.addEventListener("disconnected", () => {
        hand.source = null;
        hand.selecting = false;
        hand.squeezing = false;
        hand.press = null;
        this.regrab();
      });
      space.addEventListener("selectstart", () => this.onSelectStart(hand));
      space.addEventListener("selectend", () => this.onSelectEnd(hand));
      space.addEventListener("squeezestart", () => {
        hand.squeezing = true;
        this.regrab();
      });
      space.addEventListener("squeezeend", () => {
        hand.squeezing = false;
        this.regrab();
      });
      this.hands.push(hand);
      this.rig.add(space);
    }
  }

  /** The hand's pointing ray in rig (reference) space; null while untracked. */
  private handRay(hand: Hand): THREE.Ray | null {
    return hand.space.visible ? rayFromPose(hand.space.matrix) : null;
  }

  /** The atom `ray` (rig space) points at, with the distance in metres. */
  private pickAtom(ray: THREE.Ray): RayAtomHit | null {
    const scale = modelScale(this.model);
    const hit = this.host.pickAtom(
      ray.clone().applyMatrix4(this.modelInverse),
      XR_PICK_MIN_RADIUS / scale,
    );
    return hit && { ...hit, distance: hit.distance * scale };
  }

  /**
   * A trigger or pinch: press the panel control the ray points at, swallow a
   * press on the panel's background, toggle the atom it points at in measure
   * mode, and grab the structure otherwise.
   */
  private onSelectStart(hand: Hand): void {
    const ray = this.handRay(hand);
    if (ray && this.panel) {
      const hit = this.panel.hit(ray);
      if (hit) {
        hand.press = hit.id;
        hand.hoverControl = hit.id;
        this.lastScrub = -1;
        if (hit.id === "scrub") this.scrubTo(hit.fraction);
        return;
      }
      if (this.panel.covers(ray) !== null) {
        hand.press = "panel";
        return;
      }
    }
    if (ray && this.measuring && this.bridge?.measure) {
      const atom = this.pickAtom(ray);
      if (atom) {
        hand.press = "atom";
        this.bridge.measure.toggleAtom(atom.atomIndex);
        return;
      }
    }
    hand.selecting = true;
    this.regrab();
  }

  /** The press ends: a panel control fires if the ray is still on it. */
  private onSelectEnd(hand: Hand): void {
    const press = hand.press;
    if (press === null) {
      hand.selecting = false;
      this.regrab();
      return;
    }
    hand.press = null;
    if (!isControl(press) || press === "scrub") return;
    const ray = this.handRay(hand);
    if (ray && this.panel?.hit(ray)?.id === press) this.activate(press);
  }

  /** Do what panel control `control` stands for. */
  private activate(control: XRPanelControl): void {
    const playback = this.bridge?.playback;
    const state = playback?.getState();
    switch (control) {
      case "play":
        playback?.togglePlay();
        break;
      case "prev":
        if (playback && state) playback.seek(Math.max(0, state.frame - 1));
        break;
      case "next":
        if (playback && state) playback.seek(Math.min(state.total - 1, state.frame + 1));
        break;
      case "measure":
        this.setMeasuring(!this.measuring);
        break;
      case "clear":
        this.bridge?.measure?.clear();
        break;
      case "reset":
        this.placed = false;
        break;
      case "exit":
        void this.exit();
        break;
    }
  }

  /** Seek to the frame a scrub drag points at, once per frame change. */
  private scrubTo(fraction: number): void {
    const playback = this.bridge?.playback;
    if (!playback) return;
    const frame = scrubFrame(fraction, playback.getState().total);
    if (frame === this.lastScrub) return;
    this.lastScrub = frame;
    playback.seek(frame);
  }

  private setMeasuring(on: boolean): void {
    this.measuring = on;
    if (!on) this.sendHover([]);
  }

  /** Pass the hovered atoms to the host's highlight when they change. */
  private sendHover(atoms: number[]): void {
    const key = atoms.join(",");
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.host.setHoverAtoms(atoms.length > 0 ? atoms : null);
  }

  /** Re-anchor the gesture whenever the set of grabbing hands changes. */
  private regrab(): void {
    const grabbing = this.hands.filter((h) => (h.selecting || h.squeezing) && h.space.visible);
    for (const hand of this.hands) {
      hand.marker.material.color.setHex(grabbing.includes(hand) ? MARKER_GRAB : MARKER_IDLE);
    }
    if (grabbing.length === 1) {
      const [hand] = grabbing;
      this.grab = {
        kind: "one",
        hand,
        startHand: hand.space.matrix.clone(),
        startModel: this.model.clone(),
      };
    } else if (grabbing.length >= 2) {
      const [a, b] = grabbing;
      this.grab = {
        kind: "two",
        a,
        b,
        startA: new THREE.Vector3().setFromMatrixPosition(a.space.matrix),
        startB: new THREE.Vector3().setFromMatrixPosition(b.space.matrix),
        startModel: this.model.clone(),
      };
    } else {
      this.grab = null;
    }
  }

  private isGrabbing(hand: Hand): boolean {
    const grab = this.grab;
    if (!grab) return false;
    return grab.kind === "one" ? grab.hand === hand : grab.a === hand || grab.b === hand;
  }

  /**
   * What each ray points at this frame: a panel control, the panel, or (in
   * measure mode) an atom. Draws the rays up to what they reach, drives a
   * scrub drag, and updates the hover highlight and the panel.
   */
  private point(): void {
    const panel = this.panel!;
    const hovered: number[] = [];
    for (const hand of this.hands) {
      hand.hoverControl = null;
      const ray = this.isGrabbing(hand) ? null : this.handRay(hand);
      let reach: number | null = null;
      let onAtom = false;
      if (ray && hand.press === "scrub") {
        const hit = panel.hit(ray, "scrub");
        if (hit) {
          this.scrubTo(hit.fraction);
          reach = hit.distance;
        }
      } else if (ray) {
        const hit = panel.hit(ray);
        reach = hit?.distance ?? panel.covers(ray);
        if (hit && (hand.press === null || hand.press === hit.id)) hand.hoverControl = hit.id;
        if (reach === null && this.measuring && this.bridge?.measure && hand.press === null) {
          const atom = this.pickAtom(ray);
          if (atom) {
            hovered.push(atom.atomIndex);
            reach = atom.distance;
            onAtom = true;
          }
        }
      }
      const show = reach !== null;
      hand.ray.visible = show;
      hand.tip.visible = show;
      if (reach !== null) {
        hand.ray.scale.set(1, 1, reach);
        hand.tip.position.set(0, 0, -reach);
        const color = onAtom ? RAY_ATOM_COLOR : RAY_COLOR;
        hand.ray.material.color.setHex(color);
        hand.tip.material.color.setHex(color);
      }
    }
    this.sendHover([...new Set(hovered)]);
    panel.update(
      this.panelState(),
      this.hands.flatMap((h) => (h.hoverControl ? [h.hoverControl] : [])),
      this.hands.flatMap((h) => (isControl(h.press) ? [h.press] : [])),
    );
  }

  private panelState(): XRPanelState {
    const playback = this.bridge?.playback?.getState() ?? null;
    const measure = this.bridge?.measure
      ? {
          active: this.measuring,
          hasSelection: this.host.getSelectedAtoms().length > 0,
          label: this.host.getMeasurement()?.label ?? null,
        }
      : null;
    return { playback: playback && playback.total > 1 ? { ...playback } : null, measure };
  }

  /** Keep the measurement readout over the measured atoms and the labels near the head. */
  private updateLabels(dt: number): void {
    const scale = modelScale(this.model);
    const measurement = this.bridge?.measure ? this.host.getMeasurement() : null;
    let at: THREE.Vector3 | null = null;
    if (measurement) {
      const sum = new THREE.Vector3();
      const p = new THREE.Vector3();
      let n = 0;
      for (const atom of measurement.atoms) {
        if (this.host.getAtomPosition(atom, p)) {
          sum.add(p);
          n++;
        }
      }
      if (n > 0) at = sum.divideScalar(n);
    }
    this.measureLabel!.update(measurement?.label ?? null, at, scale);
    const head = this.head.clone().applyMatrix4(this.modelInverse);
    const forward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.headQuaternion)
      .transformDirection(this.modelInverse);
    this.labels!.update(this.headTracked ? this.host.getLabels() : null, head, forward, scale, dt);
  }

  /** Apply this frame's gestures to `model`. */
  private steer(dt: number): void {
    const grab = this.grab;
    const tracked =
      grab === null ||
      (grab.kind === "one"
        ? grab.hand.space.visible
        : grab.a.space.visible && grab.b.space.visible);
    // A grabbing hand lost tracking: carry on with whoever is left.
    if (!tracked) this.regrab();
    if (this.grab?.kind === "one") {
      this.model = oneHandGrab(
        this.grab.startHand,
        this.grab.hand.space.matrix,
        this.grab.startModel,
      );
    } else if (this.grab?.kind === "two") {
      this.model = twoHandGrab(
        this.grab.startA,
        this.grab.startB,
        new THREE.Vector3().setFromMatrixPosition(this.grab.a.space.matrix),
        new THREE.Vector3().setFromMatrixPosition(this.grab.b.space.matrix),
        this.grab.startModel,
      );
    }
    for (const hand of this.hands) {
      const pad = hand.source?.gamepad;
      if (!pad) continue;
      const recenter = pad.buttons[BUTTON_RECENTER]?.pressed ?? false;
      if (recenter && !hand.recenterDown) this.placed = false;
      hand.recenterDown = recenter;
      const play = pad.buttons[BUTTON_PLAY]?.pressed ?? false;
      if (play && !hand.playDown) this.bridge?.playback?.togglePlay();
      hand.playDown = play;
      if (this.grab) continue; // sticks would fight the hands
      const x = pad.axes[THUMBSTICK_X] ?? 0;
      const y = pad.axes[THUMBSTICK_Y] ?? 0;
      const pivot = (this.focus?.center.clone() ?? new THREE.Vector3()).applyMatrix4(this.model);
      this.model = stickSteer(this.model, pivot, x, y, dt);
    }
  }

  /** Read the head pose of `frame` into `head` / `headQuaternion`; false without one. */
  private trackHead(frame: XRFrame): boolean {
    const space = this.host.getRenderer().xr.getReferenceSpace();
    const pose = space ? frame.getViewerPose(space) : undefined;
    if (!pose) return false;
    const { position: p, orientation: o } = pose.transform;
    this.head.set(p.x, p.y, p.z);
    this.headQuaternion.set(o.x, o.y, o.z, o.w);
    this.headTracked = true;
    return true;
  }

  private place(): void {
    this.focus = this.host.getFocus();
    this.model = computeXRPlacement(
      this.focus,
      this.head,
      this.headQuaternion,
      this.host.getViewCamera().quaternion,
    );
    this.placed = true;
    this.grab = null;
    this.regrab();
  }

  /** This frame's immersive shading: the depth cue spans the structure as seen now. */
  private shading(scene: THREE.Scene): XRShading {
    const fogColor = scene.background instanceof THREE.Color ? scene.background : BLACK;
    // three sizes each eye's viewport before calling the frame loop.
    const viewport = this.host.getRenderer().xr.getCamera().cameras[0]?.viewport;
    const eye =
      viewport && viewport.z > 0 && viewport.w > 0
        ? new THREE.Vector2(viewport.z, viewport.w)
        : new THREE.Vector2(DEFAULT_EYE_WIDTH, DEFAULT_EYE_HEIGHT);
    const pixel = 2 / eye.y;
    if (!this.focus || !this.headTracked) {
      return { fogStart: 0, fogEnd: 1, fogStrength: 0, fogColor, pixel, eye };
    }
    const center = this.focus.center.clone().applyMatrix4(this.model);
    const { start, end } = depthCueRange(
      this.head,
      center,
      this.focus.radius * modelScale(this.model),
    );
    return {
      fogStart: start,
      fogEnd: end,
      fogStrength: XR_DEPTH_CUE_STRENGTH,
      fogColor,
      pixel,
      eye,
    };
  }

  private readonly onFrame = (time: number, frame?: XRFrame): void => {
    const renderer = this.host.getRenderer();
    if (!renderer.xr.isPresenting) return;
    const scene = this.host.getScene();
    const dt = this.lastTime === null ? 0 : Math.min((time - this.lastTime) / 1000, 0.1);
    this.lastTime = time;
    let snapPanel = false;
    if (frame && this.trackHead(frame) && !this.placed) {
      this.place();
      snapPanel = true;
    }
    if (this.headTracked) {
      this.lights.update(this.headQuaternion);
      const using = this.hands.some((h) => isControl(h.press));
      this.panel!.follow(this.head, this.headQuaternion, dt, snapPanel, using);
    }
    this.modelInverse.copy(this.model).invert();
    this.point();
    this.steer(dt);
    this.model.decompose(scene.position, scene.quaternion, scene.scale);
    this.modelInverse.copy(this.model).invert();
    this.rig.matrix.copy(this.modelInverse);
    this.updateLabels(dt);
    // Cheap (a few dozen objects) and catches layers created mid-session.
    applyXRShading(scene, this.shading(scene));
    renderer.render(scene, this.camera);
    this.frames++;
  };

  private readonly onSessionEnd = (): void => {
    const renderer = this.host.getRenderer();
    const scene = this.host.getScene();
    renderer.setAnimationLoop(null);
    renderer.xr.removeEventListener("sessionend", this.onSessionEnd);
    renderer.xr.enabled = false;
    if (this.saved) {
      scene.position.copy(this.saved.position);
      scene.quaternion.copy(this.saved.quaternion);
      scene.scale.copy(this.saved.scale);
      scene.background = this.saved.background;
      renderer.setClearAlpha(this.saved.clearAlpha);
      this.saved = null;
    }
    this.lights.detach();
    scene.remove(this.rig);
    this.panel?.reset();
    this.labels?.group.removeFromParent();
    this.measureLabel?.sprite.removeFromParent();
    this.sendHover([]);
    this.measuring = false;
    applyXRShading(scene, null);
    for (const hand of this.hands) {
      hand.selecting = false;
      hand.squeezing = false;
      hand.press = null;
      hand.source = null;
      hand.recenterDown = false;
      hand.playDown = false;
      hand.ray.visible = false;
      hand.tip.visible = false;
    }
    this.grab = null;
    this.session = null;
    this.mode = null;
    this.host.onPresentingChange(false);
    this.notify();
  };

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}
