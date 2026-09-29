/**
 * anywidget entry point.
 * Bridges the Python widget model to the WidgetViewer React component.
 *
 * Handles deferred initialization: Jupyter widget output areas may have
 * zero dimensions when the render function is first called.  We use a
 * ResizeObserver to wait until the container is laid out before mounting React.
 */

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WidgetViewer } from "./components/WidgetViewer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { perfMark, perfMeasure } from "./perf";
import { installThemeSync } from "./stores/useThemeStore";
import {
  decodeSnapshot,
  decodeFrame,
  decodeHeader,
  decodeTrajectory,
  MSG_SNAPSHOT,
  MSG_FRAME,
  MSG_TRAJECTORY,
  type EmbeddedTrajectory,
} from "./protocol/protocol";
import type { Snapshot, Frame, Measurement } from "./types";
import type { MeganeCameraState } from "./renderer/MoleculeRenderer";

interface AnyWidgetModel {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  save_changes(): void;
  on(event: string, callback: () => void): void;
}

function render({ model, el }: { model: AnyWidgetModel; el: HTMLElement }) {
  perfMark("megane:widget:start");
  // Container setup
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "500px";
  container.style.position = "relative";
  container.style.background = "var(--megane-bg, #ffffff)";
  container.style.borderRadius = "8px";
  container.style.overflow = "hidden";
  el.appendChild(container);

  // Colour tokens + data-theme on the document root, following the notebook
  // host's theme (JupyterLab / VSCode) or the OS preference.
  const uninstallThemeSync = installThemeSync();

  let root: Root | null = null;
  let currentSnapshot: Snapshot | null = null;
  let currentFrame: Frame | null = null;
  let embeddedTrajectory: EmbeddedTrajectory | null = null;
  let disposed = false;

  // Without a kernel (a saved notebook reopened, or a static HTML export) the
  // model has no comm to sync over and save_changes() throws. Local state is
  // already updated by then, so playback of an embedded trajectory goes on.
  function saveChanges() {
    try {
      model.save_changes();
    } catch {
      // No kernel to tell.
    }
  }

  function parseSnapshot(): Snapshot | null {
    const data = model.get("_snapshot_data") as DataView | null;
    if (!data || data.byteLength === 0) return null;
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const { msgType } = decodeHeader(buffer);
    if (msgType === MSG_SNAPSHOT) {
      return decodeSnapshot(buffer);
    }
    return null;
  }

  function parseFrame(): Frame | null {
    const data = model.get("_frame_data") as DataView | null;
    if (!data || data.byteLength === 0) return null;
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const { msgType } = decodeHeader(buffer);
    if (msgType === MSG_FRAME) {
      return decodeFrame(buffer);
    }
    return null;
  }

  function parseTrajectory(): EmbeddedTrajectory | null {
    const data = model.get("_trajectory_data") as DataView | null;
    if (!data || data.byteLength === 0) return null;
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    const { msgType } = decodeHeader(buffer);
    return msgType === MSG_TRAJECTORY ? decodeTrajectory(buffer) : null;
  }

  /** The frame to show: from the embedded trajectory when there is one. */
  function resolveFrame(): Frame | null {
    if (embeddedTrajectory) {
      return embeddedTrajectory.getFrame((model.get("frame_index") as number) || 0);
    }
    return parseFrame();
  }

  function handleSeek(frame: number) {
    const totalFrames = (model.get("total_frames") as number) || 0;
    if (frame === -1) {
      // "next frame" signal from playback
      const current = (model.get("frame_index") as number) || 0;
      const next = (current + 1) % totalFrames;
      model.set("frame_index", next);
    } else {
      model.set("frame_index", frame);
    }
    saveChanges();
  }

  function handleMeasurementChange(measurement: Measurement | null) {
    const json = measurement ? JSON.stringify(measurement) : "";
    model.set("_measurement_json", json);
    saveChanges();
  }

  function handlePipelineChange(json: string) {
    model.set("_pipeline_json", json);
    saveChanges();
  }

  function handleCameraStateChange(state: MeganeCameraState) {
    model.set("camera_state", state);
    saveChanges();
  }

  function getInitialCameraState(): MeganeCameraState | null {
    const saved = model.get("camera_state") as Record<string, unknown> | null;
    if (
      saved &&
      typeof saved.mode === "string" &&
      Array.isArray(saved.position) &&
      Array.isArray(saved.target) &&
      typeof saved.zoom === "number"
    ) {
      return saved as unknown as MeganeCameraState;
    }
    return null;
  }

  function renderApp() {
    if (!root || disposed) return;
    const frameIndex = (model.get("frame_index") as number) || 0;
    const totalFrames = (model.get("total_frames") as number) || 0;
    const selectedAtoms = (model.get("selected_atoms") as number[]) || [];
    const pipelineJson = (model.get("_pipeline_json") as string) || "";
    const nodeSnapshotsData = (model.get("_node_snapshots_data") as Record<string, DataView>) || {};

    root.render(
      createElement(
        ErrorBoundary,
        { context: "widget" },
        createElement(WidgetViewer, {
          snapshot: currentSnapshot,
          frame: currentFrame,
          currentFrame: frameIndex,
          totalFrames: totalFrames,
          onSeek: handleSeek,
          selectedAtoms: selectedAtoms,
          onMeasurementChange: handleMeasurementChange,
          pipelineJson: pipelineJson,
          nodeSnapshotsData: nodeSnapshotsData,
          onPipelineChange: handlePipelineChange,
          initialCameraState: getInitialCameraState(),
          onCameraStateChange: handleCameraStateChange,
        }),
      ),
    );
  }

  function initApp(): boolean {
    if (root || disposed) return !!root;
    if (container.clientWidth === 0 || container.clientHeight === 0) return false;

    root = createRoot(container);
    currentSnapshot = parseSnapshot();
    embeddedTrajectory = parseTrajectory();
    currentFrame = resolveFrame();
    renderApp();
    perfMark("megane:widget:end");
    perfMeasure("megane:widget-mount", "megane:widget:start", "megane:widget:end");
    return true;
  }

  // Defer initialization until the container has real dimensions.
  const ro = new ResizeObserver(() => {
    if (!root && !disposed) initApp();
  });
  ro.observe(container);
  initApp();

  // React to model changes
  model.on("change:_snapshot_data", () => {
    currentSnapshot = parseSnapshot();
    if (root) renderApp();
    else initApp();
  });

  model.on("change:_frame_data", () => {
    if (embeddedTrajectory) return;
    currentFrame = parseFrame();
    renderApp();
  });

  model.on("change:_trajectory_data", () => {
    embeddedTrajectory = parseTrajectory();
    currentFrame = resolveFrame();
    renderApp();
  });

  model.on("change:frame_index", () => {
    if (embeddedTrajectory) currentFrame = resolveFrame();
    renderApp();
  });

  model.on("change:total_frames", () => {
    renderApp();
  });

  model.on("change:selected_atoms", () => {
    renderApp();
  });

  model.on("change:_node_snapshots_data", () => {
    renderApp();
  });

  model.on("change:_pipeline_json", () => {
    renderApp();
  });

  // Cleanup
  return () => {
    disposed = true;
    ro.disconnect();
    uninstallThemeSync();
    root?.unmount();
    root = null;
  };
}

export default { render };
