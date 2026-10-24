/**
 * Pure math behind the WebXR (VR / passthrough AR) view.
 *
 * In an immersive session the structure lives in the room: the scene's own
 * transform (`model`, Å-space → reference-space metres, a similarity transform
 * with a uniform scale) places it in front of the user, and the controller and
 * hand gestures below move, turn and scale it. Nothing here touches the DOM or
 * a WebXR session, so every gesture is unit-tested on plain matrices.
 */

import * as THREE from "three";

/**
 * Distance (m) in front of the head the structure is placed at. A headset's
 * lenses focus at a fixed 1–2 m, so anything looked at from much nearer than
 * ~0.5 m makes the eyes converge on one distance while focusing at another
 * (vergence–accommodation conflict), which tires them within minutes. At this
 * distance and {@link XR_PLACEMENT_RADIUS} the near side starts at ~0.7 m.
 */
export const XR_PLACEMENT_DISTANCE = 1.1;
/** How far (m) below eye level the structure's centre sits. */
export const XR_PLACEMENT_DROP = 0.1;
/** Radius (m) the structure's bounding sphere is scaled to on entry. */
export const XR_PLACEMENT_RADIUS = 0.4;
/** Nothing nearer to the eye than this (m) is drawn: too close to fuse. */
export const XR_NEAR_CLIP = 0.3;
/** Content fades in between {@link XR_NEAR_CLIP} and this distance (m). */
export const XR_NEAR_FADE = 0.5;
/** How far toward the background colour the depth cue fades the far side. */
export const XR_DEPTH_CUE_STRENGTH = 0.45;
/** Longest depth-cue ramp (m), so the gradient stays visible from inside a large model. */
export const XR_DEPTH_CUE_MAX_SPAN = 3;
/** Bounds on the model scale (metres per Å): 1 m spans 100 000 Å … 2 Å. */
export const XR_MIN_SCALE = 1e-5;
export const XR_MAX_SCALE = 0.5;
/** Thumbstick deflection ignored as drift. */
export const XR_STICK_DEADZONE = 0.15;
/** Thumbstick zoom rate (e-folds per second at full deflection). */
export const XR_STICK_ZOOM_RATE = 1.5;
/** Thumbstick turn rate (radians per second at full deflection). */
export const XR_STICK_TURN_RATE = 1.5;

/** A structure's bounding sphere in Å. */
export interface XRFocus {
  center: THREE.Vector3;
  radius: number;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Depth-cue ramp (m from the eye) for a structure whose bounding sphere sits at
 * `center` with `radius` (reference space, metres) seen from `head`: the fade
 * starts at the near side and is full at the far side, so the gradient spans
 * the structure at any scale. From inside it the ramp starts where the near
 * fade ends and is capped at {@link XR_DEPTH_CUE_MAX_SPAN}, so the atoms
 * around you stay crisp while the far side of a large model recedes.
 */
export function depthCueRange(
  head: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): { start: number; end: number } {
  const distance = head.distanceTo(center);
  const start = Math.max(XR_NEAR_FADE, distance - radius);
  const end =
    distance >= radius
      ? distance + radius
      : Math.min(distance + radius, start + XR_DEPTH_CUE_MAX_SPAN);
  return { start, end: Math.max(end, start + 0.05) };
}

/** Clamp a model scale into [XR_MIN_SCALE, XR_MAX_SCALE]. */
export function clampXRScale(scale: number): number {
  return Math.min(XR_MAX_SCALE, Math.max(XR_MIN_SCALE, scale));
}

/** The (uniform) scale of a model matrix. */
export function modelScale(model: THREE.Matrix4): number {
  return _v1.setFromMatrixColumn(model, 0).length();
}

/**
 * Bounding sphere of `nAtoms` positions (xyz triples), padded by `pad` Å so
 * the outermost atoms' spheres fit too. An empty structure gets a 10 Å sphere
 * at the origin so the placement below still has something to scale.
 */
export function boundingFocus(positions: ArrayLike<number>, nAtoms: number, pad = 2): XRFocus {
  if (nAtoms <= 0) return { center: new THREE.Vector3(), radius: 10 };
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < nAtoms; i++) {
    _v1.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    min.min(_v1);
    max.max(_v1);
  }
  const center = min.clone().add(max).multiplyScalar(0.5);
  return { center, radius: max.distanceTo(min) / 2 + pad };
}

