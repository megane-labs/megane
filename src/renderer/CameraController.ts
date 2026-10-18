/**
 * CameraController: the viewer's camera, its turntable controls, and every
 * camera interaction `MoleculeRenderer` layers on top of them.
 *
 * It owns
 *
 * - the active camera (orthographic by default, like OVITO) and the
 *   `CameraControls` bound to it, recreated when the projection switches;
 * - the smooth pivot animation behind `setRotationCenter` (perspective) and the
 *   in-place orbit-center move (orthographic);
 * - the custom pan (right-drag, Shift+left-drag) and the capture-phase wheel
 *   zoom that replace the controls' built-in pan and zoom;
 * - the orthographic frustum fit: the overlay insets, the last measured view
 *   extent, and the accumulated frustum pan that resize and zoom re-apply;
 * - the camera-change callback the hosts use to persist the camera state.
 *
 * The camera math itself lives in the pure helpers of `CameraManager.ts`; this
 * class holds the state those helpers act on and the DOM listeners that drive
 * them. The renderer reaches the DOM and the loaded structure through
 * {@link CameraHost}, read lazily so a host can be wired before it mounts.
 */

import * as THREE from "three";
import { CameraControls, isShiftPanGesture } from "./CameraControls";
import type { Snapshot } from "../types";
import {
  computeViewBounds,
  fitCameraToView,
  applyFrustumInsets,
  createSwitchedCamera,
  updatePerspectiveClipping,
  zoomOrthographicAroundTarget,
  wheelZoomFactor,
  dollyPerspectiveTowardTarget,
  orientCamera,
  currentOrientation,
  type ViewExtent,
} from "./CameraManager";
import { axisOrientation, turntableUpAxis, type ViewAxis } from "./cameraOrientation";
import { screenToWorldOnPlane } from "./Picking";

export type MeganeCameraMode = "perspective" | "orthographic";

export interface MeganeCameraState {
  mode: MeganeCameraMode;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  /**
   * Camera up vector. The controls tilt `up` with the view (and over the
   * poles it points away from the turntable axis), so the orientation is only fully described together with `up`. Optional for
   * backward compatibility with states saved before it existed (those are
   * restored with whatever up the camera currently has).
   */
  up?: [number, number, number];
}

/** What the controller reads from the renderer that owns it. */
export interface CameraHost {
  /** The element the viewer is mounted in (null before mount). */
  getContainer(): HTMLElement | null;
  /** The WebGL canvas the controls and the pan listener attach to. */
  getCanvas(): HTMLElement;
  /** The loaded primary structure, if any. */
  getSnapshot(): Snapshot | null;
  /** The current atom positions (trajectory frame); only read with a snapshot. */
  getCurrentPositions(): Float32Array;
}

/** Smooth pivot animation state (set by setRotationCenter). */
interface PivotAnimation {
  startTarget: THREE.Vector3;
  endTarget: THREE.Vector3;
  startCameraPos: THREE.Vector3;
  endCameraPos: THREE.Vector3;
  startTime: number;
  duration: number;
}

export class CameraController {
  /** Duration of the smooth pivot animation in milliseconds. */
  static readonly PIVOT_ANIM_DURATION_MS = 400;

  /** The active camera; replaced by {@link setPerspective}. Unset before mount. */
  camera!: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  /** Turntable controls for {@link camera}; recreated with it. Unset before mount. */
  controls!: CameraControls;

  private perspectiveMode = false;
  /** Extent of the structure along the current screen axes; sizes the ortho frustum. */
  private lastExtent: ViewExtent = { maxExtent: 1, extentX: 1, extentY: 1 };
  private viewInsetLeft = 0;
  private viewInsetRight = 0;
  private pivotAnim: PivotAnimation | null = null;

  /** Custom pan handler state (right-mouse drag, replaces the controls' built-in pan). */
  private customPanActive = false;
  private customPanLastX = 0;
  private customPanLastY = 0;
  private customPanPointerId: number | null = null;
  private customPanCleanup: (() => void) | null = null;
  // Reusable temp vectors for applyCustomPan perspective branch.
  private readonly _panRight = new THREE.Vector3();
  private readonly _panUp = new THREE.Vector3();
  private readonly _panDelta = new THREE.Vector3();
  // Accumulated frustum shift for orthographic pan (camera.left/right/top/bottom units).
  // Re-applied after applyInsets; reset when a new rotation center is set.
  private _frustumPanX = 0;
  private _frustumPanY = 0;

