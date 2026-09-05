/**
 * Simplified megane viewer for Jupyter widget embedding.
 * Minimal UI: Viewport + Timeline + Tooltip + MeasurementPanel.
 *
 * The visual pipeline editor is intentionally not mounted here — it is
 * webapp / JupyterLab / VSCode only. Pipeline data still flows in via
 * `pipelineJson` + `nodeSnapshotsData` from `MolecularViewer.set_pipeline()`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";
import { Viewport } from "./Viewport";
import { Timeline } from "./Timeline";
import { Tooltip } from "./Tooltip";
import { MeasurementPanel } from "./MeasurementPanel";
import { ViewAxisControls } from "./ViewAxisControls";
import { OVERLAY_INSET } from "./overlayLayout";
import { MoleculeRenderer, type MeganeCameraState } from "../renderer/MoleculeRenderer";
import { latticeVectors, type ViewAxis } from "../renderer/cameraOrientation";
import { useAtomSelection } from "../hooks/useAtomSelection";
import {
  useFrameDistanceBonds,
  hasDistanceBondNode,
  distanceBondVdwScale,
} from "../hooks/useFrameDistanceBonds";
import { createPipelineStore, type PipelineStore } from "../pipeline/store";
import { applyViewportState } from "../pipeline/apply";
import { decodeSnapshot, decodeHeader, MSG_SNAPSHOT } from "../protocol/protocol";
import type { ViewportState } from "../pipeline/types";
import type { Snapshot, Frame, Measurement, HoverInfo } from "../types";
import { useThemeStore, themeToHex } from "../stores/useThemeStore";

interface WidgetViewerProps {
  snapshot: Snapshot | null;
  frame: Frame | null;
  currentFrame: number;
  totalFrames: number;
  onSeek: (frame: number) => void;
  selectedAtoms?: number[];
  onMeasurementChange?: (measurement: Measurement | null) => void;
  pipelineJson?: string;
  nodeSnapshotsData?: Record<string, DataView>;
  onPipelineChange?: (json: string) => void;
  /** Initial camera state to restore on first snapshot load. */
  initialCameraState?: MeganeCameraState | null;
  /** Called when camera state changes (after user interaction ends). */
  onCameraStateChange?: (state: MeganeCameraState) => void;
  // Optional pipeline store override. Each Jupyter widget mount creates its
  // own private store so multiple MolecularViewers in the same notebook do
  // not share state. Tests pass their own store to inspect internal state.
  pipelineStore?: StoreApi<PipelineStore>;
}

/** Decode a binary DataView into a Snapshot. */
function decodeNodeSnapshot(data: DataView): Snapshot | null {
  if (!data || data.byteLength === 0) return null;
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  const { msgType } = decodeHeader(buffer);
  if (msgType === MSG_SNAPSHOT) {
    return decodeSnapshot(buffer);
  }
  return null;
}

