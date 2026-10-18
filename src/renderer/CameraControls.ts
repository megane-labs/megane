/**
 * Turntable camera controls for the molecular viewer.
 *
 * Built on three.js `TrackballControls` for its pointer/touch plumbing, but
 * the rotation is OVITO's orbit mode: a horizontal drag spins the camera
 * about a fixed world axis (`upAxis`, +c / +z by default) and a vertical drag
 * tilts it about the screen-horizontal axis, so the model never picks up a
 * roll the way a free trackball does. Unlike `OrbitControls` the tilt is not
 * clamped at the poles: dragging across ±`upAxis` keeps turning the model,
 * and the horizontal direction is flipped for a drag that starts upside down
 * so the model still follows the pointer.
 *
 * Panning is disabled here — `MoleculeRenderer` implements right-drag and
 * Shift+left-drag pan itself so the rotation pivot stays fixed on screen —
 * and the A/S/D modifier keys are unbound so typing in a side panel can
 * never latch the controls into a zoom/pan mode.
 */

import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

/**
 * Radians of rotation per viewport height of pointer travel, in both
 * directions (OVITO's orbit mode uses the same 5 / height rad per pixel).
 */
export const ORBIT_SPEED = 5;
/** Zoom speed; also read by the wheel-zoom handler in MoleculeRenderer. */
export const TRACKBALL_ZOOM_SPEED = 1.2;

/** The subset of the controls API shared with `CameraManager` helpers. */
export interface CameraControlsLike {
  target: THREE.Vector3;
  update(): void;
}

/** Internals of TrackballControls this wrapper has to reach into. */
interface TrackballInternals {
  state: number;
  _eye: THREE.Vector3;
  _moveCurr: THREE.Vector2;
  _movePrev: THREE.Vector2;
  _lastAngle: number;
  _onMouseDown: (event: PointerEvent) => void;
  _onMouseMove: (event: PointerEvent) => void;
  _onTouchMove: (event: PointerEvent) => void;
}

/** TrackballControls' "no interaction" state. */
const STATE_NONE = -1;

const _quat = new THREE.Quaternion();
const _right = new THREE.Vector3();

/** Whether a pointer-down is the Shift+left-drag pan gesture. */
export function isShiftPanGesture(event: { button: number; shiftKey: boolean }): boolean {
  return event.button === 0 && event.shiftKey;
}

export class CameraControls extends TrackballControls {
  /** World axis kept upright by horizontal drags (unit length). */
  readonly upAxis = new THREE.Vector3(0, 0, 1);
  /**
   * +1, or -1 when the drag started with the camera upside down relative to
   * `upAxis`. Latched per drag so crossing a pole mid-drag doesn't reverse
   * the horizontal direction under the pointer.
   */
  private yawSign: 1 | -1 | null = null;

  constructor(
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    domElement: HTMLElement | null = null,
  ) {
    super(camera, domElement);
    this.zoomSpeed = TRACKBALL_ZOOM_SPEED;
    // Static motion: the model follows the pointer 1:1 and stops when it
    // stops. Inertial glide would scale with the last inter-frame segment,
    // making the feel depend on the frame rate of the scene being rotated.
    this.staticMoving = true;
    // Right-drag and Shift+left-drag pan are implemented by MoleculeRenderer
    // (frustum shift for orthographic cameras), so the built-in pan stays off.
    this.noPan = true;
    // Empty key codes never match `event.code`, which disables the
    // A/S/D "all mouse buttons rotate/zoom/pan" modifier latches.
    this.keys = ["", "", ""];
    this.addEventListener("start", () => {
      this.yawSign = null;
    });
    this.installShiftPanPassThrough();
    this.installLosslessMove();
  }

  /**
   * Turntable rotation, replacing TrackballControls' free trackball.
   * Called from `update()` with `_eye = position - target`; rotates `_eye`
   * and `camera.up` by the pointer travel since the last update.
   */
  _rotateCamera(): void {
    const internals = this as unknown as TrackballInternals;
    const dx = internals._moveCurr.x - internals._movePrev.x;
    const dy = internals._moveCurr.y - internals._movePrev.y;
    internals._movePrev.copy(internals._moveCurr);
    internals._lastAngle = 0;
    if ((dx === 0 && dy === 0) || this.screen.height <= 0) return;

    // `_getMouseOnCircle` normalises both axes by half the screen width.
    const radPerUnit = (ORBIT_SPEED * this.screen.width) / 2 / this.screen.height;
    const eye = internals._eye;
    const up = this.object.up;

    if (this.yawSign === null) this.yawSign = up.dot(this.upAxis) < 0 ? -1 : 1;
    _quat.setFromAxisAngle(this.upAxis, -dx * radPerUnit * this.yawSign);
    eye.applyQuaternion(_quat);
    up.applyQuaternion(_quat);

    _right.crossVectors(up, eye);
    if (_right.lengthSq() === 0) return;
    _quat.setFromAxisAngle(_right.normalize(), dy * radPerUnit);
    eye.applyQuaternion(_quat);
    up.applyQuaternion(_quat);
  }

  /**
   * Leave a Shift+left press to MoleculeRenderer's pan handler: the press
   * still dispatches `start`/`end` (so pivot snapping and the camera-change
   * callback fire), but the controls stay idle instead of rotating.
   */
  private installShiftPanPassThrough(): void {
    const internals = this as unknown as TrackballInternals;
    const original = internals._onMouseDown;
    internals._onMouseDown = (event: PointerEvent) => {
      original(event);
      if (isShiftPanGesture(event)) internals.state = STATE_NONE;
    };
  }

  /**
   * Make pointer motion between two `update()` calls accumulate instead of
   * being overwritten.
   *
   * Stock TrackballControls copies `_movePrev ← _moveCurr` on every
   * pointermove, so when several move events land between two render
   * frames only the last segment is rotated and the rest of the travel is
   * silently dropped (visible as sluggish, erratic drags with high-rate
   * mice or a slow scene). `_rotateCamera()` already advances `_movePrev`
   * after consuming a segment, so restoring the pre-event value here turns
   * the segment into "everything since the last update".
   */
  private installLosslessMove(): void {
    const internals = this as unknown as TrackballInternals;
    const wrap = (original: (event: PointerEvent) => void) => {
      const saved = new THREE.Vector2();
      return (event: PointerEvent) => {
        saved.copy(internals._movePrev);
        original(event);
        internals._movePrev.copy(saved);
      };
    };
    internals._onMouseMove = wrap(internals._onMouseMove);
    internals._onTouchMove = wrap(internals._onTouchMove);
  }

  /**
   * Apply any pending input immediately so the camera pose is final after
   * this call. Used before programmatic camera writes (pivot animation,
   * camera-state restore) so a half-consumed drag segment cannot be applied
   * on top of them later.
   */
  syncImmediate(): void {
    const wasStatic = this.staticMoving;
    this.staticMoving = true;
    try {
      this.update();
    } finally {
      this.staticMoving = wasStatic;
    }
    (this as unknown as TrackballInternals)._lastAngle = 0;
  }
}