/**
 * The model matrix that shows the structure in front of a user whose head is
 * at `headPosition` / `headQuaternion` (reference space): its bounding sphere
 * is scaled to {@link XR_PLACEMENT_RADIUS} and centred
 * {@link XR_PLACEMENT_DISTANCE} ahead (horizontally) and slightly below the
 * eyes. `viewQuaternion` is the desktop camera's orientation; the structure is
 * turned so the user sees it from the same side the desktop view showed, with
 * the head's yaw taking the camera's place (pitch and roll of the head are
 * ignored so the placement stays level).
 */
export function computeXRPlacement(
  focus: XRFocus,
  headPosition: THREE.Vector3,
  headQuaternion: THREE.Quaternion,
  viewQuaternion: THREE.Quaternion,
): THREE.Matrix4 {
  const forward = _v1.set(0, 0, -1).applyQuaternion(headQuaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
  forward.normalize();
  const yaw = Math.atan2(-forward.x, -forward.z);
  const rotation = new THREE.Quaternion()
    .setFromAxisAngle(Y_AXIS, yaw)
    .multiply(viewQuaternion.clone().invert());
  const scale = clampXRScale(XR_PLACEMENT_RADIUS / Math.max(focus.radius, 1e-6));
  const target = headPosition
    .clone()
    .addScaledVector(forward, XR_PLACEMENT_DISTANCE)
    .add(_v2.set(0, -XR_PLACEMENT_DROP, 0));
  // model = T(target) · R · S · T(−center)
  const centerOffset = focus.center.clone().multiplyScalar(-scale).applyQuaternion(rotation);
  return new THREE.Matrix4().compose(
    target.add(centerOffset),
    rotation,
    _s.set(scale, scale, scale),
  );
}

/**
 * One-handed grab: the structure follows the hand rigidly. `startHand` and
 * `startModel` are the hand pose and model when the grab began; returns the
 * model for the hand's current pose (`model = hand · startHand⁻¹ · startModel`).
 */
export function oneHandGrab(
  startHand: THREE.Matrix4,
  hand: THREE.Matrix4,
  startModel: THREE.Matrix4,
): THREE.Matrix4 {
  return new THREE.Matrix4().copy(hand).multiply(_m.copy(startHand).invert()).multiply(startModel);
}

/**
 * Two-handed grab: pulling the hands apart scales the structure, swinging the
 * line between them turns it, and moving their midpoint carries it along —
 * the pinch-to-zoom of a touch screen in 3D. Positions are the hands' when
 * the gesture began (`start*`) and now; the scale stays within
 * [XR_MIN_SCALE, XR_MAX_SCALE].
 */
export function twoHandGrab(
  startA: THREE.Vector3,
  startB: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  startModel: THREE.Matrix4,
): THREE.Matrix4 {
  const startScale = modelScale(startModel);
  const startSpan = _v1.subVectors(startB, startA);
  const span = _v2.subVectors(b, a);
  const startLen = startSpan.length();
  const len = span.length();
  if (startLen < 1e-6 || len < 1e-6) return startModel.clone();
  const factor = clampXRScale(startScale * (len / startLen)) / startScale;
  _q.setFromUnitVectors(startSpan.divideScalar(startLen), span.divideScalar(len));
  const startMid = startA.clone().add(startB).multiplyScalar(0.5);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  // model = T(mid) · R · S(factor) · T(−startMid) · startModel
  _m.compose(mid, _q, _s.set(factor, factor, factor));
  _m2.makeTranslation(-startMid.x, -startMid.y, -startMid.z);
  return new THREE.Matrix4().multiplyMatrices(_m, _m2).multiply(startModel);
}

/**
 * Thumbstick steering for `dt` seconds: pushing forward (`y` < 0, the
 * xr-standard convention) zooms in and sideways turns the structure about the
 * vertical axis, both about `pivot` (reference space). Deflections inside
 * {@link XR_STICK_DEADZONE} are ignored; returns `model` unchanged then.
 */
export function stickSteer(
  model: THREE.Matrix4,
  pivot: THREE.Vector3,
  x: number,
  y: number,
  dt: number,
): THREE.Matrix4 {
  const zoom = Math.abs(y) > XR_STICK_DEADZONE ? -y : 0;
  const turn = Math.abs(x) > XR_STICK_DEADZONE ? x : 0;
  if (zoom === 0 && turn === 0) return model.clone();
  const scale = modelScale(model);
  const factor = clampXRScale(scale * Math.exp(zoom * XR_STICK_ZOOM_RATE * dt)) / scale;
  _q.setFromAxisAngle(Y_AXIS, -turn * XR_STICK_TURN_RATE * dt);
  // model' = T(pivot) · R · S(factor) · T(−pivot) · model
  _m.compose(pivot, _q, _s.set(factor, factor, factor));
  _m2.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  return new THREE.Matrix4().multiplyMatrices(_m, _m2).multiply(model);
}

/** Distance (m) ahead of the head the control panel floats at. */
export const XR_PANEL_DISTANCE = 0.5;
/**
 * How far (m) below eye level the control panel floats: look down to use it.
 * About 35° down, clear of a freshly placed structure's lower edge (~25°).
 */
export const XR_PANEL_DROP = 0.35;
/** The panel starts following the head once it is this far (rad) off to the side. */
export const XR_PANEL_FOLLOW_ANGLE = (40 * Math.PI) / 180;
/** …or this far (m) from where it would be placed now (the user walked). */
export const XR_PANEL_FOLLOW_DISTANCE = 0.35;
/** How quickly a following panel catches up (e-folds per second). */
export const XR_PANEL_FOLLOW_RATE = 5;
/**
 * Smallest pick radius (m) an atom gets: a hand-tracking ray jitters by a few
 * millimetres, so a small atom far away would otherwise be hard to hit.
 */
export const XR_PICK_MIN_RADIUS = 0.008;

/** The head's forward direction, flattened onto the floor (unit). */
function levelForward(headQuaternion: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, -1).applyQuaternion(headQuaternion);
  out.y = 0;
  if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
  return out.normalize();
}

