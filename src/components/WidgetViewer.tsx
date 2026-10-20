/**
 * Simplified megane viewer for Jupyter widget embedding.
 * Minimal UI: Viewport + Timeline + Tooltip + MeasurementPanel, plus the
 * opt-in Quick Style panel (`MolecularViewer(quick_style=True)`).
 *
 * The visual pipeline editor is intentionally not mounted here — it is
 * webapp / JupyterLab / VSCode only. Pipeline data still flows in via
 * `pipelineJson` + `nodeSnapshotsData` from `MolecularViewer.set_pipeline()`.
 * Quick Style is the one exception that edits the pipeline in the widget: it
 * only changes node parameters (no graph UI), and every change is written
 * back through `onPipelineChange` so it lands in `_pipeline_json` and in the
 * notebook's saved widget state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";
import { Viewport } from "./Viewport";
import { Timeline } from "./Timeline";
import { Tooltip } from "./Tooltip";
import { MeasurementPanel } from "./MeasurementPanel";
import { ViewAxisControls } from "./ViewAxisControls";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { QuickStylePanel } from "./QuickStylePanel";
import { OVERLAY_INSET } from "./overlayLayout";
import { MoleculeRenderer, type MeganeCameraState } from "../renderer/MoleculeRenderer";
import { latticeVectors, type ViewAxis } from "../renderer/cameraOrientation";
import { useAtomSelection } from "../hooks/useAtomSelection";
import {
  useFrameDistanceBonds,
  hasDistanceBondNode,
  distanceBondVdwScale,
} from "../hooks/useFrameDistanceBonds";
import { useViewportStateSync } from "../hooks/useViewportStateSync";
import { useControlledPlayback } from "../hooks/useControlledPlayback";
import { createPipelineStore, type PipelineStore } from "../pipeline/store";
import { decodeSnapshot, decodeHeader, MSG_SNAPSHOT } from "../protocol/protocol";
import type { Snapshot, Frame, Measurement, HoverInfo } from "../types";
import { applyThemeBackground, useRendererThemeBackground } from "../stores/useThemeStore";

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
  /**
   * A camera state set from Python after mount (`viewer.camera_state = …`).
   * Applied to the live view whenever a new object arrives.
   */
  cameraState?: MeganeCameraState | null;
  /** Show the Quick Style panel (the `quick_style` traitlet). */
  quickStyle?: boolean;
  // Optional pipeline store override. Each Jupyter widget mount creates its
  // own private store so multiple MolecularViewers in the same notebook do
  // not share state. Tests pass their own store to inspect internal state.
  pipelineStore?: StoreApi<PipelineStore>;
}