  private wheelZoomHandler: ((e: WheelEvent) => void) | null = null;

  /** Called when the user finishes a camera interaction (drag end). */
  private _cameraChangeCallback: (() => void) | null = null;

  constructor(private readonly host: CameraHost) {}

  /**
   * Create the default orthographic camera and its controls, and attach the
   * wheel-zoom and custom-pan listeners. Called once from `mount()`, after the
   * host's container and canvas exist.
   */
  mount(): void {
    const container = this.host.getContainer()!;
    // Camera (orthographic by default, like OVITO)
    const aspect = container.clientWidth / container.clientHeight;
    const frustumSize = 50;
    this.camera = new THREE.OrthographicCamera(
      (-frustumSize * aspect) / 2,
      (frustumSize * aspect) / 2,
      frustumSize / 2,
      -frustumSize / 2,
      0.1,
      10000,
    );
    this.camera.position.set(0, -50, 0);
    this.camera.up.set(0, 0, 1);

    // Controls (turntable about +c / +z, no pole clamp). Built-in pan is off;
    // right-drag and Shift+left-drag are handled by attachCustomPanListener(),
    // which keeps the rotation pivot fixed in world space.
    this.controls = this.createControls();
    this.attachWheelZoomListener();
    this.attachCustomPanListener();
  }

  /** Keep +c of the cell (or +z without one) upright for horizontal drags. */
  syncUpAxis(box: Float32Array | null | undefined): void {
    this.controls?.upAxis.set(...turntableUpAxis(box ?? null));
  }

