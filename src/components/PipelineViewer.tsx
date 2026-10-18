/**
 * Self-contained pipeline viewer for embedding in MDX, docs, and other contexts.
 * Accepts a SerializedPipeline JSON as a prop, fetches structure files via fileUrl,
 * and renders Viewport + Timeline with full trajectory playback support.
 *
 * Unlike MeganeViewer and WidgetViewer, this component uses NO global stores
 * (no usePipelineStore, no usePlaybackStore singleton): it keeps the executed
 * viewport state in a private store and plays trajectories through a private
 * playback store (`createPlaybackStore`, the same loop MeganeViewer runs), so
 * multiple instances on the same page are fully independent.
 *
 * Usage:
 *   <PipelineViewer
 *     width="100%"
 *     height={500}
 *     pipeline={{
 *       version: 3,
 *       nodes: [
 *         { id: "s1", type: "load_structure", fileName: "protein.pdb",
 *           fileUrl: "/structures/protein.pdb",
 *           hasTrajectory: false, hasCell: false, position: { x: 0, y: 0 } },
 *         { id: "v1", type: "viewport", perspective: false,
 *           cellAxesVisible: true, pivotMarkerVisible: true, position: { x: 0, y: 200 } }
 *       ],
 *       edges: [
 *         { source: "s1", target: "v1", sourceHandle: "particle", targetHandle: "particle" }
 *       ]
 *     }}
 *   />
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { Node } from "@xyflow/react";
import { Viewport } from "./Viewport";
import { Timeline } from "./Timeline";
import { Tooltip } from "./Tooltip";
import { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { useAtomSelection } from "../hooks/useAtomSelection";
import { useViewportStateSync, type ViewportStateHolder } from "../hooks/useViewportStateSync";
import { deserializePipeline } from "../pipeline/serialize";
import { executePipeline } from "../pipeline/execute";
import { applyVectorsForFrame } from "../pipeline/apply";
import { parseStructureFile } from "../parsers/structure";
import {
  useFrameDistanceBonds,
  hasDistanceBondNode,
  distanceBondVdwScale,
} from "../hooks/useFrameDistanceBonds";
import { createPlaybackStore } from "../stores/usePlaybackStore";
import type { PipelineNodeData, NodeSnapshotData } from "../pipeline/execute";
import type { SerializedPipeline, LoadStructureParams } from "../pipeline/types";
import { DEFAULT_VIEWPORT_STATE } from "../pipeline/types";
import type { HoverInfo } from "../types";

interface PipelineViewerProps {
  pipeline: SerializedPipeline;
  width?: string | number;
  height?: string | number;
}

type LoadStatus = "loading" | "ready" | "error";

/** Extract the file name from a URL path (last path segment). */
function basenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, globalThis.location?.href ?? "http://localhost").pathname;
    return pathname.split("/").pop() ?? "file.bin";
  } catch {
    return url.split("/").pop() ?? "file.bin";
  }
}

