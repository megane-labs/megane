/**
 * Main molecular viewer class.
 * Owns the Three.js scene, camera, renderer, and controls.
 * Imperative API - framework agnostic.
 *
 * Uses billboard impostor rendering (2-triangle quads + shader) for all
 * atom counts. Scales to 1M+ atoms on mid-range GPUs.
 */

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  Snapshot,
  Frame,
  AtomRenderer,
  BondRenderer,
  HoverInfo,
  SelectionState,
  Measurement,
} from "../types";
// (HoverInfo/Measurement used via return types; keep imports for type compatibility)
import { ImpostorAtomMesh } from "./ImpostorAtomMesh";
import { ImpostorBondMesh } from "./ImpostorBondMesh";
import { CellRenderer } from "./CellRenderer";
import { CellAxesRenderer } from "./CellAxesRenderer";
import { LabelOverlay } from "./LabelOverlay";
import { ArrowRenderer } from "./ArrowRenderer";
import { PolyhedronRenderer } from "./PolyhedronRenderer";
import { StructureLayer } from "./StructureLayer";
import { PivotMarker } from "./PivotMarker";
import { CartoonRenderer } from "./CartoonRenderer";
import { SurfaceRenderer } from "./SurfaceRenderer";
import { LineRenderer } from "./LineRenderer";
import { DrawingBoundaryAtomRenderer } from "./CellBoundaryAtomRenderer";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { generateDrawingBoundaryImages } from "../logic/cellBoundaryImages";
import type { MeshData } from "../pipeline/types";
import {
  getRadius,
  BALL_STICK_ATOM_SCALE,
  LICORICE_RADIUS,
  SPACEFILL_ATOM_SCALE,
} from "../constants";
import { pickAtPixel, projectToScreen, atomsInRect, type ClientRect } from "./Picking";
import { computeMeasurement } from "./Selection";
import { FpsCounter } from "./FpsCounter";
import { perfMark, perfMeasure, perfPushFrame, perfRendererReady } from "../perf";
import {
  computeViewBounds,
  fitCameraToView,
  applyFrustumInsets,
  createSwitchedCamera,
  updatePerspectiveClipping,
  zoomOrthographicAroundTarget,
  type ViewExtent,
} from "./CameraManager";

const _testMode = (() => {
  try {
    const g = globalThis as { __MEGANE_TEST__?: boolean };
    if (g.__MEGANE_TEST__) return true;
    if (typeof window !== "undefined" && window.location?.search) {
      const p = new URLSearchParams(window.location.search);
      if (p.get("test") === "1") return true;
    }
    // E2E hosts (notably ms-toolsai.jupyter widget output and the
    // VSCode webview) render the megane bundle inside a nested iframe
    // that the test runner can only reach via Page.addInitScript on the
    // outer page. Inherit the flag from the parent window when the same
    // origin allows it. Cross-origin access throws; we silently fall
    // back to false.
    if (typeof window !== "undefined" && window.parent && window.parent !== window) {
      const pg = (window.parent as Window & { __MEGANE_TEST__?: boolean }).__MEGANE_TEST__;
      if (pg) return true;
    }
  } catch {
    /* noop */
  }
  return false;
})();

/**
 * True when running under E2E (via `?test=1`, `__MEGANE_TEST__`, or an iframed
 * host inheriting it from the parent). Consumers use this to keep non-
 * deterministic UI (e.g. the live FPS readout) stable for screenshot baselines.
 */
export function isMeganeTestMode(): boolean {
  return _testMode;
}

/** Remove and dispose every child of a THREE.Group (meshes and lines). */
function clearGroup(group: THREE.Group): void {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    }
  }
}

/**
 * Draw translucent highlight spheres (1.6× atom radius) over the given atoms.
 * `radiusScale` must match the fraction of the vdW radius the atoms are drawn
 * at, or the highlight ends up buried inside a spacefill sphere.
 */