/** Quick Style edits are written back to Python at most this often while dragging. */
export const QUICK_STYLE_SYNC_DELAY_MS = 300;

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
  onPipelineChange,
  initialCameraState,
  onCameraStateChange,
  cameraState,
  quickStyle = false,
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
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const [bondCount, setBondCount] = useState<number>(0);
  const onCameraStateChangeRef = useRef(onCameraStateChange);
  onCameraStateChangeRef.current = onCameraStateChange;
  const initialCameraStateRef = useRef(initialCameraState);

  // A camera state Python sets on a displayed widget moves the view now; one
  // that arrives before the renderer exists is restored when it attaches.
  useEffect(() => {
    if (!cameraState) return;
    initialCameraStateRef.current = cameraState;
    rendererRef.current?.applyCameraState(cameraState);
  }, [cameraState]);

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

  // The playhead is the Python model's `frame_index`, so playback is
  // controlled: ticks go out through `onSeek` and come back as `currentFrame`.
  const playback = useControlledPlayback({ currentFrame, totalFrames, onSeek });

  // Sync external atom selection from Python
  useEffect(() => {
    setExternalSelection(selectedAtoms ?? []);
  }, [selectedAtoms, setExternalSelection]);
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
  // The pipeline JSON this viewer last wrote back (Quick Style). When the
  // model echoes it, nothing else changed, so there is nothing to reload.
  const echoedPipelineJsonRef = useRef<string | null>(null);
  const prevInputsRef = useRef<{ snapshot: Snapshot | null; data?: Record<string, DataView> }>({
    snapshot: null,
  });
  useEffect(() => {
    const inputsUnchanged =
      prevInputsRef.current.snapshot === snapshot &&
      prevInputsRef.current.data === nodeSnapshotsData;
    prevInputsRef.current = { snapshot, data: nodeSnapshotsData };
    if (pipelineJson && pipelineJson === echoedPipelineJsonRef.current && inputsUnchanged) {
      return;
    }
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
    // Re-applying the viewport state and restoring the camera are
    // useViewportStateSync's job: it runs once the Viewport has loaded the
    // snapshot these updates produce.
  }, [snapshot, nodeSnapshotsData, pipelineJson, setSnapshot, pipelineStore]);

  // Quick Style → Python. Debounced so dragging a slider sends one update, and
  // flushed on unmount so the last change is not lost.
  const onPipelineChangeRef = useRef(onPipelineChange);
  onPipelineChangeRef.current = onPipelineChange;
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPendingRef = useRef(false);
  const flushPipelineSync = useCallback(() => {
    if (syncTimerRef.current !== null) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = null;
    if (!syncPendingRef.current) return;
    syncPendingRef.current = false;
    const json = JSON.stringify(pipelineStore.getState().serialize());
    prevPipelineJsonRef.current = json;
    echoedPipelineJsonRef.current = json;
    onPipelineChangeRef.current?.(json);
  }, [pipelineStore]);
  const schedulePipelineSync = useCallback(() => {
    syncPendingRef.current = true;
    if (syncTimerRef.current !== null) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(flushPipelineSync, QUICK_STYLE_SYNC_DELAY_MS);
  }, [flushPipelineSync]);
  useEffect(() => flushPipelineSync, [flushPipelineSync]);
  const [quickStyleCollapsed, setQuickStyleCollapsed] = useState(false);

  const effectiveSnapshot = storeSnapshot ?? snapshot;

  // Renderer ⇄ viewportState sync, shared with MeganeViewer / PipelineViewer.
  // Subscribes without re-rendering this component, so a Quick Style edit (or
  // any other execute) no longer re-renders the Timeline and overlays.
  //
  // Primary node: the Viewport draws `effectiveSnapshot`, which is the
  // store's `snapshot` — the lowest-id entry of `nodeSnapshots`, not
  // necessarily the node behind the first particle stream. Name that node
  // explicitly, or with two structures whose viewport edges come in the
  // other order the built-in meshes would get the other node's overrides and
  // the Viewport's own structure would be drawn a second time as a layer.
  const { attachRenderer } = useViewportStateSync(rendererRef, pipelineStore, {
    snapshot: effectiveSnapshot,
    getPrimaryNodeId: () => {
      const { snapshot: snap, nodeSnapshots } = pipelineStore.getState();
      if (!snap) return undefined;
      return Object.keys(nodeSnapshots)
        .sort()
        .find((id) => nodeSnapshots[id].snapshot === snap);
    },
    getInitialCameraState: () => initialCameraStateRef.current,
    onBondCount: setBondCount,
  });

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

  useRendererThemeBackground(rendererRef);

  const handleRendererReady = useCallback(
    (renderer: MoleculeRenderer) => {
      applyThemeBackground(renderer);
      attachRenderer(renderer);
      // Apply initial selectedAtoms that may have arrived before the renderer was ready
      setExternalSelection(selectedAtomsRef.current ?? []);
      // Register camera change callback for host-side persistence
      renderer.setCameraChangeCallback(() => {
        const state = renderer.getCameraState();
        if (state) onCameraStateChangeRef.current?.(state);
      });
    },
    [setExternalSelection, attachRenderer],
  );

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
        <Timeline {...playback} currentFrame={currentFrame} totalFrames={totalFrames} />
      )}
      <div
        data-testid="view-controls"
        style={{ position: "absolute", top: OVERLAY_INSET, left: OVERLAY_INSET, zIndex: 10 }}
      >
        <ViewAxisControls hasCell={hasCell} onAlign={handleAlignView} />
      </div>
      {quickStyle && (
        <CollapsiblePanel
          title="Style"
          collapsed={quickStyleCollapsed}
          onToggleCollapse={() => setQuickStyleCollapsed((c) => !c)}
          width={260}
          bottom="auto"
        >
          <div style={{ padding: "10px 14px", overflowY: "auto", maxHeight: 300 }}>
            <QuickStylePanel
              store={pipelineStore}
              framed={false}
              onApplied={schedulePipelineSync}
              disabledReason={
                pipelineJson
                  ? null
                  : "Quick style edits the viewer's pipeline. Load data with viewer.set_pipeline(...) to use it."
              }
            />
          </div>
        </CollapsiblePanel>
      )}
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
