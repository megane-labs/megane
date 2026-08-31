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
import { parseXTCFile } from "./parsers/xtc";
import { loadMultiFileTemplate } from "./pipeline/templateAssets";
import type { TemplateAssetSources } from "./pipeline/templateAssets";
import { MemoryFrameProvider } from "./pipeline/types";
import defaultPDB from "../tests/fixtures/caffeine_water.pdb?raw";
import defaultXtcUrl from "../tests/fixtures/caffeine_water_vibration.xtc?url";
import perovskiteXYZ from "../tests/fixtures/perovskite_srtio3_3x3x3.xyz?raw";
import quartzXYZ from "../tests/fixtures/quartz_sio2_2x2x2.xyz?raw";
import ubiquitinPDB from "../tests/fixtures/1ubq.pdb?raw";
import ubiquitinCgPDB from "../tests/fixtures/1ubq_cg.pdb?raw";
import glycineCIF from "../tests/fixtures/glycine_csd.cif?raw";
import caffeineSDF from "../tests/fixtures/caffeine.sdf?raw";
// The ESP grid is fetched rather than inlined: ~150 kB of text belongs in an
// emitted asset, not in the entry bundle every visitor downloads.
import caffeineEspCubeUrl from "../tests/fixtures/caffeine_esp.cube?url";
import "./styles/megane.css";
import { useThemeStore } from "./stores/useThemeStore";
import { ErrorBoundary } from "./components/ErrorBoundary";

import type { DataMode } from "./types";
import type { StructureParseResult } from "./parsers/structure";
export type { DataMode };

/** Applies data-theme attribute to <html> and listens for OS preference changes. */
function ThemeSync() {
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const syncSystem = useThemeStore((s) => s._syncSystemTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", syncSystem);
    return () => mq.removeEventListener("change", syncSystem);
  }, [syncSystem]);

  return null;
}

/** Bundled fixtures for the templates that load more than one file. */
const TEMPLATE_ASSETS: TemplateAssetSources = {
  caffeineSdf: caffeineSDF,
  caffeineEspCubeUrl,
  ubiquitinPdb: ubiquitinPDB,
  ubiquitinCgPdb: ubiquitinCgPDB,
};

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

  // Load data when a pipeline template is applied
  const pendingTemplateId = usePipelineStore((s) => s.pendingTemplateId);
  const clearPendingTemplate = usePipelineStore((s) => s.clearPendingTemplate);

  useEffect(() => {
    if (!pendingTemplateId) return;
    (async () => {
      if (pendingTemplateId === "molecule") {
        await ds.local.loadText(defaultPDB, "caffeine_water.pdb");
        const resp = await fetch(defaultXtcUrl);
        const blob = await resp.blob();
        const xtcFile = new File([blob], "caffeine_water_vibration.xtc");
        await ds.local.loadXtc(xtcFile);
      } else if (pendingTemplateId === "solid") {
        await ds.local.loadText(perovskiteXYZ, "perovskite_srtio3_3x3x3.xyz");
      } else if (pendingTemplateId === "molecular_crystal") {
        await ds.local.loadText(glycineCIF, "glycine_csd.cif");
      } else if (pendingTemplateId === "surface_mesh") {
        await ds.local.loadText(quartzXYZ, "quartz_sio2_2x2x2.xyz");
      } else if (pendingTemplateId === "protein") {
        await ds.local.loadText(ubiquitinPDB, "1ubq.pdb");
      } else if (pendingTemplateId === "streaming") {
        // Load via ds.local so ds.snapshot updates → Viewport.loadSnapshot uses caffeine atoms
        const result = await ds.local.loadText(defaultPDB, "caffeine_water.pdb");
        const resp = await fetch(defaultXtcUrl);
        const blob = await resp.blob();
        const xtcFile = new File([blob], "caffeine_water_vibration.xtc");
        const { frames, meta } = await parseXTCFile(xtcFile, result.snapshot.nAtoms);
        const store = usePipelineStore.getState();
        const streamNode = store.nodes.find((n) => n.type === "streaming");
        if (streamNode) {
          const provider = meta
            ? new MemoryFrameProvider(frames, meta, result.snapshot.positions)
            : null;
          store.setNodeStreamingData(streamNode.id, {
            snapshot: result.snapshot,
            streamProvider: provider,
          });
          store.updateNodeParams(streamNode.id, { connected: true });
        }
      } else {
        // Templates that need more than one file (a cube for an isosurface, a
        // second structure to overlay) load through the pipeline-side helper.
        await loadMultiFileTemplate(
          pendingTemplateId,
          TEMPLATE_ASSETS,
          usePipelineStore.getState,
          ds.local.loadText,
        );
      }
      clearPendingTemplate();
    })().catch(() => {});
  }, [pendingTemplateId]);

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
      ds.uploadStructure(file, preParsed);
    },
    [ds.uploadStructure],
  );

  const handleUploadTrajectory = useCallback(
    (file: File) => {
      usePlaybackStore.getState().pause();
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
        onBondSourceChange={ds.setBondSource}
        onLabelSourceChange={ds.setLabelSource}
        onLoadLabelFile={ds.loadLabelFile}
        onVectorSourceChange={ds.setVectorSource}
        onLoadVectorFile={ds.loadVectorFile}
        onLoadDemoVectors={ds.loadDemoVectors}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary context="webapp">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