export function PipelineViewer({ pipeline, width = "100%", height = 500 }: PipelineViewerProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Pipeline execution results. The viewport state lives in a private
  // vanilla store so useViewportStateSync can follow it without re-rendering
  // this component; the trajectory plays through a private playback store.
  const [nodes, setNodes] = useState<Node<PipelineNodeData>[]>([]);
  const [viewportStore] = useState(() =>
    createStore<ViewportStateHolder>(() => ({ viewportState: DEFAULT_VIEWPORT_STATE })),
  );
  const [playbackStore] = useState(() => createPlaybackStore());

  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  const { handleAtomRightClick, handleFrameUpdated } = useAtomSelection(rendererRef);

  // The Viewport draws the first particle stream's source, which is also the
  // node `applyViewportState` treats as primary when none is named — so,
  // unlike MeganeViewer / WidgetViewer, no `getPrimaryNodeId` is needed.
  const primarySnapshot = useStore(
    viewportStore,
    (s) => s.viewportState.particles[0]?.source ?? null,
  );
  const { attachRenderer } = useViewportStateSync(rendererRef, viewportStore, {
    snapshot: primarySnapshot,
    onTrajectoryProvider: (provider) => playbackStore.getState().setProvider(provider),
  });

  // ─── Initialization: fetch files + parse + execute pipeline ──────

  useEffect(() => {
    const abortController = new AbortController();
    const { signal } = abortController;

    // Reset state for each pipeline prop change. Clearing the viewport state
    // also hands the playback store a null provider, which stops playback.
    setStatus("loading");
    setErrorMessage(null);
    setNodes([]);
    viewportStore.setState({ viewportState: DEFAULT_VIEWPORT_STATE });

    async function init() {
      try {
        const { nodes: deserializedNodes, edges: deserializedEdges } =
          deserializePipeline(pipeline);

        // Find load_structure nodes with fileUrl
        const loadNodes = deserializedNodes.filter(
          (n) => n.type === "load_structure" && (n.data.params as LoadStructureParams).fileUrl,
        );

        // Fetch and parse all structure files in parallel
        const nodeSnapshots: Record<string, NodeSnapshotData> = {};
        await Promise.all(
          loadNodes.map(async (node) => {
            const params = node.data.params as LoadStructureParams;
            const url = params.fileUrl!;
            const fileName = params.fileName ?? basenameFromUrl(url);

            const response = await fetch(url, { signal });
            if (!response.ok) {
              throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
            }
            const blob = await response.blob();
            const file = new File([blob], fileName);
            const result = await parseStructureFile(file);

            nodeSnapshots[node.id] = {
              snapshot: result.snapshot,
              frames: result.frames.length > 0 ? result.frames : null,
              meta: result.meta,
              labels: result.labels,
            };
          }),
        );

        if (signal.aborted) return;

        // Execute pipeline with parsed snapshots
        const { viewportState: vs } = executePipeline(deserializedNodes, deserializedEdges, {
          nodeSnapshots,
        });

        // The primary snapshot (Viewport) and the trajectory provider
        // (playback store) follow from the viewport state.
        setNodes(deserializedNodes);
        setStatus("ready");
        viewportStore.setState({ viewportState: vs });
      } catch (err) {
        if (signal.aborted) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }

    init();

    return () => {
      abortController.abort();
    };
  }, [pipeline, viewportStore]);

  // ─── Per-frame vector update ─────────────────────────────────────

  const currentFrame = useStore(playbackStore, (s) => s.currentFrame);
  const currentFrameData = useStore(playbackStore, (s) => s.currentFrameData);
  const totalFrames = useStore(playbackStore, (s) => s.totalFrames);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const { vectors } = viewportStore.getState().viewportState;
    if (vectors.length > 0) {
      applyVectorsForFrame(renderer, vectors, currentFrame);
    }
  }, [currentFrame, viewportStore]);

  // ─── Per-frame bond recalculation (distance mode) ────────────────

  // Memoized so the hook's effect does not refire on unrelated node edits
  // (position, colour, other params) — only when distance-bond mode toggles.
  const hasDistanceBond = useMemo(() => hasDistanceBondNode(nodes), [nodes]);
  const distanceBondScale = useMemo(() => distanceBondVdwScale(nodes), [nodes]);
  useFrameDistanceBonds({
    rendererRef,
    snapshot: primarySnapshot,
    frame: currentFrameData,
    enabled: hasDistanceBond,
    vdwScale: distanceBondScale,
  });

  // ─── Playback ────────────────────────────────────────────────────

  const playing = useStore(playbackStore, (s) => s.playing);
  const fps = useStore(playbackStore, (s) => s.fps);
  const speedMultiplier = useStore(playbackStore, (s) => s.speedMultiplier);
  const loopStart = useStore(playbackStore, (s) => s.loopStart);
  const loopEnd = useStore(playbackStore, (s) => s.loopEnd);

  // Scrubbing pauses playback (as in the Jupyter widget), so the playhead
  // stays where the user dropped it.
  const handleSeek = useCallback(
    (index: number) => {
      const store = playbackStore.getState();
      store.pause();
      store.seekFrame(index);
    },
    [playbackStore],
  );

  // Stop the private playback interval with the component.
  useEffect(() => () => playbackStore.getState().pause(), [playbackStore]);

  // ─── Render ──────────────────────────────────────────────────────

  const containerStyle: React.CSSProperties = {
    width,
    height,
    position: "relative",
    overflow: "hidden",
    background: "var(--megane-surface-raised)",
    borderRadius: 8,
  };

  if (status === "loading") {
    return (
      <div
        style={{
          ...containerStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--megane-text-muted)",
          fontSize: 16,
        }}
      >
        Loading…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        style={{
          ...containerStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--megane-danger)",
          fontSize: 14,
          padding: 16,
          textAlign: "center",
        }}
      >
        {errorMessage ?? "Failed to load pipeline"}
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <Viewport
        snapshot={primarySnapshot}
        frame={currentFrameData}
        onRendererReady={attachRenderer}
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
          onPlayPause={playbackStore.getState().togglePlayPause}
          onFpsChange={playbackStore.getState().setFps}
          onSpeedChange={playbackStore.getState().setSpeedMultiplier}
          onLoopRangeChange={playbackStore.getState().setLoopRange}
          onStepBackward={playbackStore.getState().stepBackward}
          onStepForward={playbackStore.getState().stepForward}
        />
      )}
      <Tooltip info={hoverInfo} />
    </div>
  );
}