function drawHighlightSpheres(
  group: THREE.Group,
  atomIndices: number[],
  positions: Float32Array,
  elements: Uint8Array,
  color: number,
  opacity: number,
  radiusScale: number = BALL_STICK_ATOM_SCALE,
): void {
  for (const atomIdx of atomIndices) {
    const r = getRadius(elements[atomIdx]) * radiusScale * 1.6;
    const geo = new THREE.SphereGeometry(r, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.position.set(
      positions[atomIdx * 3],
      positions[atomIdx * 3 + 1],
      positions[atomIdx * 3 + 2],
    );
    group.add(sphere);
  }
}

interface MeganeTestReady {
  firstFrame: boolean;
  dataLoaded: boolean;
  frame: number;
  renderEpoch: number;
  atomCount?: number;
  /**
   * Count of trajectory frames applied via updateFrame(). E2E capture
   * helpers gate on `framesApplied >= 1` before screenshotting a
   * multi-frame structure: lazily decoded trajectories (XTC worker) apply
   * frame 0 asynchronously after load, so without the gate a capture races
   * the decode and lands on either the base snapshot or the frame-0
   * positions nondeterministically.
   */
  framesApplied?: number;
}

export interface MeganeProjectedAtom {
  index: number;
  sx: number;
  sy: number;
  depth: number;
  element: number;
}

export type MeganeCameraMode = "perspective" | "orthographic";

export interface MeganeCameraState {
  mode: MeganeCameraMode;
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
}

export interface MeganeSubsystemVisibility {
  atoms: boolean;
  bonds: boolean;
  cell: boolean;
  cellAxes: boolean;
  vectors: boolean;
  labels: boolean;
  polyhedra: boolean;
  cartoon: boolean;
  surface: boolean;
  line: boolean;
}

/** Representation mode for the viewer. */
export type RepresentationType =
  | "atoms"
  | "licorice"
  | "cartoon"
  | "both"
  | "surface"
  | "line"
  | "illustrative";

export interface MeganeRendererMemory {
  geometries: number;
  textures: number;
}

export interface MeganeTestApi {
  getProjectedAtomPositions: () => MeganeProjectedAtom[];
  getCameraState: () => MeganeCameraState | null;
  getVisibleSubsystems: () => MeganeSubsystemVisibility;
  setCameraMode: (mode: MeganeCameraMode) => void;
  resetCamera: () => void;
  getRendererMemory: () => MeganeRendererMemory | null;
}

let _activeRenderer: MoleculeRenderer | null = null;

function _setActiveRenderer(r: MoleculeRenderer | null): void {
  _activeRenderer = r;
  if (!_testMode || typeof window === "undefined") return;
  const w = window as Window & { __megane_test?: MeganeTestApi };
  if (r === null) {
    delete w.__megane_test;
    return;
  }
  if (!w.__megane_test) {
    w.__megane_test = {
      getProjectedAtomPositions: () =>
        _activeRenderer ? _activeRenderer.testGetProjectedAtomPositions() : [],
      getCameraState: () => (_activeRenderer ? _activeRenderer.testGetCameraState() : null),
      getVisibleSubsystems: () =>
        _activeRenderer
          ? _activeRenderer.testGetVisibleSubsystems()
          : {
              atoms: false,
              bonds: false,
              cell: false,
              cellAxes: false,
              vectors: false,
              labels: false,
              polyhedra: false,
              cartoon: false,
              surface: false,
              line: false,
            },
      setCameraMode: (mode) => _activeRenderer?.setCameraMode(mode),
      resetCamera: () => _activeRenderer?.resetCamera(),
      getRendererMemory: () => {
        const info = _activeRenderer?.getRenderer().info.memory;
        return info ? { geometries: info.geometries, textures: info.textures } : null;
      },
    };
  }
}

function _getTestReady(): MeganeTestReady | null {
  if (!_testMode) return null;
  if (typeof window === "undefined") return null;
  const w = window as Window & { __megane_test_ready?: MeganeTestReady };
  if (!w.__megane_test_ready) {
    w.__megane_test_ready = {
      firstFrame: false,
      dataLoaded: false,
      frame: 0,
      renderEpoch: 0,
    };
  }
  return w.__megane_test_ready;
}

function _signalRender(hasSnapshot: boolean): void {
  const r = _getTestReady();
  if (!r || !hasSnapshot) return;
  r.firstFrame = true;
  r.renderEpoch = (r.renderEpoch ?? 0) + 1;
}

export class MoleculeRenderer {
  private container: HTMLElement | null = null;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private perspectiveMode = false;
  private atomRenderer: AtomRenderer | null = null;
  private bondRenderer: BondRenderer | null = null;
  private cellRenderer: CellRenderer | null = null;
  /** Display-only periodic copies for atoms on inclusive cell boundaries. */
  private drawingBoundaryAtomRenderer: DrawingBoundaryAtomRenderer | null = null;
  private currentDrawingBoundary: DrawingBoundaryData | null = null;
  /** Neighbor images added outside the drawing range to complete visible centers. */
  private bondPeriodicAtomRenderer: DrawingBoundaryAtomRenderer | null = null;
  private currentBondPeriodicImages: PeriodicAtomImageData | null = null;
  private drawingBoundaryHiddenMask: Uint8Array | null = null;
  private representationHiddenMask: Uint8Array | null = null;
  private cellAxesRenderer: CellAxesRenderer | null = null;
  private labelOverlay: LabelOverlay | null = null;
  private arrowRenderer: ArrowRenderer | null = null;
  private polyhedronRenderer: PolyhedronRenderer | null = null;
  private pivotMarker: PivotMarker | null = null;
  private useImpostor = false;
  private animationId: number | null = null;
  private fpsCounter = new FpsCounter();
  private snapshot: Snapshot | null = null;
  private lastExtent: ViewExtent = { maxExtent: 1, extentX: 1, extentY: 1 };
  private currentPositions: Float32Array | null = null;
  /**
   * Bonds pushed via updateBondsExt before a snapshot/bondRenderer existed.
   * Replayed inside loadSnapshot. Guards against PipelineViewer's
   * parent-before-child effect ordering, where applyViewportState calls
   * updateBondsExt before Viewport calls loadSnapshot.
   */
  private pendingBonds: {
    bonds: Uint32Array;
    bondOrders: Uint8Array | null;
    positions: Float32Array | null;
    elements: Uint8Array | null;
    nAtoms: number;
  } | null = null;
  /** Axes-inset drag state */
  private axesDragging = false;
  private axesDragLastX = 0;
  private axesDragLastY = 0;
  private atomScale = 1.0;
  private atomOpacity = 1.0;
  private bondScale = 1.0;
  private bondOpacity = 1.0;
  /**
   * Whether the active pipeline produces bonds for the primary structure.
   * Composed with `representationType` to decide bond mesh visibility, so a
   * pipeline that doesn't generate bonds never re-shows stale geometry from a
   * previous structure when the representation toggles back to "atoms"/"both".
   */
  private bondsAvailable = false;
  /**
   * Current per-atom RGB overrides applied to the primary structure
   * (length === nAtoms*3, NaN sentinel for "fall through to base"). Null
   * means atoms render with the default CPK palette.
   */
  private currentColorOverrides: Float32Array | null = null;
  private currentAtomScaleOverrides: Float32Array | null = null;
  private currentAtomOpacityOverrides: Float32Array | null = null;
  private currentLabels: string[] | null = null;
  private viewInsetLeft = 0;
  private viewInsetRight = 0;
  private dprMediaQuery: MediaQueryList | null = null;
  private dprChangeHandler: (() => void) | null = null;
  // Cached dimensions for frame-synchronous resize detection
  private lastContainerW = 0;
  private lastContainerH = 0;
  private lastDpr = 1;
  /** Duration of the smooth pivot animation in milliseconds. */
  private static readonly PIVOT_ANIM_DURATION_MS = 400;
  /** Smooth pivot animation state (set by setRotationCenter). */
  private pivotAnim: {
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startCameraPos: THREE.Vector3;
    endCameraPos: THREE.Vector3;
    startTime: number;
    duration: number;
  } | null = null;

  /** Custom pan handler state (right-mouse drag, replaces OrbitControls pan). */
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
  // Re-applied after doApplyFrustumInsets; reset when a new rotation center is set.
  private _frustumPanX = 0;
  private _frustumPanY = 0;

  private wheelZoomHandler: ((e: WheelEvent) => void) | null = null;

  /** True until the first frame has been rendered after mount; used for perf hook. */
  private firstFramePending = true;

  /** Called when the user finishes a camera interaction (drag end). */
  private _cameraChangeCallback: (() => void) | null = null;

  /** Structure layers for multi-structure overlay rendering. */
  private layers = new Map<string, StructureLayer>();

  /** Cartoon backbone renderer (lazy, created on first use). */
  private cartoonRenderer: CartoonRenderer | null = null;
  /** Solvent-accessible surface renderer (lazy, created on first use). */
  private surfaceRenderer: SurfaceRenderer | null = null;
  /** Line / wireframe renderer (lazy, created on first use). */
  private lineRenderer: LineRenderer | null = null;
  private representationType: RepresentationType = "atoms";
  /** Per-atom representation override (see setRepresentationByAtom). */
  private representationByAtom: RepresentationType[] | null = null;

  // (screen-space picking replaces Three.js raycasting)

  // Atom selection & measurement
  private selectedAtoms: number[] = [];
  private selectionGroup = new THREE.Group();
  // Inspector preview highlight — an arbitrary-size, uncapped set drawn in a
  // distinct color, independent of the 4-atom measurement selection above.
  private previewSelectionGroup = new THREE.Group();

  /** Mount the viewer into a DOM element. */
  mount(container: HTMLElement): void {
    perfMark("megane:mount:start");
    this.container = container;

    // Renderer. Creating the WebGLRenderer throws if the host cannot give us a
    // WebGL2 context (hardware acceleration disabled, blocklisted driver, a
    // headless/remote GPU process, etc). Rethrow with an actionable message so
    // the ErrorBoundary can explain it instead of leaving a blank panel.
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: true,
      });
    } catch (err) {
      throw new Error(
        "Failed to create a WebGL2 context. megane needs WebGL2 with hardware " +
          "acceleration enabled. " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.setClearColor(0xffffff, 1);
    // Position both canvases identically within the container
    // to prevent sub-pixel layout drift at non-100% browser zoom.
    // Use CSS 100% sizing instead of explicit pixel values so the canvas
    // always matches the container exactly, even at fractional zoom levels.
    const domEl = this.renderer.domElement;
    domEl.style.display = "block";
    domEl.style.position = "absolute";
    domEl.style.top = "0";
    domEl.style.left = "0";
    domEl.style.width = "100%";
    domEl.style.height = "100%";
    container.appendChild(domEl);

    // Label overlay (Canvas 2D on top of WebGL)
    this.labelOverlay = new LabelOverlay();
    container.appendChild(this.labelOverlay.getCanvas());
    this.labelOverlay.resize(
      container.clientWidth,
      container.clientHeight,
      Math.min(window.devicePixelRatio, 2),
    );

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

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

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.rotateSpeed = 0.8;
    this.controls.zoomSpeed = 1.2;
    // Disable built-in pan and handle right-drag via attachCustomPanListener(),
    // which translates both camera.position and controls.target together so the
    // rotation pivot always stays at the screen center.
    this.controls.enablePan = false;
    this.attachPivotCancelListener();
    this.attachWheelZoomListener();
    this.attachCustomPanListener();
    this.controls.addEventListener("end", () => {
      this._cameraChangeCallback?.();
    });

    // Lighting - hemisphere + 3-point
    const hemi = new THREE.HemisphereLight(0xddeeff, 0x997744, 0.4);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(50, 50, 50);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-30, 20, -20);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
    rimLight.position.set(0, -30, -50);
    this.scene.add(rimLight);

    // Selection overlay group
    this.scene.add(this.selectionGroup);
    this.scene.add(this.previewSelectionGroup);

    // Pivot marker (3D crosshair at rotation center)
    this.pivotMarker = new PivotMarker();
    this.scene.add(this.pivotMarker.group);

    // Resize observer
    const resizeObserver = new ResizeObserver(() => this.onResize());
    resizeObserver.observe(container);

    // Listen for DPR changes (e.g. moving window between displays)
    this.setupDprListener();

    // Start render loop
    this.animate();

    // Expose this instance to the test API (no-op outside _testMode).
    _setActiveRenderer(this);
  }

  /**
   * Load a molecular snapshot (topology + positions).
   *
   * `opts.fit` (default true) controls the closing fitToView. Pass false when
   * the snapshot is a re-mapping of the one already on screen (same topology,
   * new positions — e.g. the wrap node toggling wrap/unwrap): the camera then
   * keeps its current zoom/target instead of re-fitting to the new bounds.
   */
  loadSnapshot(snapshot: Snapshot, opts: { fit?: boolean } = {}): void {
    this.snapshot = snapshot;
    this.currentPositions = new Float32Array(snapshot.positions);

    const _ready = _getTestReady();
    if (_ready) {
      _ready.dataLoaded = true;
      _ready.atomCount = snapshot.nAtoms;
    }

    // Always use impostor rendering for consistent behavior at any atom count
    if (this.atomRenderer === null || !this.useImpostor) {
      this.swapRenderers(true);
    }

    this.atomRenderer!.loadSnapshot(snapshot);
    if (this.currentColorOverrides) {
      (this.atomRenderer as ImpostorAtomMesh).applyColorOverrides(this.currentColorOverrides);
    }
    // Bond loading is handled exclusively by the pipeline via updateBondsExt/updateBonds
    // (called from applyViewportState). This avoids race conditions between
    // Viewport's loadSnapshot and MeganeViewer's applyViewportState effects.
    // If updateBondsExt ran before this snapshot existed (PipelineViewer's
    // parent-before-child effect ordering), the bonds were stashed — replay
    // them now that this.snapshot and this.bondRenderer are ready.
    this.flushPendingBonds();

    // Re-apply stored scale after loading snapshot data
    if (this.atomScale !== 1.0 && this.atomRenderer!.setScale) {
      this.atomRenderer!.setScale(this.atomScale, snapshot);
    }

    // Drawing ranges are inclusive: a crystallographic atom
    // on x/y/z=0 is therefore also drawn at the equivalent x/y/z=1 boundary.
    // Keep these copies in a separate, non-pickable visual layer so atom
    // indices and molecular topology remain unchanged.
    if (!this.drawingBoundaryAtomRenderer) {
      this.drawingBoundaryAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.drawingBoundaryAtomRenderer.group);
    }
    this.drawingBoundaryAtomRenderer.loadSnapshot(snapshot, this.currentDrawingBoundary);
    this.drawingBoundaryAtomRenderer.setScale(this.atomScale);
    this.drawingBoundaryAtomRenderer.setOpacity(this.atomOpacity);
    this.drawingBoundaryAtomRenderer.setScaleOverrides(this.currentAtomScaleOverrides);
    this.drawingBoundaryAtomRenderer.setOpacityOverrides(this.currentAtomOpacityOverrides);
    this.drawingBoundaryAtomRenderer.applyColorOverrides(this.currentColorOverrides);
    this.drawingBoundaryAtomRenderer.setVisible(
      this.representationType === "atoms" ||
        this.representationType === "both" ||
        this.representationType === "licorice",
    );
    if (!this.bondPeriodicAtomRenderer) {
      this.bondPeriodicAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.bondPeriodicAtomRenderer.group);
    }
    this.bondPeriodicAtomRenderer.loadImages(snapshot, this.currentBondPeriodicImages);
    this.bondPeriodicAtomRenderer.setScale(this.atomScale);
    this.bondPeriodicAtomRenderer.setOpacity(this.atomOpacity);
    this.bondPeriodicAtomRenderer.setScaleOverrides(this.currentAtomScaleOverrides);
    this.bondPeriodicAtomRenderer.setOpacityOverrides(this.currentAtomOpacityOverrides);
    this.bondPeriodicAtomRenderer.applyColorOverrides(this.currentColorOverrides);
    this.bondPeriodicAtomRenderer.setVisible(
      this.representationType === "atoms" ||
        this.representationType === "both" ||
        this.representationType === "licorice",
    );
    this.applyCombinedAtomHiddenMask();

    // Update label overlay
    this.syncLabelOverlay();

    // Initialize arrow renderer (lazy)
    if (!this.arrowRenderer) {
      this.arrowRenderer = new ArrowRenderer(snapshot.nAtoms);
      this.scene.add(this.arrowRenderer.mesh);
    }
    this.arrowRenderer.setAtomPositions(snapshot.positions, snapshot.nAtoms);

    // Update cartoon renderer (lazy init, only if snapshot has Cα data)
    if (snapshot.caIndices && snapshot.caIndices.length > 0) {
      if (!this.cartoonRenderer) {
        this.cartoonRenderer = new CartoonRenderer();
        this.scene.add(this.cartoonRenderer.mesh);
      }
      this.cartoonRenderer.loadSnapshot(snapshot);
      this.cartoonRenderer.setVisible(
        this.representationType === "cartoon" || this.representationType === "both",
      );
    } else if (this.cartoonRenderer) {
      this.cartoonRenderer.setVisible(false);
    }

    // Update surface renderer (lazy init, always available for surface mode)
    if (!this.surfaceRenderer) {
      this.surfaceRenderer = new SurfaceRenderer();
      this.scene.add(this.surfaceRenderer.mesh);
    }
    if (this.representationType === "surface") {
      this.surfaceRenderer.loadSnapshot(snapshot);
      this.surfaceRenderer.setVisible(true);
    } else {
      this.surfaceRenderer.setVisible(false);
    }

    // Update line renderer (lazy init, always available for line mode)
    if (!this.lineRenderer) {
      this.lineRenderer = new LineRenderer();
      this.scene.add(this.lineRenderer.mesh);
    }
    this.lineRenderer.loadSnapshot(snapshot);
    this.lineRenderer.setVisible(this.representationType === "line");

    // Update simulation cell
    if (snapshot.box) {
      const hasNonZero = snapshot.box.some((v) => v !== 0);
      if (hasNonZero) {
        if (!this.cellRenderer) {
          this.cellRenderer = new CellRenderer();
          this.scene.add(this.cellRenderer.mesh);
        }
        this.cellRenderer.loadBox(snapshot.box, snapshot.boxOrigin);
      }
      if (hasNonZero) {
        try {
          if (!this.cellAxesRenderer) {
            this.cellAxesRenderer = new CellAxesRenderer();
          }
          this.cellAxesRenderer.loadBox(snapshot.box);
        } catch (e) {
          console.warn("CellAxesRenderer init error:", e);
          this.cellAxesRenderer = null;
        }
      }
    }

    // Re-establish any per-atom representation: loading a snapshot rebuilt the
    // atom/line geometry from scratch and cleared the hide masks, so a mixed
    // "water as lines" view would otherwise revert to uniform on reload.
    if (this.representationByAtom) {
      this.setRepresentationByAtom(this.representationByAtom);
    }

    if (opts.fit !== false) {
      this.fitToView(snapshot);
    } else {
      // Camera untouched, but the extent drives zoom clamping elsewhere —
      // keep it in sync with the new positions.
      this.lastExtent = computeViewBounds(snapshot).extent;
    }
  }

  /** Update positions from a trajectory frame.
   *
   * Fast path (uniform trajectory): the frame carries only positions, so this
   * is a positions-only update reusing the frame-0 snapshot's topology and
   * cell — allocation-free, exactly as before.
   *
   * Slow path (heterogeneous trajectory): the frame additionally carries
   * `elements`/`bonds`/`box`, so the atom/bond meshes and unit cell are rebuilt
   * to match this frame's differing atom count, elements, or cell.
   */
  updateFrame(frame: Frame): void {
    if (!this.snapshot || !this.atomRenderer || !this.bondRenderer) return;
    if (!this.currentPositions || this.currentPositions.length < frame.positions.length) {
      this.currentPositions = new Float32Array(frame.positions.length);
    }
    this.currentPositions.set(frame.positions);

    if (frame.elements !== undefined) {
      // Heterogeneous topology: rebuild atoms + bonds for this frame.
      this.updateFrameTopology(frame);
    } else {
      // Uniform fast path: positions only.
      this.atomRenderer.updatePositions(frame.positions);
      this.labelOverlay?.setPositions(frame.positions);
      this.arrowRenderer?.setAtomPositions(frame.positions, frame.nAtoms);
      this.bondRenderer.updatePositions(frame.positions, this.snapshot.bonds, this.snapshot.nBonds);
    }

    // Per-frame unit cell (heterogeneous cell), independent of topology.
    if (frame.box) {
      // Per-frame origin when the frame carries one, else reuse the snapshot's.
      this.updateFrameCell(frame.box, frame.boxOrigin ?? this.snapshot?.boxOrigin ?? null);
    }

    // Boundary membership can change as atoms cross a periodic face, so keep
    // the display-only copies synchronized with trajectory coordinates too.
    if (this.currentDrawingBoundary) {
      const frameSnapshot: Snapshot = {
        ...this.snapshot,
        nAtoms: frame.nAtoms,
        positions: frame.positions,
        elements: frame.elements ?? this.snapshot.elements,
        box: frame.box ?? this.snapshot.box,
        boxOrigin: frame.boxOrigin ?? this.snapshot.boxOrigin,
      };
      this.currentDrawingBoundary = generateDrawingBoundaryImages(
        frameSnapshot,
        this.currentDrawingBoundary.min,
        this.currentDrawingBoundary.max,
      );
      this.drawingBoundaryAtomRenderer?.loadSnapshot(frameSnapshot, this.currentDrawingBoundary);
      this.syncLabelOverlay();
    }

    this.cartoonRenderer?.updatePositions(frame.positions);
    if (this.surfaceRenderer?.mesh.visible) {
      this.surfaceRenderer.updatePositions(frame.positions);
    }
    if (this.lineRenderer?.mesh.visible) {
      this.lineRenderer.updatePositions(frame.positions);
    }
    if (this.selectedAtoms.length > 0) {
      this.updateSelectionVisuals();
    }

    const _ready = _getTestReady();
    if (_ready) {
      const idx = (frame as Frame & { index?: number }).index;
      _ready.frame = typeof idx === "number" ? idx : (_ready.frame ?? 0);
      _ready.framesApplied = (_ready.framesApplied ?? 0) + 1;
    }
  }

  /**
   * Rebuild the atom and bond geometry for a heterogeneous trajectory frame
   * whose atom count / elements differ from frame 0. The atom mesh's
   * pre-allocated instance buffers grow on demand (they never shrink), so this
   * only rewrites radii/colors and flips `instanceCount`; the bond mesh is
   * rebuilt from the frame's own bonds. Only reached on the slow path.
   */
  private updateFrameTopology(frame: Frame): void {
    const snapshot = this.snapshot!;
    const elements = frame.elements!;
    const synth: Snapshot = {
      ...snapshot,
      nAtoms: frame.nAtoms,
      positions: frame.positions,
      elements,
      // Frame-0 backbone/cartoon data does not apply to a re-topologised frame.
      caIndices: undefined,
      caChainIds: undefined,
      caResNums: undefined,
      caSsType: undefined,
    };
    this.atomRenderer!.loadSnapshot(synth);
    if (this.currentColorOverrides) {
      (this.atomRenderer as ImpostorAtomMesh).applyColorOverrides?.(this.currentColorOverrides);
    }
    if (this.atomScale !== 1.0 && this.atomRenderer!.setScale) {
      this.atomRenderer!.setScale(this.atomScale, synth);
    }
    this.labelOverlay?.setAtomData(elements, frame.nAtoms);
    this.labelOverlay?.setPositions(frame.positions);
    this.arrowRenderer?.setAtomPositions(frame.positions, frame.nAtoms);

    // Bonds: prefer the frame's own inferred bonds; fall back to frame 0.
    const bonds = frame.bonds ?? snapshot.bonds;
    this.updateBondsExt(bonds, null, frame.positions, elements, frame.nAtoms);
  }

  /** Redraw the simulation cell for a heterogeneous per-frame cell. */
  private updateFrameCell(box: Float32Array, origin?: Float32Array | null): void {
    if (!box.some((v) => v !== 0)) return;
    if (!this.cellRenderer) {
      this.cellRenderer = new CellRenderer();
      this.scene.add(this.cellRenderer.mesh);
    }
    this.cellRenderer.loadBox(box, origin);
    try {
      if (!this.cellAxesRenderer) {
        this.cellAxesRenderer = new CellAxesRenderer();
      }
      this.cellAxesRenderer.loadBox(box);
    } catch (e) {
      console.warn("CellAxesRenderer per-frame update error:", e);
      this.cellAxesRenderer = null;
    }
  }

  /**
   * Replace bond data and re-render bonds without resetting the camera.
   * Used for per-frame bond recalculation (e.g. distance-based bonds).
   */
  updateBonds(bonds: Uint32Array, bondOrders: Uint8Array | null): void {
    if (!this.snapshot || !this.bondRenderer) return;
    const positions = this.currentPositions ?? this.snapshot.positions;
    const updated: Snapshot = {
      ...this.snapshot,
      nBonds: bonds.length / 2,
      bonds,
      bondOrders,
    };
    this.snapshot = updated;
    this.bondRenderer.loadSnapshot({ ...updated, positions });
    if (this.bondScale !== 1.0 && this.bondRenderer.setScale) {
      this.bondRenderer.setScale(this.bondScale, updated);
    }
    this.syncBondColorsToAtoms();
  }

  /**
   * Replace bond data with optional extended positions/elements (PBC ghost atoms).
   * When positions/elements are provided, they include ghost atoms appended to
   * the original arrays, and bond indices may reference those ghost atoms.
   */
  updateBondsExt(
    bonds: Uint32Array,
    bondOrders: Uint8Array | null,
    positions: Float32Array | null,
    elements: Uint8Array | null,
    nAtoms: number,
  ): void {
    if (!this.snapshot || !this.bondRenderer) {
      // Called before the snapshot/bondRenderer exist (PipelineViewer's
      // parent-before-child effect ordering). Stash the args and replay them
      // in loadSnapshot, since applyViewportState may never call us again
      // (its bondIndices memo guard skips identical references).
      this.pendingBonds = { bonds, bondOrders, positions, elements, nAtoms };
      return;
    }
    // Reached the live path — any earlier stash is now superseded.
    this.pendingBonds = null;
    const pos = positions ?? this.currentPositions ?? this.snapshot.positions;
    const elems = elements ?? this.snapshot.elements;
    const atomCount = nAtoms || this.snapshot.nAtoms;
    const extSnap = {
      ...this.snapshot,
      nAtoms: atomCount,
      nBonds: bonds.length / 2,
      bonds,
      bondOrders,
      positions: pos,
      elements: elems,
    };
    this.bondRenderer.loadSnapshot(extSnap);
    if (this.bondScale !== 1.0 && this.bondRenderer.setScale) {
      this.bondRenderer.setScale(this.bondScale, this.snapshot);
    }
    this.syncBondColorsToAtoms(extSnap);
  }

  /**
   * Replay bonds that updateBondsExt stashed because it ran before a snapshot
   * existed. Called from loadSnapshot once this.snapshot and this.bondRenderer
   * are ready, so the replayed updateBondsExt passes its guard.
   */
  private flushPendingBonds(): void {
    if (!this.pendingBonds) return;
    const p = this.pendingBonds;
    this.pendingBonds = null;
    this.updateBondsExt(p.bonds, p.bondOrders, p.positions, p.elements, p.nAtoms);
  }

  /** Set per-atom labels for overlay display. */
  setLabels(labels: string[] | null): void {
    this.currentLabels = labels;
    this.syncLabelOverlay();
  }

  /** Apply the pipeline's Drawing Boundary atom collection. */
  setDrawingBoundary(boundary: DrawingBoundaryData | null): void {
    this.currentDrawingBoundary = boundary;
    if (boundary && this.snapshot) {
      const hidden = new Uint8Array(this.snapshot.nAtoms);
      for (let atom = 0; atom < hidden.length; atom++) {
        hidden[atom] = boundary.sourceVisibleMask[atom] ? 0 : 1;
      }
      this.drawingBoundaryHiddenMask = hidden;
    } else {
      this.drawingBoundaryHiddenMask = null;
    }
    if (this.snapshot) {
      if (!this.drawingBoundaryAtomRenderer) {
        this.drawingBoundaryAtomRenderer = new DrawingBoundaryAtomRenderer();
        this.scene.add(this.drawingBoundaryAtomRenderer.group);
      }
      this.drawingBoundaryAtomRenderer.loadSnapshot(this.snapshot, boundary);
      this.drawingBoundaryAtomRenderer.setVisible(
        this.representationType === "atoms" ||
          this.representationType === "both" ||
          this.representationType === "licorice",
      );
      this.applyCombinedAtomHiddenMask();
      this.syncLabelOverlay();
    }
  }

  /** Apply outside-boundary neighbor images emitted by a coordination/bond stream. */
  setBondPeriodicImages(images: PeriodicAtomImageData | null): void {
    this.currentBondPeriodicImages = images;
    if (!this.snapshot) return;
    if (!this.bondPeriodicAtomRenderer) {
      this.bondPeriodicAtomRenderer = new DrawingBoundaryAtomRenderer();
      this.scene.add(this.bondPeriodicAtomRenderer.group);
    }
    this.bondPeriodicAtomRenderer.loadImages(this.snapshot, images);
    this.bondPeriodicAtomRenderer.setScale(this.atomScale);
    this.bondPeriodicAtomRenderer.setOpacity(this.atomOpacity);
    this.bondPeriodicAtomRenderer.setScaleOverrides(this.currentAtomScaleOverrides);
    this.bondPeriodicAtomRenderer.setOpacityOverrides(this.currentAtomOpacityOverrides);
    this.bondPeriodicAtomRenderer.applyColorOverrides(this.currentColorOverrides);
    this.bondPeriodicAtomRenderer.setHiddenMask(this.representationHiddenMask);
    this.bondPeriodicAtomRenderer.setVisible(
      this.representationType === "atoms" ||
        this.representationType === "both" ||
        this.representationType === "licorice",
    );
    this.syncLabelOverlay();
  }

  private applyCombinedAtomHiddenMask(): void {
    const nAtoms = this.snapshot?.nAtoms ?? 0;
    let combined: Uint8Array | null = null;
    if (this.drawingBoundaryHiddenMask || this.representationHiddenMask) {
      combined = new Uint8Array(nAtoms);
      for (let atom = 0; atom < nAtoms; atom++) {
        combined[atom] =
          this.drawingBoundaryHiddenMask?.[atom] || this.representationHiddenMask?.[atom] ? 1 : 0;
      }
    }
    this.atomRenderer?.setHiddenMask?.(combined);
    // Drawing Boundary copies are already range-filtered; only representation
    // hiding is mapped from their source atom.
    this.drawingBoundaryAtomRenderer?.setHiddenMask(this.representationHiddenMask);
    this.bondPeriodicAtomRenderer?.setHiddenMask(this.representationHiddenMask);
  }

  private syncLabelOverlay(): void {
    if (!this.labelOverlay || !this.snapshot) return;
    const basePositions = this.currentPositions ?? this.snapshot.positions;
    const boundary = this.currentDrawingBoundary;
    const boundaryImages = boundary?.images ?? null;
    const bondImages = this.currentBondPeriodicImages;
    if (!boundaryImages && !bondImages) {
      this.labelOverlay.setAtomData(this.snapshot.elements, this.snapshot.nAtoms);
      this.labelOverlay.setPositions(basePositions);
      this.labelOverlay.setLabels(this.currentLabels);
      return;
    }

    const nBoundaryImages = boundaryImages?.sourceIndices.length ?? 0;
    const nBondImages = bondImages?.sourceIndices.length ?? 0;
    const nDisplay = this.snapshot.nAtoms + nBoundaryImages + nBondImages;
    const positions = new Float32Array(nDisplay * 3);
    positions.set(basePositions.subarray(0, this.snapshot.nAtoms * 3));
    if (boundaryImages) positions.set(boundaryImages.positions, this.snapshot.nAtoms * 3);
    if (bondImages) {
      positions.set(bondImages.positions, (this.snapshot.nAtoms + nBoundaryImages) * 3);
    }
    const elements = new Uint8Array(nDisplay);
    elements.set(this.snapshot.elements);
    if (boundaryImages) elements.set(boundaryImages.elements, this.snapshot.nAtoms);
    if (bondImages) elements.set(bondImages.elements, this.snapshot.nAtoms + nBoundaryImages);
    const labels = new Array<string>(nDisplay).fill("");
    if (this.currentLabels) {
      for (let atom = 0; atom < this.snapshot.nAtoms; atom++) {
        if (!boundary || boundary.sourceVisibleMask[atom]) {
          labels[atom] = this.currentLabels[atom] ?? "";
        }
      }
      for (let image = 0; image < nBoundaryImages; image++) {
        labels[this.snapshot.nAtoms + image] =
          this.currentLabels[boundaryImages!.sourceIndices[image]] ?? "";
      }
      for (let image = 0; image < nBondImages; image++) {
        labels[this.snapshot.nAtoms + nBoundaryImages + image] =
          this.currentLabels[bondImages!.sourceIndices[image]] ?? "";
      }
    }
    this.labelOverlay.setAtomData(elements, nDisplay);
    this.labelOverlay.setPositions(positions);
    this.labelOverlay.setLabels(this.currentLabels ? labels : null);
  }

  /** Set per-atom vector data for arrow display. */
  setVectors(vectors: Float32Array | null): void {
    this.arrowRenderer?.setVectors(vectors);
  }

  /** Set arrow scale multiplier. */
  setVectorScale(scale: number): void {
    this.arrowRenderer?.setScale(scale);
  }

  /** Load polyhedra mesh data for rendering. */
  loadPolyhedra(data: MeshData): void {
    if (!this.polyhedronRenderer) {
      this.polyhedronRenderer = new PolyhedronRenderer();
      this.scene.add(this.polyhedronRenderer.group);
    }
    this.polyhedronRenderer.loadMeshData(data);
  }

  /** Clear all polyhedra from the scene. */
  clearPolyhedra(): void {
    if (this.polyhedronRenderer) {
      this.polyhedronRenderer.clear();
    }
  }

  // ── Structure Layer Management ─────────────────────────────────

  /** Get or create a structure layer for a given node ID. */
  getOrCreateLayer(layerId: string): StructureLayer {
    let layer = this.layers.get(layerId);
    if (!layer) {
      layer = new StructureLayer(layerId, this.scene);
      this.layers.set(layerId, layer);
    }
    return layer;
  }

  /** Get an existing structure layer (or undefined). */
  getLayer(layerId: string): StructureLayer | undefined {
    return this.layers.get(layerId);
  }

  /** Remove a structure layer and dispose its resources. */
  removeLayer(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (layer) {
      layer.dispose();
      this.layers.delete(layerId);
    }
  }

  /** Get all current layer IDs. */
  getLayerIds(): string[] {
    return Array.from(this.layers.keys());
  }

  /** Remove layers not in the given set of active IDs. */
  removeInactiveLayers(activeIds: Set<string>): void {
    for (const [id, layer] of this.layers) {
      if (!activeIds.has(id)) {
        layer.dispose();
        this.layers.delete(id);
      }
    }
  }

  /**
   * Fit camera to show all structures (from all layers + primary snapshot).
   * Call after loading snapshots into layers.
   */
  fitToViewAll(): void {
    // Collect all snapshots from layers
    const snapshots: Snapshot[] = [];
    if (this.snapshot) snapshots.push(this.snapshot);
    for (const layer of this.layers.values()) {
      if (layer.snapshot) snapshots.push(layer.snapshot);
    }
    if (snapshots.length === 0) return;

    // Use the first snapshot for fitToView (simple approach)
    // TODO: merge bounding boxes from all snapshots for true fit
    this.fitToView(snapshots[0]);
  }

  /** Set atom radius scale multiplier. */
  setAtomScale(scale: number): void {
    this.atomScale = scale;
    if (this.atomRenderer?.setScale && this.snapshot) {
      this.atomRenderer.setScale(scale, this.snapshot);
    }
    this.drawingBoundaryAtomRenderer?.setScale(scale);
    this.bondPeriodicAtomRenderer?.setScale(scale);
  }

  /** Set atom opacity (independent of bonds). */
  setAtomOpacity(opacity: number): void {
    this.atomOpacity = opacity;
    this.atomRenderer?.setOpacity?.(opacity);
    this.drawingBoundaryAtomRenderer?.setOpacity(opacity);
    this.bondPeriodicAtomRenderer?.setOpacity(opacity);
  }

  /** Set per-atom scale overrides from selection pipeline. */
  setAtomScaleOverrides(overrides: Float32Array): void {
    this.currentAtomScaleOverrides = overrides;
    this.atomRenderer?.setScaleOverrides?.(overrides);
    this.drawingBoundaryAtomRenderer?.setScaleOverrides(overrides);
    this.bondPeriodicAtomRenderer?.setScaleOverrides(overrides);
  }

  /** Set per-atom opacity overrides from selection pipeline. */
  setAtomOpacityOverrides(overrides: Float32Array): void {
    this.currentAtomOpacityOverrides = overrides;
    this.atomRenderer?.setOpacityOverrides?.(overrides);
    this.drawingBoundaryAtomRenderer?.setOpacityOverrides(overrides);
    this.bondPeriodicAtomRenderer?.setOpacityOverrides(overrides);
  }

  /** Clear all per-atom overrides, reverting to global uniforms. */
  clearAtomOverrides(): void {
    this.currentAtomScaleOverrides = null;
    this.currentAtomOpacityOverrides = null;
    this.atomRenderer?.clearOverrides?.();
    this.drawingBoundaryAtomRenderer?.clearOverrides();
    this.bondPeriodicAtomRenderer?.clearOverrides();
  }

  /** Set bond radius scale multiplier. */
  setBondScale(scale: number): void {
    this.bondScale = scale;
    if (this.bondRenderer?.setScale && this.snapshot) {
      this.bondRenderer.setScale(scale, this.snapshot);
    }
  }

  /** Set bond opacity (independent of atoms). */
  setBondOpacity(opacity: number): void {
    this.bondOpacity = opacity;
    this.bondRenderer?.setOpacity?.(opacity);
  }

  /**
   * Apply per-atom RGB overrides for the primary structure. Null reverts to
   * the default CPK palette for every atom. Identity comparison short-circuits
   * the GPU upload when the same buffer reference is supplied repeatedly.
   */
  applyAtomColorOverrides(overrides: Float32Array | null): void {
    if (overrides === this.currentColorOverrides) return;
    this.currentColorOverrides = overrides;
    if (!this.snapshot || !this.atomRenderer) return;

    // Reset to base CPK by re-loading the snapshot with no color context.
    this.atomRenderer.loadSnapshot(this.snapshot);
    if (this.atomScale !== 1.0 && this.atomRenderer.setScale) {
      this.atomRenderer.setScale(this.atomScale, this.snapshot);
    }
    if (overrides) {
      (this.atomRenderer as ImpostorAtomMesh).applyColorOverrides(overrides);
    }
    this.drawingBoundaryAtomRenderer?.applyColorOverrides(overrides);
    this.bondPeriodicAtomRenderer?.applyColorOverrides(overrides);
    this.syncBondColorsToAtoms();
  }

  /**
   * Re-derive per-bond colors from the current atom mesh color buffer. Called
   * after atom colors change (override application) or after the bond mesh
   * reloads (`updateBonds*`) so the two stay in sync.
   */
  private syncBondColorsToAtoms(snapshotOverride?: Snapshot): void {
    const snap = snapshotOverride ?? this.snapshot;
    if (!snap || !this.atomRenderer || !this.bondRenderer) return;
    if (snap.nBonds === 0) return;
    const atom = this.atomRenderer as ImpostorAtomMesh;
    const bond = this.bondRenderer as ImpostorBondMesh;
    bond.recomputeColorsFromAtomBuffer(atom.getColorBuffer(), snap);
  }

  /** Apply per-bond opacity overrides (one value per logical bond). */
  setBondOpacityOverrides(overrides: Float32Array): void {
    this.bondRenderer?.setBondOpacityOverrides?.(overrides);
  }

  /** Clear per-bond opacity overrides, reverting to global opacity. */
  clearBondOpacityOverrides(): void {
    this.bondRenderer?.clearBondOpacityOverrides?.();
  }

  /** Toggle atom visibility. */
  setAtomsVisible(visible: boolean): void {
    if (this.atomRenderer) {
      this.atomRenderer.mesh.visible = visible;
    }
    this.drawingBoundaryAtomRenderer?.setVisible(visible);
    this.bondPeriodicAtomRenderer?.setVisible(visible);
  }

  /**
   * Switch between atom/bond and cartoon representation modes.
   * "atoms"  – classic ball-and-stick (default)
   * "cartoon" – Cα backbone only; atoms/bonds hidden
   * "both"   – cartoon overlaid on atoms/bonds
   * "surface" – solvent-accessible surface only
   * "line"   – VMD/PyMOL-style thin wireframe lines; atoms/bonds meshes hidden
   * "illustrative" – Mol*-style spacefill spheres at full vdW radius with flat,
   *                  unlit shading and a silhouette outline; bonds hidden
   */
  setRepresentationType(type: RepresentationType): void {
    this.representationType = type;
    const illustrative = type === "illustrative";
    const showAtoms = type === "atoms" || type === "both" || type === "licorice" || illustrative;
    // Illustrative draws touching vdW spheres, so the sticks it would hide
    // anyway are switched off (matching Mol*'s spacefill-only preset).
    const showBonds = showAtoms && !illustrative;
    const showCartoon = type === "cartoon" || type === "both";
    const showSurface = type === "surface";
    const showLine = type === "line";

    // Licorice: render atoms and bonds at a single equal radius so the spheres
    // act as round caps on the sticks, producing a continuous tube. Reverting
    // to ball-and-stick (atoms/both) restores per-element vdW atom radii and
    // per-order bond radii. setUniformRadius only rewrites the radius buffers.
    // Illustrative instead keeps per-element radii but at full vdW size.
    if (this.snapshot) {
      const licoriceRadius = type === "licorice" ? LICORICE_RADIUS : null;
      const radiusScale = illustrative ? SPACEFILL_ATOM_SCALE : BALL_STICK_ATOM_SCALE;
      this.atomRenderer?.setRadiusScale?.(radiusScale, this.snapshot);
      this.drawingBoundaryAtomRenderer?.setRadiusScale(radiusScale);
      this.bondPeriodicAtomRenderer?.setRadiusScale(radiusScale);
      this.atomRenderer?.setUniformRadius?.(licoriceRadius, this.snapshot);
      this.bondRenderer?.setUniformRadius?.(licoriceRadius, this.snapshot);
      this.drawingBoundaryAtomRenderer?.setUniformRadius(licoriceRadius);
      this.bondPeriodicAtomRenderer?.setUniformRadius(licoriceRadius);
    }
    this.atomRenderer?.setIllustrative?.(illustrative);
    this.drawingBoundaryAtomRenderer?.setIllustrative(illustrative);
    this.bondPeriodicAtomRenderer?.setIllustrative(illustrative);

    if (this.atomRenderer) this.atomRenderer.mesh.visible = showAtoms;
    this.drawingBoundaryAtomRenderer?.setVisible(showAtoms);
    this.bondPeriodicAtomRenderer?.setVisible(showAtoms);
    // Bonds also depend on whether the pipeline emits any bonds; otherwise
    // stale geometry from a previous structure would resurface here.
    if (this.bondRenderer) this.bondRenderer.mesh.visible = showBonds && this.bondsAvailable;
    if (this.cartoonRenderer) {
      // Only show cartoon when it has backbone data
      const hasBackbone = this.snapshot?.caIndices != null && this.snapshot.caIndices.length > 0;
      this.cartoonRenderer.setVisible(showCartoon && hasBackbone);
    }
    if (this.surfaceRenderer) {
      if (showSurface && this.snapshot) {
        this.surfaceRenderer.loadSnapshot(this.snapshot);
      }
      this.surfaceRenderer.setVisible(showSurface);
    }
    if (this.lineRenderer) {
      this.lineRenderer.setVisible(showLine);
    }
  }

  /**
   * Fraction of the vdW radius the atom spheres are currently drawn at.
   * Anything that has to line up with a rendered sphere — picking, selection
   * highlights — must scale by this rather than assuming ball-and-stick.
   */
  private atomRadiusScale(): number {
    return this.representationType === "illustrative"
      ? SPACEFILL_ATOM_SCALE
      : BALL_STICK_ATOM_SCALE;
  }

  /**
   * Apply a per-atom representation: atoms flagged `"line"` are drawn by the
   * line renderer while every other atom keeps the global mesh representation
   * (`setRepresentationType`). This enables mixed views such as "show the water
   * as lines while the rest stays ball-and-stick". Pass `null` to revert to the
   * uniform global representation.
   *
   * Must run *after* `setRepresentationType`, which establishes the base mesh
   * mode and reloads the line geometry; this overlays the per-atom split on top.
   */
  setRepresentationByAtom(modes: RepresentationType[] | null): void {
    this.representationByAtom = modes;

    if (!modes) {
      this.atomRenderer?.setHiddenMask?.(null);
      this.representationHiddenMask = null;
      this.applyCombinedAtomHiddenMask();
      this.bondRenderer?.setHiddenMask?.(null);
      if (this.lineRenderer && this.snapshot) {
        this.lineRenderer.loadSnapshot(this.snapshot);
        this.lineRenderer.setVisible(this.representationType === "line");
      }
      return;
    }

    const n = this.snapshot?.nAtoms ?? modes.length;
    const lineMask = new Uint8Array(n);
    let anyLine = false;
    for (let i = 0; i < n; i++) {
      if (modes[i] === "line") {
        lineMask[i] = 1;
        anyLine = true;
      }
    }

    // Hide the line atoms (and their bonds) from the mesh renderers; the line
    // renderer draws just that subset instead.
    this.atomRenderer?.setHiddenMask?.(anyLine ? lineMask : null);
    this.representationHiddenMask = anyLine ? lineMask : null;
    this.applyCombinedAtomHiddenMask();
    this.bondRenderer?.setHiddenMask?.(anyLine ? lineMask : null);
    if (this.lineRenderer && this.snapshot) {
      this.lineRenderer.loadSnapshot(this.snapshot, anyLine ? lineMask : null);
      // Keep lines visible for the subset even when the base mesh mode isn't
      // "line"; if no atom is line-mode, defer to the global toggle.
      this.lineRenderer.setVisible(anyLine || this.representationType === "line");
    }
  }

  /**
   * Set whether the active pipeline emits bonds for the primary structure.
   * The bond mesh is only shown when this AND the current representation
   * (`atoms`/`both`) both call for bonds — otherwise switching templates
   * would resurface stale bond geometry once the representation toggles
   * back to atoms.
   */
  setBondsVisible(visible: boolean): void {
    this.bondsAvailable = visible;
    if (this.bondRenderer) {
      // "illustrative" shows atoms but never bonds — its spacefill spheres
      // already touch, so a stick would only ever be hidden geometry.
      const showBonds =
        this.representationType === "atoms" ||
        this.representationType === "both" ||
        this.representationType === "licorice";
      this.bondRenderer.mesh.visible = visible && showBonds;
    }
  }

  /** Toggle simulation cell visibility. */
  setCellVisible(visible: boolean): void {
    if (this.cellRenderer) {
      this.cellRenderer.setVisible(visible);
    }
  }

  /** Check if cell data exists. */
  hasCell(): boolean {
    return this.cellRenderer !== null && this.cellRenderer.mesh.visible;
  }

  /** Toggle cell axes indicator visibility. */
  setCellAxesVisible(visible: boolean): void {
    if (this.cellAxesRenderer) {
      this.cellAxesRenderer.setVisible(visible);
    }
  }

  /** Toggle rotation-center marker visibility. */
  setPivotMarkerVisible(visible: boolean): void {
    this.pivotMarker?.setVisible(visible);
  }

  // ── Axes inset drag API ───────────────────────────────────

  /** Returns true if the CSS-pixel coordinate hits the axes inset. */
  hitTestAxesInset(cssX: number, cssY: number): boolean {
    if (!this.cellAxesRenderer || !this.container) return false;
    return this.cellAxesRenderer.hitTest(cssX, cssY, this.container.clientHeight);
  }

  /** Begin an axes-inset drag at the given CSS coordinates. */
  startAxesDrag(cssX: number, cssY: number): void {
    this.axesDragging = true;
    this.axesDragLastX = cssX;
    this.axesDragLastY = cssY;
    // Disable orbit controls while dragging the inset
    this.controls.enabled = false;
  }

  /** Continue an axes-inset drag. Returns true if currently dragging. */
  moveAxesDrag(cssX: number, cssY: number): boolean {
    if (!this.axesDragging || !this.cellAxesRenderer || !this.container) return false;
    const dx = cssX - this.axesDragLastX;
    const dy = cssY - this.axesDragLastY;
    this.axesDragLastX = cssX;
    this.axesDragLastY = cssY;
    this.cellAxesRenderer.moveBy(dx, dy, this.container.clientWidth, this.container.clientHeight);
    return true;
  }

  /** End the axes-inset drag. */
  endAxesDrag(): void {
    if (!this.axesDragging) return;
    this.axesDragging = false;
    this.controls.enabled = true;
  }

  /** Whether an axes drag is in progress. */
  isAxesDragging(): boolean {
    return this.axesDragging;
  }

  /** Check if cell axes data exists. */
  hasCellAxes(): boolean {
    return this.cellAxesRenderer !== null;
  }

  /** Swap between InstancedMesh and Impostor renderers. */
  private swapRenderers(impostor: boolean): void {
    // Remove old renderers
    if (this.atomRenderer) {
      this.scene.remove(this.atomRenderer.mesh);
      this.atomRenderer.dispose();
    }
    if (this.bondRenderer) {
      this.scene.remove(this.bondRenderer.mesh);
      this.bondRenderer.dispose();
    }

    this.useImpostor = impostor;

    const atoms = new ImpostorAtomMesh();
    const bonds = new ImpostorBondMesh();
    this.atomRenderer = atoms;
    this.bondRenderer = bonds;

    this.scene.add(this.atomRenderer.mesh);
    this.scene.add(this.bondRenderer.mesh);

    // Re-apply stored appearance settings
    if (this.atomOpacity !== 1.0) {
      this.atomRenderer.setOpacity?.(this.atomOpacity);
    }
    if (this.bondOpacity !== 1.0) {
      this.bondRenderer.setOpacity?.(this.bondOpacity);
    }
  }

  /** Fit camera to show all atoms (or simulation cell if present). */
  private fitToView(snapshot: Snapshot): void {
    this.lastExtent = fitCameraToView(this.camera, this.controls, snapshot);
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.doApplyFrustumInsets();
    }
  }

  /** Reset view to fit all atoms. */
  resetView(): void {
    if (this.snapshot) {
      this.fitToView(this.snapshot);
    }
  }

  /** Set the rotation center (orbit target) to the given world coordinates.
   * @param animate  - When true (default), smoothly animates the transition over
   *   PIVOT_ANIM_DURATION_MS.  Pass false to update synchronously (legacy behaviour).
   * The clicked atom is animated to the screen center.
   */
  setRotationCenter(x: number, y: number, z: number, animate = true): void {
    // Clear accumulated frustum pan so the new rotation center is centered in
    // the viewport after the animation completes.
    this._frustumPanX = 0;
    this._frustumPanY = 0;
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.doApplyFrustumInsets(); // snap frustum back to clean state
    }
    const endTarget = new THREE.Vector3(x, y, z);
    if (!animate) {
      this.pivotAnim = null;
      this.controls.target.copy(endTarget);
      this.controls.update();
      return;
    }
    const startTarget = this.controls.target.clone();
    const delta = endTarget.clone().sub(startTarget);
    const startCameraPos = this.camera.position.clone();
    const endCameraPos = startCameraPos.clone().add(delta);

    // Translate both controls.target and camera.position by the same delta
    // so the scene pans smoothly to center the clicked atom on screen.
    // Damping is disabled during animation frames (see render loop) to
    // prevent residual sphericalDelta from adding unwanted rotation.
    this.pivotAnim = {
      startTarget,
      endTarget,
      startCameraPos,
      endCameraPos,
      startTime: performance.now(),
      duration: MoleculeRenderer.PIVOT_ANIM_DURATION_MS,
    };
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
    // Sync camera world matrices and OrbitControls internal state so that
    // subsequent project()/unproject() calls and interaction math use the
    // snapped end pose rather than the mid-animation matrices.
    this.camera.updateMatrixWorld(true);
    const wasDamping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = wasDamping;
  }

  private attachPivotCancelListener(): void {
    this.controls.addEventListener("start", () => {
      this.snapPivotAnimToEnd();
    });
  }

  /** Zoom orthographic camera centered on controls.target using mouse wheel.
   *
   * Registered on the container in capture phase so it fires before
   * OrbitControls' bubble-phase wheel listener, letting us intercept only
   * wheel events for orthographic cameras while leaving touch/pinch dolly
   * (handled by OrbitControls' pointer events) fully intact.
   */
  private attachWheelZoomListener(): void {
    const el = this.container!;
    if (this.wheelZoomHandler) {
      el.removeEventListener("wheel", this.wheelZoomHandler, true);
    }
    this.wheelZoomHandler = (e: WheelEvent) => {
      if (!(this.camera instanceof THREE.OrthographicCamera)) return;
      e.preventDefault();
      e.stopPropagation(); // prevent OrbitControls from also processing this

      // Snap pivot animation to its end state so zoom is always centered on
      // the clicked atom, not on an intermediate position mid-animation.
      this.snapPivotAnimToEnd();

      // Normalize deltaY across deltaMode (pixel / line / page)
      let delta = e.deltaY;
      if (e.deltaMode === 1 /* DOM_DELTA_LINE */) delta *= 40;
      else if (e.deltaMode === 2 /* DOM_DELTA_PAGE */) delta *= 800;

      // Mirror OrbitControls' getZoomScale: exponential ramp with zoomSpeed
      const scale = Math.pow(0.95, this.controls.zoomSpeed * Math.abs(delta) * 0.01);
      const zoomFactor = delta < 0 ? 1 / scale : scale;

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
    };
    el.addEventListener("wheel", this.wheelZoomHandler, { capture: true, passive: false });
  }

  /**
   * Attach a custom right-mouse-drag pan listener that translates only the
   * camera (not controls.target) so the rotation center remains fixed in
   * world space.
   *
   * For orthographic cameras the pan is implemented as a frustum shift so
   * the view direction never changes.  For perspective cameras the camera
   * position is moved directly (the camera tilts slightly to keep looking at
   * the fixed target, which is imperceptible for typical pan magnitudes).
   */
  private attachCustomPanListener(): void {
    const el = this.renderer.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2) return;
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
   * (standard OrbitControls pan). */
  private applyCustomPan(screenDx: number, screenDy: number): void {
    if (!this.container) return;
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
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
    this.doApplyFrustumInsets();
  }

  /** Recalculate the orthographic frustum accounting for overlay insets. */
  private doApplyFrustumInsets(): void {
    if (!(this.camera instanceof THREE.OrthographicCamera)) return;
    if (!this.container) return;
    applyFrustumInsets(
      this.camera,
      this.container.clientWidth,
      this.container.clientHeight,
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

  /** Switch between orthographic and perspective projection. */
  setPerspective(enabled: boolean): void {
    if (this.perspectiveMode === enabled) return;
    this.perspectiveMode = enabled;
    if (!this.container) return;

    const target = this.controls.target.clone();
    const newCamera = createSwitchedCamera(
      this.camera,
      enabled,
      this.container.clientWidth,
      this.container.clientHeight,
    );

    // Recreate controls with new camera
    const oldDamping = this.controls.enableDamping;
    const oldDampingFactor = this.controls.dampingFactor;
    const oldRotateSpeed = this.controls.rotateSpeed;
    const oldZoomSpeed = this.controls.zoomSpeed;
    this.controls.dispose();
    this.camera = newCamera;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = oldDamping;
    this.controls.dampingFactor = oldDampingFactor;
    this.controls.rotateSpeed = oldRotateSpeed;
    this.controls.zoomSpeed = oldZoomSpeed;
    this.controls.enablePan = false;
    this.controls.target.copy(target);
    this.controls.update();
    this.attachPivotCancelListener();
    this.attachWheelZoomListener();

    if (this.snapshot) {
      this.fitToView(this.snapshot);
    }
  }

  /** Get the canvas element for event listener attachment. */
  getCanvas(): HTMLCanvasElement | null {
    return this.renderer?.domElement ?? null;
  }

  /** Get the Three.js scene. */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /** Get the active camera. */
  getCamera(): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    return this.camera;
  }

  /** Get the WebGL renderer. */
  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Live rendering stats for the performance HUD: current FPS (updated by the
   * rAF loop) and the draw-call count of the most recent frame. megane draws
   * with instanced meshes, so draw calls — not a scene mesh-object count — are
   * the meaningful GPU-load metric.
   */
  getStats(): { fps: number; drawCalls: number } {
    return {
      fps: this.fpsCounter.fps,
      drawCalls: this.renderer?.info.render.calls ?? 0,
    };
  }

  /** Get the label overlay canvas. */
  getLabelOverlay(): LabelOverlay | null {
    return this.labelOverlay;
  }

  /**
   * Render a single frame synchronously at the current (or custom) size.
   * Used for image/video capture outside the rAF loop.
   */
  renderSingleFrame(): void {
    this.controls.update();

    if (this.polyhedronRenderer && this.container) {
      const sz = new THREE.Vector2();
      this.renderer.getSize(sz);
      this.polyhedronRenderer.updateResolution(sz.x, sz.y);
    }

    this.renderer.render(this.scene, this.camera);

    const _size = new THREE.Vector2();
    this.renderer.getSize(_size);
    const _dpr = this.renderer.getPixelRatio();

    if (this.cellAxesRenderer) {
      try {
        this.cellAxesRenderer.render(this.renderer, this.camera, _size.x, _size.y);
      } catch (e) {
        console.warn("CellAxesRenderer render error:", e);
      }
    }

    if (this.labelOverlay) {
      this.labelOverlay.render(this.camera, _size.x, _size.y, _dpr);
    }

    _signalRender(this.snapshot != null);
  }

  /**
   * Temporarily resize the renderer for capture, suppressing auto-resize.
   * Returns a restore function to call after capture is complete.
   */
  resizeForCapture(width: number, height: number): () => void {
    const savedW = this.lastContainerW;
    const savedH = this.lastContainerH;
    const savedDpr = this.lastDpr;

    // Set size at 1:1 pixel ratio for exact resolution control
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.labelOverlay?.resize(width, height, 1);

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

    // Update cached values to prevent animate() from overriding
    this.lastContainerW = width;
    this.lastContainerH = height;
    this.lastDpr = 1;

    return () => {
      this.lastContainerW = savedW;
      this.lastContainerH = savedH;
      this.lastDpr = savedDpr;
      this.onResize();
    };
  }

  /** Update the Three.js scene and canvas background color (e.g. when theme changes). */
  setBackgroundColor(hexColor: number): void {
    if (this.renderer) this.renderer.setClearColor(hexColor, 1);
    if (this.scene) this.scene.background = new THREE.Color(hexColor);
  }

  /** Get a copy of current atom positions (public, for external use). */
  getCurrentPositionsCopy(): Float32Array | null {
    if (!this.snapshot) return null;
    return new Float32Array(this.currentPositions ?? this.snapshot.positions);
  }

  /** Get current atom positions (may reflect trajectory frame). */
  private getCurrentPositions(): Float32Array {
    return this.currentPositions ?? this.snapshot!.positions;
  }

  // ---- Raycasting ----

  /** Perform a pick at the given screen coordinates using CPU screen-space projection. */
  raycastAtPixel(clientX: number, clientY: number): HoverInfo {
    if (!this.container || !this.snapshot) return null;
    return pickAtPixel(
      this.camera,
      this.container,
      this.snapshot,
      this.getCurrentPositions(),
      this.atomScale,
      clientX,
      clientY,
      this.currentDrawingBoundary,
      this.currentBondPeriodicImages,
      this.atomRadiusScale(),
    );
  }

  // ---- Selection & Measurement ----

  /** Toggle atom selection (right-click). Returns new selection state. */
  toggleAtomSelection(atomIndex: number): SelectionState {
    const idx = this.selectedAtoms.indexOf(atomIndex);
    if (idx >= 0) {
      this.selectedAtoms.splice(idx, 1);
    } else {
      if (this.selectedAtoms.length >= 4) {
        this.selectedAtoms.shift();
      }
      this.selectedAtoms.push(atomIndex);
    }
    this.updateSelectionVisuals();
    return { atoms: [...this.selectedAtoms] };
  }

  /** Set selected atoms directly (for external triggers). Returns new selection state. */
  setSelection(atomIndices: number[]): SelectionState {
    this.selectedAtoms = atomIndices.slice(0, 4);
    this.updateSelectionVisuals();
    return { atoms: [...this.selectedAtoms] };
  }

  /**
   * Highlight an arbitrary set of atoms as a live "preview" of the Selection
   * Inspector's current selection (green, translucent). Independent of the
   * measurement selection. Pass `null` or `[]` to clear.
   */
  setPreviewSelection(atomIndices: number[] | null): void {
    clearGroup(this.previewSelectionGroup);
    if (!this.snapshot || !atomIndices || atomIndices.length === 0) return;
    drawHighlightSpheres(
      this.previewSelectionGroup,
      atomIndices,
      this.getCurrentPositions(),
      this.snapshot.elements,
      0x22c55e,
      0.3,
      this.atomRadiusScale(),
    );
  }

  /** Return the indices of atoms whose centers fall inside a screen rectangle. */
  selectAtomsInRect(rect: ClientRect): number[] {
    if (!this.container || !this.snapshot) return [];
    return atomsInRect(
      this.camera,
      this.container,
      this.snapshot,
      this.getCurrentPositions(),
      rect,
      this.currentDrawingBoundary,
      this.currentBondPeriodicImages,
    );
  }

  /** Enable/disable orbit controls (used to suspend camera rotation during a box drag). */
  setControlsEnabled(enabled: boolean): void {
    if (this.controls) this.controls.enabled = enabled;
  }

  /** Clear all selected atoms. */
  clearSelection(): void {
    this.selectedAtoms = [];
    this.updateSelectionVisuals();
  }

  /** Compute the current geometric measurement based on selected atoms. */
  getMeasurement(): Measurement | null {
    if (!this.snapshot || this.selectedAtoms.length < 2) return null;
    return computeMeasurement(this.getCurrentPositions(), this.selectedAtoms);
  }

  private updateSelectionVisuals(): void {
    clearGroup(this.selectionGroup);

    if (!this.snapshot || this.selectedAtoms.length === 0) return;

    const pos = this.getCurrentPositions();
    const elements = this.snapshot.elements;

    // Highlight spheres
    drawHighlightSpheres(
      this.selectionGroup,
      this.selectedAtoms,
      pos,
      elements,
      0x4285f4,
      0.35,
      this.atomRadiusScale(),
    );

    // Connecting lines
    if (this.selectedAtoms.length >= 2) {
      const points = this.selectedAtoms.map(
        (i) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]),
      );
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x4285f4,
        depthTest: false,
      });
      const line = new THREE.Line(lineGeo, lineMat);
      line.renderOrder = 999;
      this.selectionGroup.add(line);
    }
  }

  private setupDprListener(): void {
    const update = () => {
      this.onResize();
      // Re-register for the new DPR value
      this.dprMediaQuery?.removeEventListener("change", update);
      this.dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      this.dprChangeHandler = update;
      this.dprMediaQuery.addEventListener("change", update);
    };
    this.dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprChangeHandler = update;
    this.dprMediaQuery.addEventListener("change", update);
  }

  private onResize(): void {
    if (!this.container) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = Math.min(window.devicePixelRatio, 2);

    // Update cached values so animate() doesn't trigger a redundant resize
    this.lastContainerW = w;
    this.lastContainerH = h;
    this.lastDpr = dpr;

    this.renderer.setPixelRatio(dpr);

    if (this.camera instanceof THREE.OrthographicCamera) {
      // Recalculate full frustum accounting for overlay insets so the view
      // stays correct when the container aspect ratio changes.
      // camera.zoom is left untouched so the user's zoom level is preserved.
      this.doApplyFrustumInsets();
    } else {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.setSize(w, h, false);
    this.labelOverlay?.resize(w, h, dpr);
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    // Synchronize renderer state BEFORE rendering — this eliminates
    // timing gaps between ResizeObserver/matchMedia and rAF callbacks.
    // When browser zoom changes, clientWidth/DPR update immediately but
    // ResizeObserver may fire after the next rAF, causing the viewport
    // and canvas buffer to be out of sync for one or more frames.
    if (this.container) {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      const dpr = Math.min(window.devicePixelRatio, 2);
      if (w !== this.lastContainerW || h !== this.lastContainerH || dpr !== this.lastDpr) {
        this.lastContainerW = w;
        this.lastContainerH = h;
        this.lastDpr = dpr;
        this.onResize();
      }
    }

    // Tick smooth pivot animation (set by setRotationCenter).
    // Both controls.target and camera.position are translated by the same
    // delta so the scene pans to center the clicked atom on screen.
    // Damping is temporarily disabled so residual sphericalDelta from prior
    // interaction does not add unwanted rotation.
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
      // Update with damping off so sphericalDelta is zeroed and cannot
      // override the manually-set camera position.
      const wasDamping = this.controls.enableDamping;
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.enableDamping = wasDamping;
    } else {
      this.controls.update();
    }

    // Keep perspective near/far tracking the dolly distance so zooming out
    // always brings the model back into the frustum (no-op for orthographic).
    updatePerspectiveClipping(this.camera, this.controls, this.lastExtent);

    // Update pivot marker position and scale
    if (this.pivotMarker) {
      this.pivotMarker.update(this.controls.target, this.camera);
    }

    // Sync LineMaterial resolution for polyhedron fat edges
    if (this.polyhedronRenderer && this.container) {
      this.polyhedronRenderer.updateResolution(
        this.container.clientWidth,
        this.container.clientHeight,
      );
    }

    this.renderer.render(this.scene, this.camera);

    // Use renderer's internal size for all post-render passes.
    // This guarantees the viewport/dimensions match the canvas buffer,
    // even if container.clientWidth has changed since the last setSize().
    const _size = new THREE.Vector2();
    this.renderer.getSize(_size);
    const _dpr = this.renderer.getPixelRatio();

    // Render cell axes inset (after main scene, before label overlay)
    if (this.cellAxesRenderer) {
      try {
        this.cellAxesRenderer.render(this.renderer, this.camera, _size.x, _size.y);
      } catch (e) {
        console.warn("CellAxesRenderer render error:", e);
        this.cellAxesRenderer = null;
      }
    }

    if (this.labelOverlay) {
      this.labelOverlay.render(this.camera, _size.x, _size.y, _dpr);
    }

    _signalRender(this.snapshot != null);

    // Update the live FPS counter (drives the performance HUD; cheap and
    // always on, unlike the __MEGANE_PERF__-gated frame buffer below).
    const now = performance.now();
    this.fpsCounter.tick(now);

    // Performance hooks (no-op unless window.__MEGANE_PERF__ is set)
    perfPushFrame(now);
    if (this.firstFramePending) {
      this.firstFramePending = false;
      perfMark("megane:mount:firstFrame");
      perfMeasure("megane:first-render", "megane:mount:start", "megane:mount:firstFrame");
      perfRendererReady();
    }
  };

  /** Clean up all resources. */
  dispose(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.clearSelection();
    if (this.atomRenderer) this.atomRenderer.dispose();
    if (this.drawingBoundaryAtomRenderer) this.drawingBoundaryAtomRenderer.dispose();
    if (this.bondPeriodicAtomRenderer) this.bondPeriodicAtomRenderer.dispose();
    if (this.bondRenderer) this.bondRenderer.dispose();
    if (this.cellRenderer) this.cellRenderer.dispose();
    if (this.cellAxesRenderer) this.cellAxesRenderer.dispose();
    if (this.arrowRenderer) this.arrowRenderer.dispose();
    if (this.polyhedronRenderer) this.polyhedronRenderer.dispose();
    if (this.cartoonRenderer) this.cartoonRenderer.dispose();
    if (this.surfaceRenderer) this.surfaceRenderer.dispose();
    if (this.lineRenderer) this.lineRenderer.dispose();
    if (this.pivotMarker) this.pivotMarker.dispose();
    if (this.labelOverlay) this.labelOverlay.dispose();
    // Dispose all structure layers
    for (const layer of this.layers.values()) {
      layer.dispose();
    }
    this.layers.clear();
    if (this.dprMediaQuery && this.dprChangeHandler) {
      this.dprMediaQuery.removeEventListener("change", this.dprChangeHandler);
    }
    if (this.wheelZoomHandler && this.container) {
      this.container.removeEventListener("wheel", this.wheelZoomHandler, true);
      this.wheelZoomHandler = null;
    }
    this.customPanCleanup?.();
    this.customPanCleanup = null;
    this.controls.dispose();
    this.renderer.dispose();
    if (this.container && this.renderer.domElement.parentNode) {
      this.container.removeChild(this.renderer.domElement);
    }
    if (_activeRenderer === this) {
      _setActiveRenderer(null);
    }
  }

  // ---- Test-only API (gated on _testMode via _setActiveRenderer) ----
  // These methods exist so Playwright specs can observe renderer state
  // without driving non-deterministic mouse paths. They are wired to
  // window.__megane_test only when _testMode is true; outside tests they
  // are harmless instance methods.

  /** Switch projection mode by name (wraps setPerspective for symmetry). */
  setCameraMode(mode: MeganeCameraMode): void {
    this.setPerspective(mode === "perspective");
    this._cameraChangeCallback?.();
  }

  /** Re-fit the camera to the current snapshot's bounding box. */
  resetCamera(): void {
    if (!this.snapshot) return;
    this.lastExtent = fitCameraToView(this.camera, this.controls, this.snapshot);
    if (this.camera instanceof THREE.OrthographicCamera && this.container) {
      applyFrustumInsets(
        this.camera,
        this.container.clientWidth,
        this.container.clientHeight,
        this.viewInsetLeft,
        this.viewInsetRight,
        this.lastExtent,
      );
    }
    this._frustumPanX = 0;
    this._frustumPanY = 0;
    this._cameraChangeCallback?.();
  }

  /** Register a callback invoked after each user camera interaction ends. */
  setCameraChangeCallback(cb: (() => void) | null): void {
    this._cameraChangeCallback = cb;
  }

  /** Read current camera state. Returns null before mount. */
  getCameraState(): MeganeCameraState | null {
    if (!this.camera || !this.controls) return null;
    const pos = this.camera.position;
    const tgt = this.controls.target;
    return {
      mode: this.perspectiveMode ? "perspective" : "orthographic",
      position: [pos.x, pos.y, pos.z],
      target: [tgt.x, tgt.y, tgt.z],
      zoom: this.camera.zoom,
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
    this.camera.zoom = state.zoom;
    this.camera.updateProjectionMatrix();
    const wasDamping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = wasDamping;
    this._frustumPanX = 0;
    this._frustumPanY = 0;
  }

  /** Read camera state for tests. Returns null before mount/snapshot. */
  testGetCameraState(): MeganeCameraState | null {
    if (!this.camera || !this.controls) return null;
    const pos = this.camera.position;
    const tgt = this.controls.target;
    return {
      mode: this.perspectiveMode ? "perspective" : "orthographic",
      position: [pos.x, pos.y, pos.z],
      target: [tgt.x, tgt.y, tgt.z],
      zoom: this.camera.zoom,
    };
  }

  /** Aggregate visibility booleans for each renderer subsystem. */
  testGetVisibleSubsystems(): MeganeSubsystemVisibility {
    const layers = Array.from(this.layers.values());
    return {
      atoms: (this.atomRenderer?.mesh.visible ?? false) || layers.some((l) => l.isAtomsVisible()),
      bonds: (this.bondRenderer?.mesh.visible ?? false) || layers.some((l) => l.isBondsVisible()),
      cell: (this.cellRenderer?.mesh.visible ?? false) || layers.some((l) => l.isCellVisible()),
      cellAxes: this.cellAxesRenderer?.isVisible() ?? false,
      vectors: this.arrowRenderer?.mesh.visible ?? false,
      labels: this.labelOverlay != null && this.snapshot != null,
      polyhedra: this.polyhedronRenderer?.group.visible ?? false,
      cartoon: this.cartoonRenderer?.mesh.visible ?? false,
      surface: this.surfaceRenderer?.mesh.visible ?? false,
      line: this.lineRenderer?.mesh.visible ?? false,
    };
  }

  /** Project every atom of the primary snapshot to viewer-space pixels. */
  testGetProjectedAtomPositions(): MeganeProjectedAtom[] {
    if (!this.snapshot || !this.container) return [];
    const positions = this.currentPositions ?? this.snapshot.positions;
    const elements = this.snapshot.elements;
    const n = this.snapshot.nAtoms;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const out: MeganeProjectedAtom[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const { sx, sy, depth } = projectToScreen(
        this.camera,
        positions[i * 3],
        positions[i * 3 + 1],
        positions[i * 3 + 2],
        w,
        h,
      );
      out[i] = { index: i, sx, sy, depth, element: elements[i] };
    }
    return out;
  }
}
