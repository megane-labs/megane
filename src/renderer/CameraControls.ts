/**
 * Trackball-style camera controls for the molecular viewer.
 *
 * Wraps three.js `TrackballControls` with the viewer's defaults. Unlike
 * `OrbitControls`, a trackball does not pin `camera.up` to a fixed world axis,
 * so rotation is unrestricted: dragging across the ±c-axis poles keeps
 * turning the model instead of stopping (or reversing) at the pole.
 *
 * Panning is disabled here — `MoleculeRenderer` implements right-drag pan
 * itself so the rotation pivot always stays at the screen centre — and the
 * A/S/D modifier keys are unbound so typing in a side panel can never latch
 * the controls into a zoom/pan mode.
 */

import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

/** Radians of rotation per unit of trackball screen travel (full width = 2). */
export const TRACKBALL_ROTATE_SPEED = 2.5;
/** Zoom speed; also read by the wheel-zoom handler in MoleculeRenderer. */
export const TRACKBALL_ZOOM_SPEED = 1.2;

/** The subset of the controls API shared with `CameraManager` helpers. */
export interface CameraControlsLike {
  target: THREE.Vector3;
  update(): void;
}

/** Internals of TrackballControls this wrapper has to reach into. */
interface TrackballInternals {
  _movePrev: THREE.Vector2;
  _lastAngle: number;
  _onMouseMove: (event: PointerEvent) => void;
  _onTouchMove: (event: PointerEvent) => void;
}

export class CameraControls extends TrackballControls {
  constructor(
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
    domElement: HTMLElement | null = null,
  ) {
    super(camera, domElement);
    this.rotateSpeed = TRACKBALL_ROTATE_SPEED;
    this.zoomSpeed = TRACKBALL_ZOOM_SPEED;
    // Static motion: the model follows the pointer 1:1 and stops when it
    // stops. Inertial glide would scale with the last inter-frame segment,
    // making the feel depend on the frame rate of the scene being rotated.
    this.staticMoving = true;
    // Right-drag pan is implemented by MoleculeRenderer (frustum shift for
    // orthographic cameras), so the built-in pan must stay off.
    this.noPan = true;
    // Empty key codes never match `event.code`, which disables the
    // A/S/D "all mouse buttons rotate/zoom/pan" modifier latches.
    this.keys = ["", "", ""];
    this.installLosslessMove();
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
   * Apply any pending input immediately and drop any inertial momentum, so
   * the camera pose is final after this call. Used before programmatic
   * camera writes (pivot animation, camera-state restore) that must not be
   * disturbed by a decaying rotation from a previous drag when damping is
   * enabled.
   */
  syncImmediate(): void {
    const wasStatic = this.staticMoving;
    this.staticMoving = true;
    try {
      this.update();
    } finally {
      this.staticMoving = wasStatic;
    }
    // `_lastAngle` is the residual rotation velocity TrackballControls keeps
    // replaying (scaled by the damping factor) while `staticMoving` is off.
    (this as unknown as TrackballInternals)._lastAngle = 0;
  }
}
