/**
 * Main megane viewer React component.
 *
 * Combines Viewport, PipelineEditor, Timeline, Tooltip, and MeasurementPanel.
 * The pipeline store drives all rendering state — snapshot, frames, viewport
 * appearance — so the viewer is fully governed by the pipeline graph that the
 * user sees. Hosts (webapp / VSCode webview / JupyterLab DocWidget) supply
 * only the file-ingestion callbacks; viewer state is derived internally.
 *
 * Every tool except the Viewport can be switched off at construction time via
 * the `ui` prop — see {@link MeganeViewerUiOptions}.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Viewport } from "./Viewport";
import { PipelineEditor } from "./PipelineEditor";
import { Timeline } from "./Timeline";
import { Tooltip } from "./Tooltip";
import { MeasurementPanel } from "./MeasurementPanel";
import { MeasurementListPanel } from "./MeasurementListPanel";
import { PerfHud } from "./PerfHud";
import { ViewAxisControls } from "./ViewAxisControls";
import { OVERLAY_INSET, PERF_HUD_LEFT_DEFAULT, MEASUREMENT_BOTTOM_DEFAULT } from "./overlayLayout";
import { MoleculeRenderer, isMeganeTestMode } from "../renderer/MoleculeRenderer";
import { latticeVectors, type ViewAxis } from "../renderer/cameraOrientation";
import type { StructureParseResult } from "../parsers/structure";
import {
  useFrameDistanceBonds,
  hasDistanceBondNode,
  distanceBondVdwScale,
} from "../hooks/useFrameDistanceBonds";
import {
  useMeganeStores,
  useScopedPipelineStore,
  useScopedPlaybackStore,
  useScopedPipelineUIStore,
  useScopedInspectorStore,
  usePipelineStoreApi,
  useViewStateStoreApi,
} from "../stores/MeganeProvider";
import { getElementSymbol } from "../constants";
import { parseResname, computeMoleculeIds } from "../pipeline/selection";
import { applyViewportState, applyVectorsForFrame } from "../pipeline/apply";
import { useAtomSelection } from "../hooks/useAtomSelection";
import { useNodeLoadHandlers } from "../hooks/useNodeLoadHandlers";
import type {
  HoverInfo,
  BondSource,
  LabelSource,
  VectorSource,
  SelectionState,
  Measurement,
} from "../types";
import type { ViewportState } from "../pipeline/types";
import { useThemeStore, themeToHex } from "../stores/useThemeStore";

/**
 * Visibility switches for every piece of viewer UI that is *not* the 3D
 * Viewport. Supplied to {@link MeganeViewer} through its `ui` prop as a
 * partial object; omitted keys fall back to {@link DEFAULT_MEGANE_VIEWER_UI}
 * (everything visible), so embedders only list what they want to hide.
 *
 * Hiding a tool removes it from the DOM entirely — the pipeline still
 * executes and the renderer still receives every update, so a viewer with
 * `pipelineEditor: false` renders exactly the same scene, just without the
 * editing chrome.
 */
export interface MeganeViewerUiOptions {
  /** Pipeline editor panel on the right, with its toolbar and node graph. */
  pipelineEditor: boolean;
  /** "Reset View" button in the top-left corner. */
  resetView: boolean;
  /**
   * Axis-alignment buttons (±a/±b/±c while a cell is loaded, ±x/±y/±z always)
   * under the Reset View button.
   */
  viewAxes: boolean;
  /** Perf HUD readout — atom count, bond count, draw calls, FPS. */
  perfHud: boolean;
  /** Playback timeline (scrubber, play/pause, fps) along the bottom. */
  timeline: boolean;
  /** Hover tooltip that follows the cursor over atoms and bonds. */
  tooltip: boolean;
  /** Measurement readout panel plus the saved-measurement list. */
  measurement: boolean;
}

/**
 * Every tool visible — the layout all bundled hosts ship today.
 *
 * Frozen because it is public API and is read on every render as the fallback
 * for each unset `ui` key: a consumer mutating it (easy to do by accident given
 * the `{ ...DEFAULT_MEGANE_VIEWER_UI, pipelineEditor: false }` idiom) would
 * otherwise change the default for every viewer in the process, including ones
 * that pass no `ui` prop at all.
 */
