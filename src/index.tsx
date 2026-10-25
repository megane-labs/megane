/**
 * megane - Standalone web application entry point.
 * Supports two data modes:
 *   - "streaming": connects to Python backend via WebSocket
 *   - "local": parses structure files in-browser via WASM (no server needed)
 *
 * Playback is managed by the playback zustand store (usePlaybackStore).
 * The pipeline produces TrajectoryData with a FrameProvider; MeganeViewer
 * wires it to the playback store which drives frame delivery.
 */

import { StrictMode, useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { MeganeViewer } from "./components/MeganeViewer";
import { useDataSource } from "./hooks/useDataSource";
import { usePipelineStore } from "./pipeline/store";
import { usePlaybackStore } from "./stores/usePlaybackStore";
import { restorePipelineFromHash } from "./pipeline/shareLink";
import { useTour } from "./tour/useTour";
import { useTemplateData } from "./hooks/useTemplateData";
import defaultPDB from "../tests/fixtures/caffeine_water.pdb?raw";
import defaultXtcUrl from "../tests/fixtures/caffeine_water_vibration.xtc?url";
import "./styles/megane.css";
import { ThemeSync } from "./components/ThemeSync";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initAnalytics, trackEvent, trackFileOpen } from "./analytics";
import { setRemoteFileSource } from "./remote/fileSource";
import { detectServerFileSource, shouldProbeServerFiles } from "./remote/serverFiles";

import type { DataMode } from "./types";
import type { StructureParseResult } from "./parsers/structure";
export type { DataMode };

function App() {
  const [mode] = useState<DataMode>("local");
  const ds = useDataSource(mode);
  useTour({ host: "webapp" });

  // Playback store state
  const playing = usePlaybackStore((s) => s.playing);
  const fps = usePlaybackStore((s) => s.fps);
  const togglePlayPause = usePlaybackStore((s) => s.togglePlayPause);
  const setFps = usePlaybackStore((s) => s.setFps);
  const seekFrame = usePlaybackStore((s) => s.seekFrame);

  // Restore pipeline from URL hash (#pipeline=...) when present; otherwise
  // load the bundled demo so first-time visitors see something immediately.
  useEffect(() => {
    (async () => {
      const restored = await restorePipelineFromHash((p) =>
        usePipelineStore.getState().deserialize(p),
      );
      if (restored) return;
      await ds.local.loadText(defaultPDB);
      const resp = await fetch(defaultXtcUrl);
      const blob = await resp.blob();
      const xtcFile = new File([blob], "caffeine_water_vibration.xtc");
      await ds.local.loadXtc(xtcFile);
    })().catch(() => {});
  }, []);

  // Load a pipeline template's demo files when the editor applies one.
  useTemplateData(ds.local, (templateId) =>
    trackEvent("apply_template", { template_id: templateId }),
  );

  const handleSeek = useCallback(
    (frameIdx: number) => {
      seekFrame(frameIdx);
      // Also update legacy data source for backward compat
      ds.seekFrame(frameIdx);
    },
    [seekFrame, ds.seekFrame],
  );

  const handlePlayPause = useCallback(() => {
    togglePlayPause();
  }, [togglePlayPause]);

  const handleFpsChange = useCallback(
    (newFps: number) => {
      setFps(newFps);
    },
    [setFps],
  );

  const handleUploadStructure = useCallback(
    (file: File, preParsed?: StructureParseResult) => {
      usePlaybackStore.getState().pause();
      trackFileOpen("structure", file.name);
      ds.uploadStructure(file, preParsed);
    },
    [ds.uploadStructure],
  );

  const handleUploadTrajectory = useCallback(
    (file: File) => {
      usePlaybackStore.getState().pause();
      trackFileOpen("trajectory", file.name);
      ds.uploadTrajectory(file);
    },
    [ds.uploadTrajectory],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const meganeFile = files.find((f) => f.name.endsWith(".megane.json"));
    if (meganeFile) {
      usePlaybackStore.getState().pause();
      trackFileOpen("pipeline", meganeFile.name);
      const companions = files.filter((f) => f !== meganeFile);
      await usePipelineStore
        .getState()
        .openFile(meganeFile, { companions })
        .catch((err) => {
          console.error("Failed to load .megane.json:", err);
        });
    }
  }, []);

  return (
    <div style={{ width: "100%", height: "100%" }} onDragOver={handleDragOver} onDrop={handleDrop}>
      <ThemeSync />
      <MeganeViewer
        playing={playing}
        fps={fps}
        onSeek={handleSeek}
        onPlayPause={handlePlayPause}
        onFpsChange={handleFpsChange}
        onUploadStructure={handleUploadStructure}
        onUploadTrajectory={handleUploadTrajectory}
      />
    </div>
  );
}

initAnalytics("viewer");

// Served by `megane serve`: the Load nodes can also open files on the server
// (e.g. a cluster reached over an SSH tunnel). Elsewhere nothing is requested
// and nothing changes.
if (shouldProbeServerFiles()) {
  void detectServerFileSource().then((source) => source && setRemoteFileSource(source));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="webapp">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
