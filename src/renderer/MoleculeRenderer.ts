/**
 * Main molecular viewer class.
 * Owns the Three.js scene, the WebGL renderer and every sub-renderer.
 * Camera and camera interaction are delegated to `CameraController`,
 * picking and the selection overlays to `SelectionController`, and the E2E
 * hooks live in `testApi.ts`.
 * Imperative API - framework agnostic.
 *
 * Uses billboard impostor rendering (2-triangle quads + shader) for all
 * atom counts. Scales to 1M+ atoms on mid-range GPUs.
 */

import * as THREE from "three";
import type { CameraControls } from "./CameraControls";
import type { Snapshot, Frame, HoverInfo, SelectionState, Measurement } from "../types";
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
import { AtomLayerGroup } from "./AtomLayerGroup";
import { representationFlags, type RepresentationType } from "./representation";
import type { DrawingBoundaryData, PeriodicAtomImageData } from "../pipeline/types";
import { generateDrawingBoundaryImages } from "../logic/cellBoundaryImages";
import type { MeshData } from "../pipeline/types";
import type { ClientRect } from "./Picking";
import { FpsCounter } from "./FpsCounter";
import { perfMark, perfMeasure, perfPushFrame, perfRendererReady } from "../perf";
import {
  CameraController,
  type MeganeCameraMode,
  type MeganeCameraState,
} from "./CameraController";
import { SelectionController, type MeganeProjectedAtom } from "./SelectionController";
import type { ViewAxis } from "./cameraOrientation";
import {
  getTestReady,
  releaseActiveRenderer,
  setActiveRenderer,
  signalRender,
  type MeganeSubsystemVisibility,
} from "./testApi";

export { isMeganeTestMode } from "./testApi";
export type { MeganeSubsystemVisibility, MeganeRendererMemory, MeganeTestApi } from "./testApi";
export type { MeganeCameraMode, MeganeCameraState } from "./CameraController";
export type { MeganeProjectedAtom } from "./SelectionController";
export type { RepresentationType } from "./representation";

export class MoleculeRenderer {
  private container: HTMLElement | null = null;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  /**
   * Camera, turntable controls and the camera interactions on top of them
   * (pivot animation, custom pan, wheel zoom, frustum insets, projection
   * switch). Reads the container, canvas and structure from this renderer.
   */
  private readonly cameraController = new CameraController({
    getContainer: () => this.container,
    getCanvas: () => this.renderer.domElement,
    getSnapshot: () => this.snapshot,
    getCurrentPositions: () => this.getCurrentPositions(),
  });
  /** The active camera (owned by `cameraController`). */
  private get camera(): THREE.OrthographicCamera | THREE.PerspectiveCamera {
    return this.cameraController.camera;
  }
  /** The camera's turntable controls (owned by `cameraController`). */
  private get controls(): CameraControls {
    return this.cameraController.controls;
  }
  /**
   * The primary atom renderer plus the display-only periodic-copy layers
   * (Drawing Boundary copies, bond-stream neighbour images). Every atom
   * appearance setter goes through it so the layers stay in sync.
   */
  private readonly atomLayers = new AtomLayerGroup<ImpostorAtomMesh>((object) =>
    this.scene.add(object),
  );
  /** The primary (pickable) atom renderer, owned by `atomLayers`. */
  private get atomRenderer(): ImpostorAtomMesh | null {
    return this.atomLayers.primary;
  }
  private set atomRenderer(renderer: ImpostorAtomMesh | null) {
    this.atomLayers.setPrimary(renderer);
  }
  private bondRenderer: ImpostorBondMesh | null = null;
  private cellRenderer: CellRenderer | null = null;
  private currentDrawingBoundary: DrawingBoundaryData | null = null;
  private currentBondPeriodicImages: PeriodicAtomImageData | null = null;
  private drawingBoundaryHiddenMask: Uint8Array | null = null;
  private representationHiddenMask: Uint8Array | null = null;
  private cellAxesRenderer: CellAxesRenderer | null = null;
  private labelOverlay: LabelOverlay | null = null;
  private arrowRenderer: ArrowRenderer | null = null;
  private polyhedronRenderer: PolyhedronRenderer | null = null;
  private pivotMarker: PivotMarker | null = null;
  private animationId: number | null = null;
  private fpsCounter = new FpsCounter();
  private snapshot: Snapshot | null = null;
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
  private bondScale = 1.0;
  private bondOpacity = 1.0;
  /**
   * Whether the active pipeline produces bonds for the primary structure.
   * Composed with `representationType` to decide bond mesh visibility, so a
   * pipeline that doesn't generate bonds never re-shows stale geometry from a
   * previous structure when the representation toggles back to "atoms"/"both".
   */
  private bondsAvailable = false;
  private currentLabels: string[] | null = null;
  private dprMediaQuery: MediaQueryList | null = null;
  private dprChangeHandler: (() => void) | null = null;
  // Cached dimensions for frame-synchronous resize detection
  private lastContainerW = 0;
  private lastContainerH = 0;
  private lastDpr = 1;
  /** True until the first frame has been rendered after mount; used for perf hook. */
  private firstFramePending = true;

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