export const DEFAULT_MEGANE_VIEWER_UI: Readonly<MeganeViewerUiOptions> = Object.freeze({
  pipelineEditor: true,
  resetView: true,
  viewAxes: true,
  perfHud: true,
  timeline: true,
  tooltip: true,
  measurement: true,
});

interface MeganeViewerProps {
  playing?: boolean;
  fps?: number;
  onSeek?: (frame: number) => void;
  onPlayPause?: () => void;
  onFpsChange?: (fps: number) => void;
  onUploadStructure: (file: File, preParsed?: StructureParseResult) => void;
  onUploadTrajectory?: (file: File) => void;
  onBondSourceChange?: (source: BondSource) => void;
  onLabelSourceChange?: (source: LabelSource) => void;
  onLoadLabelFile?: (file: File) => void;
  onVectorSourceChange?: (source: VectorSource) => void;
  onLoadVectorFile?: (file: File) => void;
  onLoadDemoVectors?: () => void;
  /**
   * Fired whenever the active trajectory frame changes (user scrub, playback
   * tick, or programmatic seek). Mirrors the Jupyter widget's `frame_change`
   * event so a host React app can stay in sync — useful for Plotly traces
   * keyed on the same frame index.
   */
  onFrameChange?: (frame: number) => void;
  /**
   * Fired whenever the atom selection changes (right-click to toggle, clear).
   * Mirrors the Jupyter widget's `selection_change` event — useful for keeping
   * a host Plotly figure or table highlighted in sync with the 3D selection.
   * Data: `{ atoms: number[] }` — 0-based atom indices (max 4).
   */
  onSelectionChange?: (selection: SelectionState) => void;
  /**
   * Fired whenever the active measurement changes (distance, angle, dihedral)
   * or is cleared. Mirrors the Jupyter widget's `measurement` event.
   * Data: `{ atoms, type, value, label }` or `null` when selection is cleared.
   */
  onMeasurementChange?: (measurement: Measurement | null) => void;
  /**
   * Toggles for the non-Viewport tools. Omitted keys stay visible — see
   * {@link MeganeViewerUiOptions}. The Viewport itself is always rendered.
   *
   * @example
   * // 3D view only, no editing chrome
   * <MeganeViewer ui={{ pipelineEditor: false, resetView: false, perfHud: false }} … />
   */
  ui?: Partial<MeganeViewerUiOptions>;
  width?: string | number;
  height?: string | number;
  /** Host context tag for E2E tests: "webapp" | "jupyterlab-doc" | "vscode". Defaults to "webapp". */
  testContext?: string;
  /**
   * Override the initial camera state to restore on first snapshot load.
   * When provided, takes precedence over localStorage. Used by hosts (VSCode,
   * JupyterLab) that manage their own persistent storage.
   */
  initialCameraState?: import("../renderer/MoleculeRenderer").MeganeCameraState | null;
  /**
   * Called whenever the camera state changes (after user interaction ends).
   * Allows hosts to persist camera state in their own storage backends.
   * When omitted, the built-in localStorage store is used.
   */
  onCameraStateChange?: (state: import("../renderer/MoleculeRenderer").MeganeCameraState) => void;
}