/**
 * Where the control panel belongs for a head at `head` / `headQuaternion`:
 * {@link XR_PANEL_DISTANCE} ahead (level with the floor, ignoring head pitch)
 * and {@link XR_PANEL_DROP} below the eyes, its face (+z) turned to the eyes.
 */
export function panelPose(
  head: THREE.Vector3,
  headQuaternion: THREE.Quaternion,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const forward = levelForward(headQuaternion, _v1);
  const position = head
    .clone()
    .addScaledVector(forward, XR_PANEL_DISTANCE)
    .add(_v2.set(0, -XR_PANEL_DROP, 0));
  // Object-style lookAt: +z points from the panel to the eyes.
  _m.lookAt(head, position, Y_AXIS);
  return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(_m) };
}

/**
 * Whether a panel at `position` has fallen out of reach of a head at `head`
 * / `headQuaternion`: more than {@link XR_PANEL_FOLLOW_ANGLE} off to the side
 * of where the head faces, or {@link XR_PANEL_FOLLOW_DISTANCE} from where it
 * would be placed now. Inside that comfort zone it stays put, so it does not
 * swim around with every glance.
 */
export function panelOutOfReach(
  position: THREE.Vector3,
  head: THREE.Vector3,
  headQuaternion: THREE.Quaternion,
): boolean {
  const target = panelPose(head, headQuaternion).position;
  if (position.distanceTo(target) > XR_PANEL_FOLLOW_DISTANCE) return true;
  const toPanel = _v2.subVectors(position, head);
  toPanel.y = 0;
  if (toPanel.lengthSq() < 1e-8) return true;
  return toPanel.normalize().angleTo(levelForward(headQuaternion, _v1)) > XR_PANEL_FOLLOW_ANGLE;
}

/**
 * The pointing ray of a controller or hand from its target-ray pose
 * (`matrix`): from its origin along its −z axis.
 */
export function rayFromPose(matrix: THREE.Matrix4, out = new THREE.Ray()): THREE.Ray {
  out.origin.setFromMatrixPosition(matrix);
  out.direction.set(-matrix.elements[8], -matrix.elements[9], -matrix.elements[10]).normalize();
  return out;
}

/**
 * Where `ray` (in the panel's parent space) meets a `width` × `height` m
 * panel whose pose is `panelMatrix` (centred, facing +z): `u` / `v` run 0–1
 * from the left / top edge, `distance` is along the ray (m). Null when the
 * ray comes from behind the panel or points away, and — unless `bounded` is
 * false (a slider dragged past the edge) — when it misses the panel.
 */
export function rayHitsPanel(
  ray: THREE.Ray,
  panelMatrix: THREE.Matrix4,
  width: number,
  height: number,
  bounded = true,
): { u: number; v: number; distance: number } | null {
  const local = ray.clone().applyMatrix4(_m2.copy(panelMatrix).invert());
  // Facing +z: a usable ray starts in front and travels toward −z.
  if (local.origin.z <= 0 || local.direction.z >= -1e-6) return null;
  const t = -local.origin.z / local.direction.z;
  const x = local.origin.x + local.direction.x * t;
  const y = local.origin.y + local.direction.y * t;
  const u = x / width + 0.5;
  const v = 0.5 - y / height;
  if (bounded && (u < 0 || u > 1 || v < 0 || v > 1)) return null;
  // The panel's scale is 1, so distances in its space are metres.
  return { u, v, distance: t };
}