export function WidgetViewer({
  snapshot,
  frame,
  currentFrame,
  totalFrames,
  onSeek,
  selectedAtoms,
  onMeasurementChange,
  pipelineJson,
  nodeSnapshotsData,
  initialCameraState,
  onCameraStateChange,
  pipelineStore: pipelineStoreProp,
}: WidgetViewerProps) {
  // Each WidgetViewer instance owns a private pipeline store. The webapp
  // singleton (`usePipelineStore`) is intentionally avoided here so that
  // multiple MolecularViewers in one notebook do not share state — without
  // this, the second viewer's loadPipeline() overwrites the first viewer's
  // pipeline, leaving it blank.
  const [defaultStore] = useState(() => createPipelineStore());
  const pipelineStore = pipelineStoreProp ?? defaultStore;

  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(30);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);
  const currentFrameRef = useRef(0);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(0);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const [bondCount, setBondCount] = useState<number>(0);
  const prevViewportStateRef = useRef<ViewportState | null>(null);
  const hasRestoredCameraRef = useRef(false);
  const onCameraStateChangeRef = useRef(onCameraStateChange);
  onCameraStateChangeRef.current = onCameraStateChange;
  const initialCameraStateRef = useRef(initialCameraState);

  const {
    selection,
    measurement,
    handleAtomRightClick,
    handleClearSelection,
    handleFrameUpdated,
    setExternalSelection,
  } = useAtomSelection(rendererRef, onMeasurementChange);

  // Keep a ref so handleRendererReady can apply the initial selection
  const selectedAtomsRef = useRef(selectedAtoms);
  selectedAtomsRef.current = selectedAtoms;

  // Keep loop refs in sync with state for use inside setInterval closure
  currentFrameRef.current = currentFrame;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;

  // Reset loop range when a new trajectory loads
  useEffect(() => {
    setLoopStart(0);
    setLoopEnd(totalFrames > 0 ? totalFrames - 1 : 0);
  }, [totalFrames]);

  // Sync external atom selection from Python
  useEffect(() => {
    setExternalSelection(selectedAtoms ?? []);
  }, [selectedAtoms, setExternalSelection]);
  const viewportState = useStore(pipelineStore, (s) => s.viewportState);
  const storeSnapshot = useStore(pipelineStore, (s) => s.snapshot);
  const setSnapshot = useStore(pipelineStore, (s) => s.setSnapshot);

  // Apply pipeline + per-node snapshots from Python.
  //
  // Order matters: `deserialize()` clears `nodeSnapshots` (so opening a new
  // .megane.json doesn't bleed state across JupyterLab documents), so a
  // separate effect that calls `setNodeSnapshot` followed by another that
  // calls `deserialize` would race — the deserialize wins, leaves
  // nodeSnapshots empty, and `executeLoadStructure` produces no particles
  // (blank viewport). Using `loadPipeline` performs both updates in a
  // single store transaction so the post-deserialize execute() sees the
  // matching snapshots.
  const prevPipelineJsonRef = useRef<string>("");
  useEffect(() => {
    const store = pipelineStore.getState();
    const decodedSnapshots: Record<string, Parameters<typeof store.setNodeSnapshot>[1]> = {};
    if (nodeSnapshotsData) {
      for (const [nodeId, data] of Object.entries(nodeSnapshotsData)) {
        const decoded = decodeNodeSnapshot(data);
        if (decoded) {
          decodedSnapshots[nodeId] = {
            snapshot: decoded,
            frames: null,
            meta: null,
            labels: null,
          };
        }
      }
    }

    if (pipelineJson && pipelineJson !== prevPipelineJsonRef.current) {
      prevPipelineJsonRef.current = pipelineJson;
      try {
        const config = JSON.parse(pipelineJson);
        store.loadPipeline(config, decodedSnapshots);
      } catch {
        // Ignore invalid JSON
      }
    } else if (Object.keys(decodedSnapshots).length > 0) {
      // Pipeline JSON is unchanged but the per-node snapshots may have
      // refreshed (e.g. trajectory tick or a follow-up `.load()` call).
      for (const [nodeId, data] of Object.entries(decodedSnapshots)) {
        store.setNodeSnapshot(nodeId, data);
      }
      const sortedIds = Object.keys(decodedSnapshots).sort();
      setSnapshot(decodedSnapshots[sortedIds[0]].snapshot);
    } else {
      // Legacy `.load()` path: no pipeline JSON, no per-node snapshots.
      setSnapshot(snapshot);
    }

    const renderer = rendererRef.current;
    if (renderer) {
      const storeState = pipelineStore.getState();
      applyViewportState(
        renderer,
        storeState.viewportState,
        null,
        undefined,
        storeState.atomLabels,
      );
      prevViewportStateRef.current = storeState.viewportState;

      // Restore persisted camera on first load (Viewport's loadSnapshot/fitToView
      // runs before this effect because child effects execute first).
      const effectiveSnap = storeState.snapshot ?? snapshot;
      if (effectiveSnap && !hasRestoredCameraRef.current) {
        hasRestoredCameraRef.current = true;
        const saved = initialCameraStateRef.current;
        if (saved) renderer.applyCameraState(saved);
      }
    }
  }, [snapshot, nodeSnapshotsData, pipelineJson, setSnapshot, pipelineStore]);

  // Apply viewportState changes to the renderer
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const atomLabels = pipelineStore.getState().atomLabels;
    applyViewportState(
      renderer,
      viewportState,
      prevViewportStateRef.current,
      undefined,
      atomLabels,
    );
    prevViewportStateRef.current = viewportState;
  }, [viewportState, pipelineStore]);

  // Per-frame bond recalculation for distance mode. In pipeline mode the
  // `snapshot` prop is null (set_pipeline only populates
  // `_node_snapshots_data`), so fall back to the store snapshot — same
  // pattern as Viewport and MeasurementPanel below.
  const hasDistanceBond = useStore(pipelineStore, (s) => hasDistanceBondNode(s.nodes));
  const distanceBondScale = useStore(pipelineStore, (s) => distanceBondVdwScale(s.nodes));
  useFrameDistanceBonds({
    rendererRef,
    snapshot: storeSnapshot ?? snapshot,
    frame,
    enabled: hasDistanceBond,
    vdwScale: distanceBondScale,
    onBondCount: setBondCount,
  });

  // Track pipeline-driven bond updates (initial load, bondSource flips,
  // file-mode bonds). Mirrors MeganeViewer's pattern.
  useEffect(() => {
    const total = viewportState.bonds.reduce((sum, b) => sum + b.bondIndices.length / 2, 0);
    setBondCount(total);
  }, [viewportState.bonds]);

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  useEffect(() => {
    rendererRef.current?.setBackgroundColor(themeToHex(resolvedTheme));
  }, [resolvedTheme]);

  const handleRendererReady = useCallback(
    (renderer: MoleculeRenderer) => {
      rendererRef.current = renderer;
      renderer.setBackgroundColor(themeToHex(useThemeStore.getState().resolvedTheme));
      applyViewportState(renderer, pipelineStore.getState().viewportState, null);
      prevViewportStateRef.current = pipelineStore.getState().viewportState;
      // Apply initial selectedAtoms that may have arrived before the renderer was ready
      setExternalSelection(selectedAtomsRef.current ?? []);
      // Register camera change callback for host-side persistence
      renderer.setCameraChangeCallback(() => {
        const state = renderer.getCameraState();
        if (state) onCameraStateChangeRef.current?.(state);
      });
    },
    [setExternalSelection, pipelineStore],
  );

  const startPlayInterval = useCallback(
    (intervalFps: number, intervalSpeed: number) => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
      playIntervalRef.current = setInterval(
        () => {
          const next = currentFrameRef.current + 1;
          if (next > loopEndRef.current) {
            onSeek(loopStartRef.current);
          } else {
            onSeek(next);
          }
        },
        1000 / (intervalFps * intervalSpeed),
      );
    },
    [onSeek],
  );

  const handlePlayPause = useCallback(() => {
    setPlaying((prev) => {
      if (prev) {
        if (playIntervalRef.current) {
          clearInterval(playIntervalRef.current);
          playIntervalRef.current = null;
        }
        return false;
      } else {
        startPlayInterval(fps, speedMultiplier);
        return true;
      }
    });
  }, [fps, speedMultiplier, startPlayInterval]);

  const handleFpsChange = useCallback(
    (newFps: number) => {
      setFps(newFps);
      if (playIntervalRef.current) startPlayInterval(newFps, speedMultiplier);
    },
    [speedMultiplier, startPlayInterval],
  );

  const handleSpeedChange = useCallback(
    (newSpeed: number) => {
      setSpeedMultiplier(newSpeed);
      if (playIntervalRef.current) startPlayInterval(fps, newSpeed);
    },
    [fps, startPlayInterval],
  );

  const handleLoopRangeChange = useCallback(
    (start: number, end: number) => {
      const cStart = Math.max(0, Math.min(start, totalFrames - 1));
      const cEnd = Math.max(0, Math.min(end, totalFrames - 1));
      setLoopStart(cStart);
      setLoopEnd(cEnd);
    },
    [totalFrames],
  );

  const handleStepForward = useCallback(() => {
    const next = Math.min(currentFrame + 1, loopEndRef.current);
    onSeek(next);
  }, [currentFrame, onSeek]);

  const handleStepBackward = useCallback(() => {
    const prev = Math.max(currentFrame - 1, loopStartRef.current);
    onSeek(prev);
  }, [currentFrame, onSeek]);

  const handleSeek = useCallback(
    (frame: number) => {
      if (playing) {
        setPlaying(false);
        if (playIntervalRef.current) {
          clearInterval(playIntervalRef.current);
          playIntervalRef.current = null;
        }
      }
      onSeek(frame);
    },
    [onSeek, playing],
  );

  const effectiveSnapshot = storeSnapshot ?? snapshot;

  // Axis alignment moves the camera like a drag does; the renderer's
  // camera-change callback then syncs `camera_state` back to Python.
  const handleAlignView = useCallback((axis: ViewAxis) => {
    rendererRef.current?.alignCameraToAxis(axis);
  }, []);
  const hasCell = latticeVectors(effectiveSnapshot?.box) !== null;

  return (
    <div
      data-testid="megane-viewer"
      data-megane-context="widget-pipeline"
      data-atom-count={effectiveSnapshot?.nAtoms ?? 0}
      data-bond-count={bondCount}
      data-total-frames={totalFrames}
      data-current-frame={currentFrame}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Viewport
        snapshot={effectiveSnapshot}
        frame={frame}
        onRendererReady={handleRendererReady}
        onHover={setHoverInfo}
        onAtomRightClick={handleAtomRightClick}
        onFrameUpdated={handleFrameUpdated}
      />

      {totalFrames > 1 && (
        <Timeline
          currentFrame={currentFrame}
          totalFrames={totalFrames}
          playing={playing}
          fps={fps}
          speedMultiplier={speedMultiplier}
          loopStart={loopStart}
          loopEnd={loopEnd}
          onSeek={handleSeek}
          onPlayPause={handlePlayPause}
          onFpsChange={handleFpsChange}
          onSpeedChange={handleSpeedChange}
          onLoopRangeChange={handleLoopRangeChange}
          onStepBackward={handleStepBackward}
          onStepForward={handleStepForward}
        />
      )}
      <div
        data-testid="view-controls"
        style={{ position: "absolute", top: OVERLAY_INSET, left: OVERLAY_INSET, zIndex: 10 }}
      >
        <ViewAxisControls hasCell={hasCell} onAlign={handleAlignView} />
      </div>
      <Tooltip info={hoverInfo} />
      <MeasurementPanel
        selection={selection}
        measurement={measurement}
        elements={effectiveSnapshot?.elements ?? null}
        onClear={handleClearSelection}
      />
    </div>
  );
}