export function MeganeViewer({
  playing = false,
  fps = 30,
  onSeek,
  onPlayPause,
  onFpsChange,
  onUploadStructure,
  onUploadTrajectory,
  onBondSourceChange: _onBondSourceChange,
  onLabelSourceChange: _onLabelSourceChange,
  onLoadLabelFile: _onLoadLabelFile,
  onVectorSourceChange: _onVectorSourceChange,
  onLoadVectorFile: _onLoadVectorFile,
  onLoadDemoVectors: _onLoadDemoVectors,
  onFrameChange,
  onSelectionChange,
  onMeasurementChange,
  ui,
  width = "100%",
  height = "100%",
  testContext = "webapp",
  initialCameraState,
  onCameraStateChange,
}: MeganeViewerProps) {
  const stores = useMeganeStores();
  const pipelineApi = usePipelineStoreApi();
  const viewStateApi = useViewStateStoreApi();

  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo>(null);
  const [bondCount, setBondCount] = useState<number>(0);
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 768;
  const [pipelineCollapsed, setPipelineCollapsed] = useState(isNarrow);
  const pipelineCollapsedRef = useRef(isNarrow);
  const pipelineWidthRef = useRef(480);
  const prevViewportStateRef = useRef<ViewportState | null>(null);
  const hasRestoredCameraRef = useRef(false);

  // Resolve the `ui` prop down to plain booleans so a fresh object literal
  // from the caller never destabilises hook deps.
  //
  // Resolved key by key with `??` rather than `{ ...DEFAULT, ...ui }`: the
  // prop is `Partial<…>` and the project does not enable
  // `exactOptionalPropertyTypes`, so `ui={{ timeline: maybeUndefined }}`
  // typechecks. A spread would copy that `undefined` over the `true` default
  // and hide a tool the documented contract keeps visible.
  const showPipelineEditor = ui?.pipelineEditor ?? DEFAULT_MEGANE_VIEWER_UI.pipelineEditor;
  const showResetView = ui?.resetView ?? DEFAULT_MEGANE_VIEWER_UI.resetView;
  const showViewAxes = ui?.viewAxes ?? DEFAULT_MEGANE_VIEWER_UI.viewAxes;
  const showPerfHud = ui?.perfHud ?? DEFAULT_MEGANE_VIEWER_UI.perfHud;
  const showTimeline = ui?.timeline ?? DEFAULT_MEGANE_VIEWER_UI.timeline;
  const showTooltip = ui?.tooltip ?? DEFAULT_MEGANE_VIEWER_UI.tooltip;
  const showMeasurement = ui?.measurement ?? DEFAULT_MEGANE_VIEWER_UI.measurement;

  // Right-edge inset the orthographic frustum leaves free for the pipeline
  // panel: zero when the panel is collapsed *or* switched off entirely.
  //
  // Depends on `showPipelineEditor` for real rather than reading it through a
  // ref: with a ref the callback never changes identity, which makes every dep
  // array listing it decorative and leaves correctness resting on hand-added
  // deps that exhaustive-deps cannot defend. Consumers only re-run on a
  // visibility change, and Viewport's mount effect ignores prop identity.
  const rightInset = useCallback(
    () => (showPipelineEditor && !pipelineCollapsedRef.current ? pipelineWidthRef.current + 12 : 0),
    [showPipelineEditor],
  );

  // Shared atom selection & measurement
  const { selection, measurement, handleAtomRightClick, handleClearSelection, handleFrameUpdated } =
    useAtomSelection(rendererRef, onMeasurementChange, onSelectionChange);

  const viewerRootRef = useRef<HTMLDivElement | null>(null);

  // Selecting an atom takes keyboard focus, which is what lets the Escape
  // handler below tell whether an Escape was aimed at this viewer: a page can
  // host several, and the host's own dialogs also answer to the key.
  const handleAtomRightClickFocused = useCallback(
    (atomIndex: number) => {
      viewerRootRef.current?.focus({ preventScroll: true });
      handleAtomRightClick(atomIndex);
    },
    [handleAtomRightClick],
  );

  // Selection Inspector ⇄ 3D view bridge.
  // The Inspector lives inside the pipeline panel, and `mode` is restored from
  // sessionStorage — so without the panel a previously-saved "inspector" mode
  // would leave the Viewport in pick mode with no UI to leave it.
  const inspectorMode = useScopedPipelineUIStore((s) => s.mode === "inspector");
  const inspectorActive = showPipelineEditor && inspectorMode;
  const previewIndices = useScopedInspectorStore((s) => s.previewIndices);
  const boxSelectActive = useScopedInspectorStore((s) => s.boxSelectActive);
  const publishBoxResult = useScopedInspectorStore((s) => s.publishBoxResult);
  const publishPickedAtom = useScopedInspectorStore((s) => s.publishPickedAtom);

  const handleInspectorPick = useCallback(
    (atomIndex: number) => {
      const { snapshot: snap, atomLabels } = pipelineApi.getState();
      if (!snap) return;
      const chainCode = snap.atomChainIds?.[atomIndex] ?? 0;
      const molIds = snap.bonds.length > 0 ? computeMoleculeIds(snap.bonds, snap.nAtoms) : null;
      publishPickedAtom({
        index: atomIndex,
        element: getElementSymbol(snap.elements[atomIndex]),
        resname: atomLabels?.[atomIndex] ? parseResname(atomLabels[atomIndex]) : null,
        chain: chainCode === 0 ? null : String.fromCharCode(chainCode),
        moleculeId: molIds ? molIds[atomIndex] : null,
      });
    },
    [publishPickedAtom, pipelineApi],
  );

  useEffect(() => {
    pipelineCollapsedRef.current = pipelineCollapsed;
  }, [pipelineCollapsed]);

  // Subscribe to pipeline store: viewportState drives the renderer, and the
  // primary particle's source carries the canonical snapshot (set by
  // setNodeSnapshot in usePipelineStore.openFile).
  //
  // We deliberately do NOT subscribe to `viewportState` itself in the React
  // render path — every node-param change (e.g. AddBond bondSource flip)
  // produces a new viewportState reference, and a render-path subscription
  // would cascade into a re-render of every child (PipelineEditor, Timeline,
  // Sidebar, …). Instead, the effect below subscribes via
  // `usePipelineStore.subscribe`, which only fires the callback without
  // triggering a render. The `snapshot` selector still drives the React
  // tree because it changes identity only on file load (snapshots are
  // pinned to the LoadStructure's NodeSnapshotData).
  const snapshot = useScopedPipelineStore((s) => s.viewportState.particles[0]?.source ?? null);

  // Wire up node load handlers (structure, trajectory, vector) and track primary node
  const primaryNodeIdRef = useNodeLoadHandlers({
    snapshot,
    onUploadStructure,
    onUploadTrajectory,
  });

  // When the snapshot identity changes, the Viewport's child loadSnapshot
  // effect resets per-atom overrides, so we re-apply the pipeline viewport
  // state immediately afterwards. Viewport's effect (child) runs before this
  // parent effect, so fitToView has already been called by the time we run.
  useEffect(() => {
    setBondCount(snapshot?.nBonds ?? 0);
    const renderer = rendererRef.current;
    if (renderer) {
      const state = pipelineApi.getState();
      applyViewportState(
        renderer,
        state.viewportState,
        null,
        primaryNodeIdRef.current,
        state.atomLabels,
      );
      prevViewportStateRef.current = state.viewportState;

      // On first snapshot load after mount, restore persisted camera state
      // (overrides fitToView). Hosts supply initialCameraState for their own
      // storage; otherwise falls back to the localStorage-backed store.
      if (snapshot && !hasRestoredCameraRef.current) {
        hasRestoredCameraRef.current = true;
        const saved =
          initialCameraState !== undefined ? initialCameraState : viewStateApi.getState().camera;
        if (saved) {
          renderer.applyCameraState(saved);
        }
      }
    }
  }, [snapshot, initialCameraState, pipelineApi, viewStateApi]);

  // Apply viewportState changes to the renderer + drive playback / bond-count
  // updates without triggering a React re-render of MeganeViewer. Subscribing
  // through the vanilla zustand API (instead of `usePipelineStore(selector)`)
  // means a full pipeline execute flushes only effect callbacks here.
  const setPlaybackProvider = useScopedPlaybackStore((s) => s.setProvider);
  useEffect(() => {
    let prevBondsRef: ViewportState["bonds"] | null = null;
    let prevTrajRef: unknown = null;

    const apply = (vs: ViewportState) => {
      const renderer = rendererRef.current;
      if (renderer) {
        const atomLabels = pipelineApi.getState().atomLabels;
        applyViewportState(
          renderer,
          vs,
          prevViewportStateRef.current,
          primaryNodeIdRef.current,
          atomLabels,
        );
        prevViewportStateRef.current = vs;
      }

      if (vs.bonds !== prevBondsRef) {
        prevBondsRef = vs.bonds;
        const total = vs.bonds.reduce((sum, b) => sum + b.bondIndices.length / 2, 0);
        setBondCount((current) => (current === total ? current : total));
      }

      const traj = vs.trajectories[0] ?? null;
      const provider = traj?.provider ?? null;
      if (provider !== prevTrajRef) {
        prevTrajRef = provider;
        setPlaybackProvider(provider);
      }
    };

    apply(pipelineApi.getState().viewportState);
    return pipelineApi.subscribe((state, prev) => {
      if (state.viewportState !== prev.viewportState) apply(state.viewportState);
    });
  }, [setPlaybackProvider, pipelineApi]);

  // Frame, currentFrame, and totalFrames come straight from the playback store.
  const frame = useScopedPlaybackStore((s) => s.currentFrameData);
  const currentFrame = useScopedPlaybackStore((s) => s.currentFrame);
  const totalFrames = useScopedPlaybackStore((s) => s.totalFrames);

  // Surface frame changes to host React apps (e.g. Plotly integration). We
  // skip the synthetic 0-on-mount value so consumers only receive transitions
  // they caused, matching the Jupyter widget's `frame_change` semantics.
  const lastFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (!onFrameChange) return;
    if (lastFrameRef.current === currentFrame) return;
    if (lastFrameRef.current !== null) {
      onFrameChange(currentFrame);
    }
    lastFrameRef.current = currentFrame;
  }, [currentFrame, onFrameChange]);

  const storePlaying = useScopedPlaybackStore((s) => s.playing);
  const storeFps = useScopedPlaybackStore((s) => s.fps);
  const storeSpeedMultiplier = useScopedPlaybackStore((s) => s.speedMultiplier);
  const storeLoopStart = useScopedPlaybackStore((s) => s.loopStart);
  const storeLoopEnd = useScopedPlaybackStore((s) => s.loopEnd);
  const storeSeek = useScopedPlaybackStore((s) => s.seekFrame);
  const storeTogglePlayPause = useScopedPlaybackStore((s) => s.togglePlayPause);
  const storeSetFps = useScopedPlaybackStore((s) => s.setFps);
  const storeSetSpeedMultiplier = useScopedPlaybackStore((s) => s.setSpeedMultiplier);
  const storeSetLoopRange = useScopedPlaybackStore((s) => s.setLoopRange);
  const storeStepForward = useScopedPlaybackStore((s) => s.stepForward);
  const storeStepBackward = useScopedPlaybackStore((s) => s.stepBackward);

  // Hosts may forward custom playback callbacks (the webapp wraps them to
  // pause on file uploads). When omitted (VSCode webview, JupyterLab
  // DocWidget), wire Timeline directly to the playback store so the user
  // always gets playback controls for multi-frame structures.
  const effectivePlaying = onPlayPause ? playing : storePlaying;
  const effectiveFps = onFpsChange ? fps : storeFps;
  const effectiveOnSeek = onSeek ?? storeSeek;
  const effectiveOnPlayPause = onPlayPause ?? storeTogglePlayPause;
  const effectiveOnFpsChange = onFpsChange ?? storeSetFps;

  // Per-frame bond recalculation for distance mode
  const hasDistanceBond = useScopedPipelineStore((s) => hasDistanceBondNode(s.nodes));
  const distanceBondScale = useScopedPipelineStore((s) => distanceBondVdwScale(s.nodes));
  useFrameDistanceBonds({
    rendererRef,
    snapshot,
    frame,
    enabled: hasDistanceBond,
    vdwScale: distanceBondScale,
    onBondCount: setBondCount,
  });

  // Per-frame vector update
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const vs = pipelineApi.getState().viewportState;
    if (vs.vectors.length > 0) {
      applyVectorsForFrame(renderer, vs.vectors, currentFrame);
    }
  }, [currentFrame, pipelineApi]);

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);

  // Update Three.js background color when theme changes
  useEffect(() => {
    rendererRef.current?.setBackgroundColor(themeToHex(resolvedTheme));
  }, [resolvedTheme]);

  const onCameraStateChangeRef = useRef(onCameraStateChange);
  onCameraStateChangeRef.current = onCameraStateChange;

  const handleRendererReady = useCallback(
    (renderer: MoleculeRenderer) => {
      rendererRef.current = renderer;
      renderer.setBackgroundColor(themeToHex(useThemeStore.getState().resolvedTheme));
      renderer.setViewInsets(0, rightInset());
      const storeState = pipelineApi.getState();
      applyViewportState(
        renderer,
        storeState.viewportState,
        null,
        primaryNodeIdRef.current,
        storeState.atomLabels,
      );
      prevViewportStateRef.current = storeState.viewportState;

      // Register camera change callback for persistence
      renderer.setCameraChangeCallback(() => {
        const state = renderer.getCameraState();
        if (!state) return;
        if (onCameraStateChangeRef.current) {
          onCameraStateChangeRef.current(state);
        } else {
          viewStateApi.getState().updateCamera(state);
        }
      });
    },
    [rightInset, pipelineApi, viewStateApi],
  );

  // Escape clears the atom selection. Right-click selection stays wired
  // regardless of `ui.measurement` (hosts consume onSelectionChange /
  // onMeasurementChange without necessarily showing the panel), and
  // MeasurementPanel's Clear button is otherwise the only way to drop a
  // selection — so with `measurement: false` the highlights would be stuck.
  //
  // Guarded on a non-empty selection so Escape keeps its usual meaning
  // (closing a dialog, cancelling a rename) when nothing is selected.
  const selectionCountRef = useRef(0);
  selectionCountRef.current = selection.atoms.length;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (selectionCountRef.current === 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // Something outside this viewer holds keyboard focus — a host dialog, a
      // dropdown, or a sibling viewer. That Escape was aimed at it, not at us.
      // `body` means nothing is focused, which we still answer to so a
      // programmatic selection remains clearable.
      const active = document.activeElement;
      const root = viewerRootRef.current;
      if (active && active !== document.body && root && !root.contains(active)) return;
      handleClearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClearSelection]);

  // With `tooltip: false` the Viewport stops reporting hover, so `hoverInfo`
  // would stay frozen at whatever was last under the cursor and reappear the
  // moment the tooltip is switched back on — at coordinates the cursor left
  // long ago.
  useEffect(() => {
    if (!showTooltip) setHoverInfo(null);
  }, [showTooltip]);

  const handleTogglePipeline = useCallback(() => {
    setPipelineCollapsed((prev) => !prev);
  }, []);

  // Tour anchor — invisible rectangle the guide tour highlights when it
  // points to the Viewport. Sized to fill the visible 3D canvas region,
  // staying clear of the Pipeline panel on the right and the Timeline at
  // the bottom. Updated imperatively (no re-render) when the panel resizes.
  const tourAnchorRef = useRef<HTMLDivElement | null>(null);
  const updateTourAnchor = useCallback(() => {
    const el = tourAnchorRef.current;
    if (!el) return;
    const right = !showPipelineEditor
      ? 24
      : pipelineCollapsedRef.current
        ? 60
        : pipelineWidthRef.current + 24;
    el.style.right = `${right}px`;
  }, [showPipelineEditor]);

  const handlePipelineWidthChange = useCallback(
    (w: number) => {
      pipelineWidthRef.current = w;
      rendererRef.current?.setViewInsets(0, rightInset());
      updateTourAnchor();
    },
    [rightInset, updateTourAnchor],
  );

  useEffect(() => {
    rendererRef.current?.setViewInsets(0, rightInset());
    updateTourAnchor();
  }, [pipelineCollapsed, rightInset, updateTourAnchor]);

  const handleResetView = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.resetCamera();
    viewStateApi.getState().clearViewState();
  }, [viewStateApi]);

  // Alignment is a camera move like a drag: the renderer fires its
  // camera-change callback, which persists the new pose the usual way.
  const handleAlignView = useCallback((axis: ViewAxis) => {
    rendererRef.current?.alignCameraToAxis(axis);
  }, []);

  // The a/b/c row only makes sense with a real cell; without one the crystal
  // axes would just duplicate x/y/z.
  const hasCell = latticeVectors(snapshot?.box) !== null;

  // Timeline renders nothing for a single-frame structure (its own
  // `totalFrames <= 1` guard), so the overlays below it must key on whether the
  // strip is actually on screen — not just on the `ui.timeline` switch, which
  // would leave them hovering above an empty band for every static structure.
  const timelineVisible = showTimeline && totalFrames > 1;

  // Measurement panels clear the Timeline strip; with no strip they drop to the
  // same corner inset every other overlay uses.
  const measurementBottom = timelineVisible ? MEASUREMENT_BOTTOM_DEFAULT : OVERLAY_INSET;

  const getRenderStats = useCallback(() => rendererRef.current?.getStats() ?? null, []);
  // Freeze the live FPS digits under E2E so screenshot baselines stay
  // deterministic; the feature is fully live in production.
  const hudStable = isMeganeTestMode();

  return (
    <div
      ref={viewerRootRef}
      // Focusable (programmatically only) so the Escape handler above can scope
      // itself to the viewer the user last interacted with.
      tabIndex={-1}
      data-testid="megane-viewer"
      data-megane-context={testContext}
      data-megane-instance={stores.id}
      data-atom-count={snapshot?.nAtoms ?? 0}
      // Atom count of the currently displayed frame. Differs from
      // data-atom-count only for heterogeneous trajectories whose per-frame
      // atom count changes; falls back to the snapshot for uniform ones.
      data-frame-atoms={frame?.nAtoms ?? snapshot?.nAtoms ?? 0}
      data-bond-count={bondCount}
      data-total-frames={totalFrames}
      data-current-frame={currentFrame}
      style={{ width, height, position: "relative", overflow: "hidden", outline: "none" }}
    >
      <Viewport
        snapshot={snapshot}
        frame={frame}
        atomLabels={null}
        atomVectors={null}
        onRendererReady={handleRendererReady}
        // Skipping the callback entirely (rather than rendering no Tooltip)
        // avoids a viewer-wide re-render on every mousemove for a component
        // that is not in the tree.
        onHover={showTooltip ? setHoverInfo : undefined}
        onAtomRightClick={handleAtomRightClickFocused}
        onFrameUpdated={handleFrameUpdated}
        // Gated on the panel, not on `inspectorActive`, so the default
        // configuration behaves exactly as before: these carry Inspector
        // state that only the panel can produce or clear.
        previewIndices={showPipelineEditor ? previewIndices : null}
        boxSelectActive={showPipelineEditor && boxSelectActive}
        onBoxSelect={publishBoxResult}
        onInspectorPick={handleInspectorPick}
        inspectorActive={inspectorActive}
      />
      <div
        ref={tourAnchorRef}
        data-tour-anchor="viewport"
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 24,
          left: 24,
          right: !showPipelineEditor ? 24 : pipelineCollapsed ? 60 : pipelineWidthRef.current + 24,
          bottom: timelineVisible ? 80 : 24,
          pointerEvents: "none",
          opacity: 0,
        }}
      />
      {(showResetView || showViewAxes) && (
        // Reset View and the axis buttons stack in the top-left corner; the
        // column keeps the button exactly where it always was (the perf HUD's
        // default `left` is tuned to clear it) and hangs the axis rows below.
        <div
          data-testid="view-controls"
          style={{
            position: "absolute",
            top: OVERLAY_INSET,
            left: OVERLAY_INSET,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
            zIndex: 10,
          }}
        >
          {showResetView && (
            <button
              data-testid="reset-view-btn"
              title="Reset view (fit to structure, standard orientation)"
              onClick={handleResetView}
              style={{
                padding: "4px 8px",
                fontSize: 11,
                lineHeight: 1,
                background: "rgba(255,255,255,0.85)",
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: 4,
                cursor: "pointer",
                color: "#374151",
                backdropFilter: "blur(4px)",
                userSelect: "none",
              }}
            >
              Reset View
            </button>
          )}
          {showViewAxes && <ViewAxisControls hasCell={hasCell} onAlign={handleAlignView} />}
        </div>
      )}
      {showPerfHud && (
        <PerfHud
          atomCount={snapshot?.nAtoms ?? 0}
          bondCount={bondCount}
          getStats={getRenderStats}
          stable={hudStable}
          // Slide into the Reset View slot when that button is hidden so the
          // HUD never floats with a gap on its left.
          left={showResetView ? PERF_HUD_LEFT_DEFAULT : OVERLAY_INSET}
        />
      )}
      {showPipelineEditor && (
        <PipelineEditor
          collapsed={pipelineCollapsed}
          onToggleCollapse={handleTogglePipeline}
          onWidthChange={handlePipelineWidthChange}
          rendererRef={rendererRef}
          totalFrames={totalFrames}
          currentFrame={currentFrame}
          onSeek={effectiveOnSeek}
        />
      )}
      {timelineVisible && (
        <Timeline
          currentFrame={currentFrame}
          totalFrames={totalFrames}
          playing={effectivePlaying}
          fps={effectiveFps}
          speedMultiplier={storeSpeedMultiplier}
          loopStart={storeLoopStart}
          loopEnd={storeLoopEnd}
          onSeek={effectiveOnSeek}
          onPlayPause={effectiveOnPlayPause}
          onFpsChange={effectiveOnFpsChange}
          onSpeedChange={storeSetSpeedMultiplier}
          onLoopRangeChange={storeSetLoopRange}
          onStepBackward={storeStepBackward}
          onStepForward={storeStepForward}
        />
      )}
      {showTooltip && <Tooltip info={hoverInfo} />}
      {showMeasurement && (
        <>
          <MeasurementPanel
            selection={selection}
            measurement={measurement}
            elements={snapshot?.elements ?? null}
            onClear={handleClearSelection}
            bottom={measurementBottom}
          />
          <MeasurementListPanel elements={snapshot?.elements ?? null} bottom={measurementBottom} />
        </>
      )}
    </div>
  );
}