  /**
   * Screen-space picking and the atom selection overlays (measurement
   * selection, Inspector preview highlight).
   */
  private readonly selection = new SelectionController({
    getCamera: () => this.camera,
    getContainer: () => this.container,
    getSnapshot: () => this.snapshot,
    getCurrentPositions: () => this.getCurrentPositions(),
    getAtomState: () => this.atomLayers.state,
    getDrawingBoundary: () => this.currentDrawingBoundary,
    getBondPeriodicImages: () => this.currentBondPeriodicImages,
    getAtomRadiusScale: () => this.atomRadiusScale(),
  });

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

    // Camera, controls, wheel zoom and custom pan.
    this.cameraController.mount();

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
    this.scene.add(this.selection.selectionGroup);
    this.scene.add(this.selection.previewSelectionGroup);

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

    // Expose this instance to the test API (no-op outside test mode).
    setActiveRenderer(this);
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
    this.cameraController.syncUpAxis(snapshot.box);

    const _ready = getTestReady();
    if (_ready) {
      _ready.dataLoaded = true;
      _ready.atomCount = snapshot.nAtoms;
    }

    // Impostor meshes for every atom count, created on the first load.
    if (this.atomRenderer === null) {
      this.swapRenderers();
    }

    const atomState = this.atomLayers.state;
    this.atomRenderer!.loadSnapshot(snapshot);
    if (atomState.colorOverrides) {
      this.atomRenderer!.applyColorOverrides(atomState.colorOverrides);
    }
    // Bond loading is handled exclusively by the pipeline via updateBondsExt/updateBonds
    // (called from applyViewportState). This avoids race conditions between
    // Viewport's loadSnapshot and MeganeViewer's applyViewportState effects.
    // If updateBondsExt ran before this snapshot existed (PipelineViewer's
    // parent-before-child effect ordering), the bonds were stashed — replay
    // them now that this.snapshot and this.bondRenderer are ready.
    this.flushPendingBonds();

    // Re-apply stored scale after loading snapshot data
    if (atomState.scale !== 1.0) {
      this.atomRenderer!.setScale(atomState.scale, snapshot);
    }