  /** Fit camera to show all atoms (or simulation cell if present). */
  fitToView(snapshot: Snapshot): void {
    this.lastExtent = fitCameraToView(this.camera, this.controls, snapshot);
    // A fit centres the model: drop any pan / off-centre orbit-center shift
    // accumulated in the frustum, or the re-applied insets would keep it.
    this._frustumPanX = 0;
    this._frustumPanY = 0;
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.applyInsets();
    }
  }

  /**
   * Re-measure the view extent for `snapshot` without moving the camera. The
   * extent drives zoom clamping and the frustum fit, so it must follow new
   * positions, measured in the view the camera is actually in.
   */
  syncExtent(snapshot: Snapshot): void {
    this.lastExtent = computeViewBounds(
      snapshot,
      currentOrientation(this.camera, this.controls) ?? undefined,
    ).extent;
  }

  /**
   * Set the rotation center (controls target) to the given world point.
   *
   * Orthographic cameras follow OVITO: the view does not move, the scene
   * simply starts orbiting around the new point wherever it is on screen.
   * The camera is translated so it looks at the point and the frustum is
   * shifted back by the same screen-space offset (booked as frustum pan, so
   * resize and wheel zoom keep it).
   *
   * Perspective cameras cannot shift their view that way without changing
   * the picture (parallax), so they pan the point to the screen center —
   * smoothly over PIVOT_ANIM_DURATION_MS when `animate` is true (default).
   */
  setRotationCenter(x: number, y: number, z: number, animate = true): void {
    this.snapPivotAnimToEnd();
    const endTarget = new THREE.Vector3(x, y, z);
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.moveOrbitCenterInPlace(this.camera, endTarget);
      return;
    }
    if (!animate) {
      this.camera.position.add(endTarget.clone().sub(this.controls.target));
      this.controls.target.copy(endTarget);
      this.controls.syncImmediate();
      return;
    }
    const startTarget = this.controls.target.clone();
    const delta = endTarget.clone().sub(startTarget);
    const startCameraPos = this.camera.position.clone();
    const endCameraPos = startCameraPos.clone().add(delta);

    // Translate both controls.target and camera.position by the same delta
    // so the scene pans smoothly to center the clicked point on screen.
    this.pivotAnim = {
      startTarget,
      endTarget,
      startCameraPos,
      endCameraPos,
      startTime: performance.now(),
      duration: CameraController.PIVOT_ANIM_DURATION_MS,
    };
  }

  /**
   * Reset the rotation center to the model center — the point a fresh fit
   * orbits around (cell center, or the atoms' centroid without a cell) —
   * keeping the view as {@link setRotationCenter} does.
   */
  resetRotationCenter(): void {
    const snapshot = this.host.getSnapshot();
    if (!snapshot) return;
    const { center } = computeViewBounds({
      ...snapshot,
      positions: this.host.getCurrentPositions(),
    });
    this.setRotationCenter(center[0], center[1], center[2]);
  }

  /** Orthographic half of {@link setRotationCenter}: re-pivot without moving the image. */
  private moveOrbitCenterInPlace(camera: THREE.OrthographicCamera, pivot: THREE.Vector3): void {
    camera.updateMatrixWorld();
    const delta = pivot.clone().sub(this.controls.target);
    const shiftX = delta.dot(this._panRight.setFromMatrixColumn(camera.matrixWorld, 0));
    const shiftY = delta.dot(this._panUp.setFromMatrixColumn(camera.matrixWorld, 1));
    // Moving the camera by `delta` keeps its direction (it still looks at the
    // target, now the pivot) but slides every point by -shift on screen;
    // moving the frustum window by -shift slides them back.
    camera.position.add(delta);
    this.controls.target.copy(pivot);
    camera.left -= shiftX;
    camera.right -= shiftX;
    camera.top -= shiftY;
    camera.bottom -= shiftY;
    this._frustumPanX -= shiftX;
    this._frustumPanY -= shiftY;
    camera.updateProjectionMatrix();
    this.controls.syncImmediate();
  }

  /** Immediately snap any in-progress pivot animation to its final state.
   * Called before zoom or rotation so the interaction always starts from the
   * atom position rather than an intermediate mid-animation position.
   */
  private snapPivotAnimToEnd(): void {
    if (!this.pivotAnim) return;
    this.controls.target.copy(this.pivotAnim.endTarget);
    this.camera.position.copy(this.pivotAnim.endCameraPos);
    this.pivotAnim = null;
    // Sync camera world matrices and the controls' internal state so that
    // subsequent project()/unproject() calls and interaction math use the
    // snapped end pose rather than the mid-animation matrices.
    this.camera.updateMatrixWorld(true);
    this.controls.syncImmediate();
  }

  /**
   * Advance the camera by one render-loop tick: step the pivot animation (or
   * let the controls apply drag momentum) and keep the perspective clipping
   * planes around the model.
   */
  tick(): void {
    // Tick smooth pivot animation (set by setRotationCenter).
    // Both controls.target and camera.position are translated by the same
    // delta so the scene pans to center the clicked atom on screen.
    // Damping momentum is dropped so a decaying rotation from a prior drag
    // does not add unwanted motion.
    if (this.pivotAnim) {
      const t = Math.min(
        (performance.now() - this.pivotAnim.startTime) / this.pivotAnim.duration,
        1,
      );
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
      this.controls.target.lerpVectors(this.pivotAnim.startTarget, this.pivotAnim.endTarget, ease);
      this.camera.position.lerpVectors(
        this.pivotAnim.startCameraPos,
        this.pivotAnim.endCameraPos,
        ease,
      );
      if (t >= 1) this.pivotAnim = null;
      // Sync without momentum so the controls cannot override the
      // manually-set camera position.
      this.controls.syncImmediate();
    } else {
      this.controls.update();
    }

    // Keep perspective near/far tracking the dolly distance so zooming out
    // always brings the model back into the frustum (no-op for orthographic).
    updatePerspectiveClipping(this.camera, this.controls, this.lastExtent);
  }

  /**
   * Build turntable controls for the current camera and wire the renderer's
   * interaction hooks: a starting drag snaps any pivot animation to its end
   * pose, and a finished interaction notifies the camera-change callback.
   */
  private createControls(): CameraControls {
    const controls = new CameraControls(this.camera, this.host.getCanvas());
    controls.upAxis.set(...turntableUpAxis(this.host.getSnapshot()?.box ?? null));
    controls.addEventListener("start", () => {
      this.snapPivotAnimToEnd();
    });
    controls.addEventListener("end", () => {
      this._cameraChangeCallback?.();
    });
    return controls;
  }

  /** Zoom the camera around controls.target using the mouse wheel.
   *
   * Registered on the container in capture phase so it fires before the
   * controls' own wheel listener and replaces it for both projection modes,
   * while leaving touch/pinch zoom (handled by the controls' pointer events)
   * fully intact. Orthographic cameras zoom the frustum around the target;
   * perspective cameras dolly toward it. Both use the same reversible ramp.
   */
  private attachWheelZoomListener(): void {
    const el = this.host.getContainer()!;
    if (this.wheelZoomHandler) {
      el.removeEventListener("wheel", this.wheelZoomHandler, true);
    }
    this.wheelZoomHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation(); // prevent the controls from also processing this

      // Snap pivot animation to its end state so zoom is always centered on
      // the clicked atom, not on an intermediate position mid-animation.
      this.snapPivotAnimToEnd();

      const zoomFactor = wheelZoomFactor(e.deltaY, e.deltaMode, this.controls.zoomSpeed);

      if (this.camera instanceof THREE.OrthographicCamera) {
        // Zoom around controls.target, keeping it fixed on screen. The helper
        // applies a reversible frustum shift; accumulate it into our pan
        // bookkeeping so resize re-applies the same offset.
        const { shiftX, shiftY } = zoomOrthographicAroundTarget(
          this.camera,
          this.controls.target,
          zoomFactor,
        );
        this._frustumPanX += shiftX;
        this._frustumPanY += shiftY;
      } else {
        dollyPerspectiveTowardTarget(this.camera, this.controls.target, zoomFactor);
      }
      this._cameraChangeCallback?.();
    };
    el.addEventListener("wheel", this.wheelZoomHandler, { capture: true, passive: false });
  }

  /**
   * Attach a custom pan listener (right-drag, or Shift+left-drag as in OVITO)
   * that translates only the camera (not controls.target) so the rotation
   * center remains fixed in world space.
   *
   * For orthographic cameras the pan is implemented as a frustum shift so
   * the view direction never changes.  For perspective cameras the camera
   * position is moved directly (the camera tilts slightly to keep looking at
   * the fixed target, which is imperceptible for typical pan magnitudes).
   */
  private attachCustomPanListener(): void {
    const el = this.host.getCanvas();

    const onPointerDown = (e: PointerEvent) => {
      // Shift+left shares the left button with rotation, box selection and
      // Builder drags; those suspend the controls, and so suspend this pan.
      const shiftPan = isShiftPanGesture(e) && this.controls.enabled;
      if (e.button !== 2 && !shiftPan) return;
      if (this.customPanActive) return;
      this.snapPivotAnimToEnd();
      this.customPanActive = true;
      this.customPanLastX = e.clientX;
      this.customPanLastY = e.clientY;
      this.customPanPointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!this.customPanActive || e.pointerId !== this.customPanPointerId) return;
      const dx = e.clientX - this.customPanLastX;
      const dy = e.clientY - this.customPanLastY;
      this.customPanLastX = e.clientX;
      this.customPanLastY = e.clientY;
      // A Builder atom drag that began on the same press disables the
      // controls after this listener ran; the atom drag wins.
      if (!this.controls.enabled) return;
      this.applyCustomPan(dx, dy);
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerId === this.customPanPointerId) {
        this.customPanActive = false;
        this.customPanPointerId = null;
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerEnd);
    el.addEventListener("pointercancel", onPointerEnd);

    this.customPanCleanup = () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerEnd);
      el.removeEventListener("pointercancel", onPointerEnd);
    };
  }

  /** Apply a screen-space pan delta.
   * For OrthographicCamera: shifts the projection frustum (camera.left/right/top/bottom),
   * giving a true screen-space pan without touching camera.position or controls.target.
   * For PerspectiveCamera: translates both camera.position and controls.target together
   * (standard orbit-style pan). */
  private applyCustomPan(screenDx: number, screenDy: number): void {
    const container = this.host.getContainer();
    if (!container) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (W === 0 || H === 0) return;

    if (this.camera instanceof THREE.OrthographicCamera) {
      const frustumW = (this.camera.right - this.camera.left) / this.camera.zoom;
      const frustumH = (this.camera.top - this.camera.bottom) / this.camera.zoom;
      const worldDx = -screenDx * (frustumW / W);
      const worldDy = screenDy * (frustumH / H);
      this.camera.left += worldDx;
      this.camera.right += worldDx;
      this.camera.top += worldDy;
      this.camera.bottom += worldDy;
      this._frustumPanX += worldDx;
      this._frustumPanY += worldDy;
      this.camera.updateProjectionMatrix();
    } else if (this.camera instanceof THREE.PerspectiveCamera) {
      const right = this._panRight.setFromMatrixColumn(this.camera.matrix, 0);
      const up = this._panUp.setFromMatrixColumn(this.camera.matrix, 1);
      const distance = this.camera.position.distanceTo(this.controls.target);
      const vFov = (this.camera.fov * Math.PI) / 180;
      const worldH = 2 * Math.tan(vFov / 2) * distance;
      const worldW = worldH * (W / H);
      const delta = this._panDelta
        .copy(right)
        .multiplyScalar(-screenDx * (worldW / W))
        .addScaledVector(up, screenDy * (worldH / H));
      this.camera.position.add(delta);
      this.controls.target.add(delta);
    }
  }

  /** Set pixel insets for overlay panels that occlude viewport edges. */
  setViewInsets(left: number, right: number): void {
    this.viewInsetLeft = left;
    this.viewInsetRight = right;
    this.applyInsets();
  }

  /** Recalculate the orthographic frustum accounting for overlay insets. */
  private applyInsets(): void {
    if (!(this.camera instanceof THREE.OrthographicCamera)) return;
    const container = this.host.getContainer();
    if (!container) return;
    applyFrustumInsets(
      this.camera,
      container.clientWidth,
      container.clientHeight,
      this.viewInsetLeft,
      this.viewInsetRight,
      this.lastExtent,
    );
    // Re-apply accumulated frustum pan so the view doesn't jump on resize.
    if (this._frustumPanX !== 0 || this._frustumPanY !== 0) {
      this.camera.left += this._frustumPanX;
      this.camera.right += this._frustumPanX;
      this.camera.top += this._frustumPanY;
      this.camera.bottom += this._frustumPanY;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Follow a container resize of `width` × `height` CSS pixels. The
   * orthographic frustum is re-fitted with the insets (camera.zoom is left
   * untouched so the user's zoom level is preserved); a perspective camera
   * only takes the new aspect.
   */
  resize(width: number, height: number): void {
    if (this.camera instanceof THREE.OrthographicCamera) {
      // Recalculate full frustum accounting for overlay insets so the view
      // stays correct when the container aspect ratio changes.
      this.applyInsets();
    } else {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Fit the projection to an off-screen capture of `width` × `height` pixels,
   * keeping the vertical frustum. Undone by the next {@link resize}.
   */
  resizeForCapture(width: number, height: number): void {
    if (this.camera instanceof THREE.OrthographicCamera) {
      const aspect = width / height;
      const frustumHalf = (this.camera.top - this.camera.bottom) / 2;
      this.camera.left = -frustumHalf * aspect;
      this.camera.right = frustumHalf * aspect;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Switch between orthographic and perspective projection. */
  setPerspective(enabled: boolean): void {
    if (this.perspectiveMode === enabled) return;
    this.perspectiveMode = enabled;
    const container = this.host.getContainer();
    if (!container) return;

    const target = this.controls.target.clone();
    const newCamera = createSwitchedCamera(
      this.camera,
      enabled,
      container.clientWidth,
      container.clientHeight,
    );

    // Recreate controls with new camera
    this.controls.dispose();
    this.camera = newCamera;
    this.controls = this.createControls();
    this.controls.target.copy(target);
    this.controls.update();

    const snapshot = this.host.getSnapshot();
    if (snapshot) {
      this.fitToView(snapshot);
    }
  }

  /** Switch projection mode by name (wraps setPerspective for symmetry). */
  setCameraMode(mode: MeganeCameraMode): void {
    this.setPerspective(mode === "perspective");
    this._cameraChangeCallback?.();
  }

  /** Re-fit the camera to the current snapshot's bounding box. */
  resetCamera(): void {
    const snapshot = this.host.getSnapshot();
    if (!snapshot) return;
    this.lastExtent = fitCameraToView(this.camera, this.controls, snapshot);
    const container = this.host.getContainer();
    if (this.camera instanceof THREE.OrthographicCamera && container) {
      applyFrustumInsets(
        this.camera,
        container.clientWidth,
        container.clientHeight,
        this.viewInsetLeft,
        this.viewInsetRight,
        this.lastExtent,
      );
    }
    this._frustumPanX = 0;
    this._frustumPanY = 0;
    this._cameraChangeCallback?.();
  }

  /**
   * Turn the camera to look along a crystallographic (`±a`, `±b`, `±c`) or
   * Cartesian (`±x`, `±y`, `±z`) axis, keeping the current target, distance
   * and zoom. The crystal axes come from the loaded snapshot's cell; without
   * one they coincide with x/y/z. See `cameraOrientation.ts` for the sign
   * and up-vector conventions.
   */
  alignCameraToAxis(axis: ViewAxis): void {
    if (!this.camera || !this.controls) return;
    const snapshot = this.host.getSnapshot();
    const orientation = axisOrientation(axis, snapshot?.box ?? null);
    orientCamera(this.camera, this.controls, orientation);
    if (snapshot) {
      // Resize / inset handling re-fits the orthographic frustum from
      // lastExtent, which is measured along the screen axes.
      this.lastExtent = computeViewBounds(snapshot, orientation).extent;
    }
    this._cameraChangeCallback?.();
  }

  /** Register a callback invoked after each user camera interaction ends. */
  setCameraChangeCallback(cb: (() => void) | null): void {
    this._cameraChangeCallback = cb;
  }

  /**
   * World point under a client pixel on the camera-facing plane through the
   * rotation pivot (controls target). Null before mount.
   */
  screenToWorldAtPivot(clientX: number, clientY: number): [number, number, number] | null {
    const container = this.host.getContainer();
    if (!container || !this.controls) return null;
    const t = this.controls.target;
    return screenToWorldOnPlane(this.camera, container, [t.x, t.y, t.z], clientX, clientY);
  }

  /** Enable/disable the camera controls (and with them Shift+left pan). */
  setControlsEnabled(enabled: boolean): void {
    if (this.controls) this.controls.enabled = enabled;
  }

  /** Read current camera state. Returns null before mount. */
  getCameraState(): MeganeCameraState | null {
    if (!this.camera || !this.controls) return null;
    const pos = this.camera.position;
    const tgt = this.controls.target;
    const up = this.camera.up;
    return {
      mode: this.perspectiveMode ? "perspective" : "orthographic",
      position: [pos.x, pos.y, pos.z],
      target: [tgt.x, tgt.y, tgt.z],
      zoom: this.camera.zoom,
      up: [up.x, up.y, up.z],
    };
  }

  /** Restore camera to a previously saved state. */
  applyCameraState(state: MeganeCameraState): void {
    if (!this.camera || !this.controls) return;
    if ((state.mode === "perspective") !== this.perspectiveMode) {
      this.setPerspective(state.mode === "perspective");
    }
    this.camera.position.set(...state.position);
    this.controls.target.set(...state.target);
    if (state.up) this.camera.up.set(...state.up);
    this.camera.zoom = state.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.syncImmediate();
    this._frustumPanX = 0;
    this._frustumPanY = 0;
  }

  /**
   * Detach the wheel and pan listeners and dispose the controls. Safe after a
   * mount() that threw part-way (no controls yet).
   */
  dispose(): void {
    const container = this.host.getContainer();
    if (this.wheelZoomHandler && container) {
      container.removeEventListener("wheel", this.wheelZoomHandler, true);
      this.wheelZoomHandler = null;
    }
    this.customPanCleanup?.();
    this.customPanCleanup = null;
    this.controls?.dispose();
  }
}
