/**
 * Self-contained pipeline viewer for embedding in MDX, docs, and other contexts.
 * Accepts a SerializedPipeline JSON as a prop, fetches structure files via fileUrl,
 * and renders Viewport + Timeline with full trajectory playback support.
 *
 * Unlike MeganeViewer and WidgetViewer, this component uses NO global stores
 * (no usePipelineStore, no usePlaybackStore), so multiple instances on the same
 * page are fully independent.
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
import type { Node, Edge } from "@xyflow/react";
import { Viewport } from "./Viewport";
import { Timeline } from "./Timeline";
import { Tooltip } from "./Tooltip";
import { MoleculeRenderer } from "../renderer/MoleculeRenderer";
import { useAtomSelection } from "../hooks/useAtomSelection";
import { deserializePipeline } from "../pipeline/serialize";
import { executePipeline } from "../pipeline/execute";
import { applyViewportState, applyVectorsForFrame } from "../pipeline/apply";
import { parseStructureFile } from "../parsers/structure";
import {
  useFrameDistanceBonds,
  hasDistanceBondNode,
  distanceBondVdwScale,
} from "../hooks/useFrameDistanceBonds";
import type { PipelineNodeData, NodeSnapshotData } from "../pipeline/execute";
import type {
  SerializedPipeline,
  ViewportState,
  LoadStructureParams,
  FrameProvider,
} from "../pipeline/types";
import { DEFAULT_VIEWPORT_STATE } from "../pipeline/types";
import type { Snapshot, Frame, HoverInfo } from "../types";

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

  // Pipeline execution results
  const [nodes, setNodes] = useState<Node<PipelineNodeData>[]>([]);
  const [_edges, setEdges] = useState<Edge[]>([]);
  const [viewportState, setViewportState] = useState<ViewportState>(DEFAULT_VIEWPORT_STATE);
  const [primarySnapshot, setPrimarySnapshot] = useState<Snapshot | null>(null);

  // Trajectory playback (local state — no global store)
  const [provider, setProvider] = useState<FrameProvider | null>(null);
  const [totalFrames, setTotalFrames] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [currentFrameData, setCurrentFrameData] = useState<Frame | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fps, setFpsState] = useState(30);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);

  // Refs for setInterval (avoids stale closure)
  const rendererRef = useRef<MoleculeRenderer | null>(null);
  const prevViewportStateRef = useRef<ViewportState | null>(null);
  const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentFrameRef = useRef(0);
  const providerRef = useRef<FrameProvider | null>(null);
  const totalFramesRef = useRef(0);
  const fpsRef = useRef(30);
  const speedRef = useRef(1);
  const loopStartRef = useRef(0);
  const loopEndRef = useRef(0);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  // Keep refs in sync
  providerRef.current = provider;
  totalFramesRef.current = totalFrames;
  fpsRef.current = fps;
  speedRef.current = speedMultiplier;
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;

  const { handleAtomRightClick, handleFrameUpdated } = useAtomSelection(rendererRef);

  // ─── Initialization: fetch files + parse + execute pipeline ──────

  useEffect(() => {
    const abortController = new AbortController();
    const { signal } = abortController;

    // Reset state for each pipeline prop change
    setStatus("loading");
    setErrorMessage(null);
    setNodes([]);
    setEdges([]);
    setViewportState(DEFAULT_VIEWPORT_STATE);
    setPrimarySnapshot(null);
    setProvider(null);
    setTotalFrames(0);
    currentFrameRef.current = 0;
    setCurrentFrame(0);
    setCurrentFrameData(null);
    setLoopStart(0);
    setLoopEnd(0);

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

        // Extract primary snapshot for Viewport
        const snap = vs.particles[0]?.source ?? null;

        // Extract trajectory provider
        const traj = vs.trajectories[0] ?? null;
        const prov = traj?.provider ?? null;
        const frames = prov ? prov.meta.nFrames : 0;
        const frame0 = prov ? prov.getFrame(0) : null;

        setNodes(deserializedNodes);
        setEdges(deserializedEdges);
        setViewportState(vs);
        setPrimarySnapshot(snap);
        setProvider(prov);
        setTotalFrames(frames);
        currentFrameRef.current = 0;
        setCurrentFrame(0);
        setCurrentFrameData(frame0);
        setLoopStart(0);
        setLoopEnd(frames > 0 ? frames - 1 : 0);
        setStatus("ready");
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
  }, [pipeline]);

  // ─── Apply viewportState to renderer when ready ──────────────────

  const handleRendererReady = useCallback(
    (renderer: MoleculeRenderer) => {
      rendererRef.current = renderer;
      applyViewportState(renderer, viewportState, null);
      prevViewportStateRef.current = viewportState;
    },
    [viewportState],
  );

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    applyViewportState(renderer, viewportState, prevViewportStateRef.current);
    prevViewportStateRef.current = viewportState;
  }, [viewportState]);

  // ─── Per-frame vector update ─────────────────────────────────────

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (viewportState.vectors.length > 0) {
      applyVectorsForFrame(renderer, viewportState.vectors, currentFrame);
    }
  }, [currentFrame, viewportState.vectors]);

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

  const startInterval = useCallback(() => {
    if (playIntervalRef.current !== null) return;
    playIntervalRef.current = setInterval(
      () => {
        const prov = providerRef.current;
        const total = totalFramesRef.current;
        if (!prov || total <= 1) return;
        const effectiveEnd = Math.min(loopEndRef.current, total - 1);
        const effectiveStart = Math.max(loopStartRef.current, 0);
        let next = currentFrameRef.current + 1;
        if (next > effectiveEnd) next = effectiveStart;
        const frame = prov.getFrame(next);
        currentFrameRef.current = next;
        setCurrentFrame(next);
        setCurrentFrameData(frame);
      },
      1000 / (fpsRef.current * speedRef.current),
    );
  }, []);

  const stopInterval = useCallback(() => {
    if (playIntervalRef.current !== null) {
      clearInterval(playIntervalRef.current);
      playIntervalRef.current = null;
    }
  }, []);

  const handleSeek = useCallback(
    (index: number) => {
      const prov = providerRef.current;
      if (!prov) return;
      if (playing) {
        stopInterval();
        setPlaying(false);
      }
      const frame = prov.getFrame(index);
      currentFrameRef.current = index;
      setCurrentFrame(index);
      setCurrentFrameData(frame);
    },
    [playing, stopInterval],
  );

  const handlePlayPause = useCallback(() => {
    if (playing) {
      stopInterval();
      setPlaying(false);
    } else {
      setPlaying(true);
      startInterval();
    }
  }, [playing, startInterval, stopInterval]);

  const handleFpsChange = useCallback(
    (newFps: number) => {
      setFpsState(newFps);
      fpsRef.current = newFps;
      if (playing) {
        stopInterval();
        startInterval();
      }
    },
    [playing, startInterval, stopInterval],
  );

  const handleSpeedChange = useCallback(
    (newSpeed: number) => {
      setSpeedMultiplier(newSpeed);
      speedRef.current = newSpeed;
      if (playing) {
        stopInterval();
        startInterval();
      }
    },
    [playing, startInterval, stopInterval],
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
    const prov = providerRef.current;
    if (!prov) return;
    const next = Math.min(currentFrameRef.current + 1, loopEndRef.current);
    const frame = prov.getFrame(next);
    currentFrameRef.current = next;
    setCurrentFrame(next);
    setCurrentFrameData(frame);
  }, []);

  const handleStepBackward = useCallback(() => {
    const prov = providerRef.current;
    if (!prov) return;
    const prev = Math.max(currentFrameRef.current - 1, loopStartRef.current);
    const frame = prov.getFrame(prev);
    currentFrameRef.current = prev;
    setCurrentFrame(prev);
    setCurrentFrameData(frame);
  }, []);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      stopInterval();
    };
  }, [stopInterval]);

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
      <Tooltip info={hoverInfo} />
    </div>
  );
}