    // Drawing ranges are inclusive: a crystallographic atom
    // on x/y/z=0 is therefore also drawn at the equivalent x/y/z=1 boundary.
    // Keep these copies in a separate, non-pickable visual layer so atom
    // indices and molecular topology remain unchanged. The layer group
    // carries the current appearance (scale, overrides, representation,
    // visibility) onto layers it creates here.
    this.atomLayers.loadDrawingBoundary(snapshot, this.currentDrawingBoundary);
    this.atomLayers.loadBondPeriodicImages(snapshot, this.currentBondPeriodicImages);
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
      this.cartoonRenderer.setVisible(representationFlags(this.representationType).showCartoon);
    } else if (this.cartoonRenderer) {
      this.cartoonRenderer.setVisible(false);
    }

    // Update surface renderer (lazy init, always available for surface mode)
    if (!this.surfaceRenderer) {
      this.surfaceRenderer = new SurfaceRenderer();
      this.scene.add(this.surfaceRenderer.mesh);
    }
    if (representationFlags(this.representationType).showSurface) {
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
    this.lineRenderer.setVisible(representationFlags(this.representationType).showLine);

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
      this.cameraController.fitToView(snapshot);
    } else {
      // Camera untouched, but the extent drives zoom clamping elsewhere —
      // keep it in sync with the new positions.
      this.cameraController.syncExtent(snapshot);
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
      this.atomLayers.loadDrawingBoundary(frameSnapshot, this.currentDrawingBoundary);
      this.syncLabelOverlay();
    }

    this.cartoonRenderer?.updatePositions(frame.positions);
    if (this.surfaceRenderer?.mesh.visible) {
      this.surfaceRenderer.updatePositions(frame.positions);
    }
    if (this.lineRenderer?.mesh.visible) {
      this.lineRenderer.updatePositions(frame.positions);
    }
    if (this.selection.hasSelection) {
      this.selection.refresh();
    }

    const _ready = getTestReady();
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
    const atomState = this.atomLayers.state;
    this.atomRenderer!.loadSnapshot(synth);
    if (atomState.colorOverrides) {
      this.atomRenderer!.applyColorOverrides(atomState.colorOverrides);
    }
    if (atomState.scale !== 1.0) {
      this.atomRenderer!.setScale(atomState.scale, synth);
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
    if (this.bondScale !== 1.0) {
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
    if (this.bondScale !== 1.0) {
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
      this.atomLayers.loadDrawingBoundary(this.snapshot, boundary);
      this.applyCombinedAtomHiddenMask();
      this.syncLabelOverlay();
    }
  }

  /** Apply outside-boundary neighbor images emitted by a coordination/bond stream. */
  setBondPeriodicImages(images: PeriodicAtomImageData | null): void {
    this.currentBondPeriodicImages = images;
    if (!this.snapshot) return;
    this.atomLayers.loadBondPeriodicImages(this.snapshot, images);
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
    this.atomRenderer?.setHiddenMask(combined);
    // Drawing Boundary copies are already range-filtered; only representation
    // hiding is mapped from their source atom.
    this.atomLayers.setSecondaryHiddenMask(this.representationHiddenMask);
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
    this.cameraController.fitToView(snapshots[0]);
  }

  /** Set atom radius scale multiplier. */
  setAtomScale(scale: number): void {
    this.atomLayers.setScale(scale, this.snapshot);
  }

  /** Set atom opacity (independent of bonds). */
  setAtomOpacity(opacity: number): void {
    this.atomLayers.setOpacity(opacity);
  }

  /** Set per-atom scale overrides from selection pipeline. */
  setAtomScaleOverrides(overrides: Float32Array): void {
    this.atomLayers.setScaleOverrides(overrides);
  }

  /** Set per-atom opacity overrides from selection pipeline. */
  setAtomOpacityOverrides(overrides: Float32Array): void {
    this.atomLayers.setOpacityOverrides(overrides);
  }

  /** Clear all per-atom overrides, reverting to global uniforms. */
  clearAtomOverrides(): void {
    this.atomLayers.clearOverrides();
  }

  /** Set bond radius scale multiplier. */
  setBondScale(scale: number): void {
    this.bondScale = scale;
    if (this.bondRenderer && this.snapshot) {
      this.bondRenderer.setScale(scale, this.snapshot);
    }
  }

  /** Set bond opacity (independent of atoms). */
  setBondOpacity(opacity: number): void {
    this.bondOpacity = opacity;
    this.bondRenderer?.setOpacity(opacity);
  }

  /**
   * Apply per-atom RGB overrides for the primary structure. Null reverts to
   * the default CPK palette for every atom. Identity comparison short-circuits
   * the GPU upload when the same buffer reference is supplied repeatedly.
   */
  applyAtomColorOverrides(overrides: Float32Array | null): void {
    if (overrides === this.atomLayers.state.colorOverrides) return;
    // Records the overrides (replayed on the next snapshot load even when no
    // mesh exists yet) and repaints the secondary layers.
    this.atomLayers.setColorOverrides(overrides);
    if (!this.snapshot || !this.atomRenderer) return;

    // Reset to base CPK by re-loading the snapshot with no color context.
    const scale = this.atomLayers.state.scale;
    this.atomRenderer.loadSnapshot(this.snapshot);
    if (scale !== 1.0) {
      this.atomRenderer.setScale(scale, this.snapshot);
    }
    if (overrides) {
      this.atomRenderer.applyColorOverrides(overrides);
    }
    this.restoreAtomPerAtomState();
    this.syncBondColorsToAtoms();
  }

  /**
   * Re-apply the per-atom state that `ImpostorAtomMesh.loadSnapshot` clears.
   *
   * Reloading the snapshot is how a color change resets the mesh to base CPK
   * before the new overrides are painted on, but the reload also zeroes the
   * per-atom scale, opacity and hidden buffers. Those belong to other layers —
   * the Modify node's scale / opacity and the per-atom representation split —
   * and a color change must not silently drop them, so they are pushed back
   * from the copies this renderer already keeps.
   *
   * Scale is restored before the hidden mask because the mesh composites the
   * effective scale as raw * (hidden ? 0 : 1); the reverse order would leave
   * hidden atoms visible until the next mask write. Null overrides need no
   * restore: the reload already left those buffers at their 1.0 / 0 defaults.
   */
  private restoreAtomPerAtomState(): void {
    const { scaleOverrides, opacityOverrides } = this.atomLayers.state;
    if (scaleOverrides) {
      this.atomRenderer?.setScaleOverrides(scaleOverrides);
    }
    if (opacityOverrides) {
      this.atomRenderer?.setOpacityOverrides(opacityOverrides);
    }
    if (this.drawingBoundaryHiddenMask || this.representationHiddenMask) {
      this.applyCombinedAtomHiddenMask();
    }
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
    this.bondRenderer.recomputeColorsFromAtomBuffer(this.atomRenderer.getColorBuffer(), snap);
  }

  /** Apply per-bond opacity overrides (one value per logical bond). */
  setBondOpacityOverrides(overrides: Float32Array): void {
    this.bondRenderer?.setBondOpacityOverrides(overrides);
  }

  /** Clear per-bond opacity overrides, reverting to global opacity. */
  clearBondOpacityOverrides(): void {
    this.bondRenderer?.clearBondOpacityOverrides();
  }

  /** Toggle atom visibility. */
  setAtomsVisible(visible: boolean): void {
    this.atomLayers.setVisible(visible);
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
    // Illustrative draws touching vdW spheres, so the sticks it would hide
    // anyway are switched off (matching Mol*'s spacefill-only preset).
    const { showBonds, showCartoon, showSurface, showLine, uniformRadius } =
      representationFlags(type);

    // Licorice: render atoms and bonds at a single equal radius so the spheres
    // act as round caps on the sticks, producing a continuous tube. Reverting
    // to ball-and-stick (atoms/both) restores per-element vdW atom radii and
    // per-order bond radii. setUniformRadius only rewrites the radius buffers.
    // Illustrative instead keeps per-element radii but at full vdW size.
    // The layer group applies the atom side (radius scale, licorice radius,
    // illustrative shading, visibility) to every atom layer and records it for
    // layers created later.
    this.atomLayers.setRepresentation(type, this.snapshot);
    if (this.snapshot) {
      this.bondRenderer?.setUniformRadius(uniformRadius, this.snapshot);
    }
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
    return representationFlags(this.representationType).atomRadiusScale;
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
      this.atomRenderer?.setHiddenMask(null);
      this.representationHiddenMask = null;
      this.applyCombinedAtomHiddenMask();
      this.bondRenderer?.setHiddenMask(null);
      if (this.lineRenderer && this.snapshot) {
        this.lineRenderer.loadSnapshot(this.snapshot);
        this.lineRenderer.setVisible(representationFlags(this.representationType).showLine);
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
    this.atomRenderer?.setHiddenMask(anyLine ? lineMask : null);
    this.representationHiddenMask = anyLine ? lineMask : null;
    this.applyCombinedAtomHiddenMask();
    this.bondRenderer?.setHiddenMask(anyLine ? lineMask : null);
    if (this.lineRenderer && this.snapshot) {
      this.lineRenderer.loadSnapshot(this.snapshot, anyLine ? lineMask : null);
      // Keep lines visible for the subset even when the base mesh mode isn't
      // "line"; if no atom is line-mode, defer to the global toggle.
      this.lineRenderer.setVisible(
        anyLine || representationFlags(this.representationType).showLine,
      );
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
      const { showBonds } = representationFlags(this.representationType);
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
    // Disable camera controls while dragging the inset
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

  /**
   * Replace the primary atom and bond meshes with fresh impostor meshes
   * (disposing any previous pair) and re-apply the stored global opacities.
   */
  private swapRenderers(): void {
    // Remove old renderers
    if (this.atomRenderer) {
      this.scene.remove(this.atomRenderer.mesh);
      this.atomRenderer.dispose();
    }
    if (this.bondRenderer) {
      this.scene.remove(this.bondRenderer.mesh);
      this.bondRenderer.dispose();
    }

    const atoms = new ImpostorAtomMesh();
    const bonds = new ImpostorBondMesh();
    this.atomRenderer = atoms;
    this.bondRenderer = bonds;

    this.scene.add(atoms.mesh);
    this.scene.add(bonds.mesh);

    // Keep the bond shader's copy of the ball sizes current so each stick is
    // trimmed where it enters a ball (see the CSG union note in shaders.ts).
    // The sink fires on every atom restyle, so no individual call site has to
    // remember to push.
    atoms.setRadiusSink((radii, scale) => {
      if (radii) bonds.setAtomRadii(radii);
      bonds.setAtomRadiusScale(scale);
    });

    // Re-apply stored appearance settings
    const atomOpacity = this.atomLayers.state.opacity;
    if (atomOpacity !== 1.0) {
      atoms.setOpacity(atomOpacity);
    }
    if (this.bondOpacity !== 1.0) {
      bonds.setOpacity(this.bondOpacity);
    }
  }

  /** Reset view to fit all atoms. */
  resetView(): void {
    if (this.snapshot) {
      this.cameraController.fitToView(this.snapshot);
    }
  }

  /**
   * Set the rotation center (controls target) to the given world point.
   * Orthographic cameras keep the image and start orbiting around the point
   * where it is on screen (OVITO); perspective cameras pan it to the screen
   * center, smoothly when `animate` is true (default). See
   * {@link CameraController.setRotationCenter}.
   */
  setRotationCenter(x: number, y: number, z: number, animate = true): void {
    this.cameraController.setRotationCenter(x, y, z, animate);
  }

  /**
   * Reset the rotation center to the model center — the point a fresh fit
   * orbits around (cell center, or the atoms' centroid without a cell) —
   * keeping the view as {@link setRotationCenter} does.
   */
  resetRotationCenter(): void {
    this.cameraController.resetRotationCenter();
  }

  /** Set pixel insets for overlay panels that occlude viewport edges. */
  setViewInsets(left: number, right: number): void {
    this.cameraController.setViewInsets(left, right);
  }

  /** Switch between orthographic and perspective projection. */
  setPerspective(enabled: boolean): void {
    this.cameraController.setPerspective(enabled);
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

    signalRender(this.snapshot != null);
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
    this.cameraController.resizeForCapture(width, height);

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

  // ---- Picking ----

  /** Perform a pick at the given screen coordinates using CPU screen-space projection. */
  raycastAtPixel(clientX: number, clientY: number): HoverInfo {
    return this.selection.pickAtPixel(clientX, clientY);
  }

  // ---- Selection & Measurement ----

  /** Toggle atom selection (right-click). Returns new selection state. */
  toggleAtomSelection(atomIndex: number): SelectionState {
    return this.selection.toggle(atomIndex);
  }

  /** Set selected atoms directly (for external triggers). Returns new selection state. */
  setSelection(atomIndices: number[]): SelectionState {
    return this.selection.set(atomIndices);
  }

  /**
   * Highlight an arbitrary set of atoms as a live "preview" of the Selection
   * Inspector's current selection (green, translucent). Independent of the
   * measurement selection. Pass `null` or `[]` to clear.
   */
  setPreviewSelection(atomIndices: number[] | null): void {
    this.selection.setPreview(atomIndices);
  }

  /** Return the indices of atoms whose centers fall inside a screen rectangle. */
  selectAtomsInRect(rect: ClientRect): number[] {
    return this.selection.atomsInRect(rect);
  }

  /**
   * World displacement of a screen drag in the camera-facing plane through
   * atom `atomIndex` (at its current position). Null when nothing is loaded.
   */
  dragDeltaForAtom(
    atomIndex: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): [number, number, number] | null {
    return this.selection.dragDeltaForAtom(atomIndex, fromX, fromY, toX, toY);
  }

  /**
   * World point under a client pixel on the camera-facing plane through the
   * current rotation pivot (the structure's center by default). Used to place
   * a new atom on empty space. Null when nothing is mounted.
   */
  screenToWorldAtPivot(clientX: number, clientY: number): [number, number, number] | null {
    return this.cameraController.screenToWorldAtPivot(clientX, clientY);
  }

  /** Enable/disable camera controls (used to suspend camera rotation during a box drag). */
  setControlsEnabled(enabled: boolean): void {
    this.cameraController.setControlsEnabled(enabled);
  }

  /** Clear all selected atoms. */
  clearSelection(): void {
    this.selection.clear();
  }

  /** Compute the current geometric measurement based on selected atoms. */
  getMeasurement(): Measurement | null {
    return this.selection.getMeasurement();
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
    this.cameraController.resize(w, h);
    this.renderer.setSize(w, h, false);
    this.labelOverlay?.resize(w, h, dpr);
    // The controls normalise pointer travel by the canvas rect, so they have
    // to learn the new dimensions.
    this.controls.handleResize();
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

    // Pivot animation / drag momentum, perspective clipping.
    this.cameraController.tick();

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

    signalRender(this.snapshot != null);

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
    this.atomLayers.dispose();
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
    // mount() can throw part-way (no WebGL context, a controls constructor
    // failure), leaving these unset. dispose() still runs from the host's
    // unmount cleanup, so it must not throw there: an exception in a React
    // effect cleanup takes down the page being navigated to.
    this.cameraController.dispose();
    this.renderer?.dispose();
    if (this.container && this.renderer?.domElement.parentNode) {
      this.container.removeChild(this.renderer.domElement);
    }
    releaseActiveRenderer(this);
  }

  // ---- Test-only API (gated on test mode via setActiveRenderer) ----
  // These methods exist so Playwright specs can observe renderer state
  // without driving non-deterministic mouse paths. They are wired to
  // window.__megane_test only in test mode; outside tests they
  // are harmless instance methods.

  /** Switch projection mode by name (wraps setPerspective for symmetry). */
  setCameraMode(mode: MeganeCameraMode): void {
    this.cameraController.setCameraMode(mode);
  }

  /** Re-fit the camera to the current snapshot's bounding box. */
  resetCamera(): void {
    this.cameraController.resetCamera();
  }

  /**
   * Turn the camera to look along a crystallographic (`±a`, `±b`, `±c`) or
   * Cartesian (`±x`, `±y`, `±z`) axis, keeping the current target, distance
   * and zoom. The crystal axes come from the loaded snapshot's cell; without
   * one they coincide with x/y/z. See `cameraOrientation.ts` for the sign
   * and up-vector conventions.
   */
  alignCameraToAxis(axis: ViewAxis): void {
    this.cameraController.alignCameraToAxis(axis);
  }

  /** Register a callback invoked after each user camera interaction ends. */
  setCameraChangeCallback(cb: (() => void) | null): void {
    this.cameraController.setCameraChangeCallback(cb);
  }

  /** Read current camera state. Returns null before mount. */
  getCameraState(): MeganeCameraState | null {
    return this.cameraController.getCameraState();
  }

  /** Restore camera to a previously saved state. */
  applyCameraState(state: MeganeCameraState): void {
    this.cameraController.applyCameraState(state);
  }

  /** Read camera state for tests. Returns null before mount/snapshot. */
  testGetCameraState(): MeganeCameraState | null {
    return this.getCameraState();
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
    return this.selection.projectAtoms();
  }
}
