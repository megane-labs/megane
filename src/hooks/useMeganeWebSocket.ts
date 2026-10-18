/**
 * Custom hook for WebSocket connection to the megane backend.
 * Handles connection lifecycle, message routing, and frame tracking.
 * Bonds, labels and vectors are configured by the pipeline's nodes, which read
 * the streamed snapshot through the streaming node's data.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { WebSocketClient } from "../stream/WebSocketClient";
import { usePipelineStoreApi, usePlaybackStoreApi } from "../stores/MeganeProvider";
import { StreamFrameProvider } from "../stream/StreamFrameProvider";
import {
  decodeSnapshot,
  decodeFrame,
  decodeMetadata,
  decodeHeader,
  MSG_SNAPSHOT,
  MSG_FRAME,
  MSG_METADATA,
} from "../protocol/protocol";
import type { Snapshot, Frame, TrajectoryMeta, TrajectorySource } from "../types";

export interface MeganeWebSocketState {
  snapshot: Snapshot | null;
  frame: Frame | null;
  meta: TrajectoryMeta | null;
  connected: boolean;
  currentFrame: number;
  setCurrentFrame: (frame: number) => void;
  currentFrameRef: React.MutableRefObject<number>;
  clientRef: React.MutableRefObject<WebSocketClient | null>;
  trajectorySource: TrajectorySource;
  setTrajectorySource: (source: TrajectorySource) => void;
  hasStructureFrames: boolean;
  hasFileFrames: boolean;
}

export function useMeganeWebSocket(url: string | null): MeganeWebSocketState {
  // See useMeganeLocal: scoped when a provider is mounted, global otherwise.
  const pipelineApi = usePipelineStoreApi();
  const playbackApi = usePlaybackStoreApi();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [meta, setMeta] = useState<TrajectoryMeta | null>(null);
  const [connected, setConnected] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [trajectorySource, setTrajectorySourceState] = useState<TrajectorySource>("file");

  const clientRef = useRef<WebSocketClient | null>(null);
  const currentFrameRef = useRef(0);
  const baseSnapshotRef = useRef<Snapshot | null>(null);

  const streamProviderRef = useRef<StreamFrameProvider | null>(null);

  /**
   * Find the first streaming node ID in the pipeline.
   * Used to associate WebSocket data with a streaming node.
   */
  const getStreamingNodeId = useCallback((): string | null => {
    const nodes = pipelineApi.getState().nodes;
    const streamingNode = nodes.find((n) => n.type === "streaming");
    return streamingNode?.id ?? null;
  }, [pipelineApi]);

  useEffect(() => {
    if (!url) return;

    let streamProvider: StreamFrameProvider | null = null;

    const client = new WebSocketClient(
      url,
      (data: ArrayBuffer) => {
        const { msgType } = decodeHeader(data);
        const nodeId = getStreamingNodeId();
        if (msgType === MSG_SNAPSHOT) {
          const decoded = decodeSnapshot(data);
          baseSnapshotRef.current = decoded;
          setSnapshot(decoded);
          // Update per-node streaming data
          if (nodeId) {
            const store = pipelineApi.getState();
            const existing = store.nodeStreamingData[nodeId];
            store.setNodeStreamingData(nodeId, {
              snapshot: decoded,
              streamProvider: existing?.streamProvider ?? null,
            });
          }
        } else if (msgType === MSG_FRAME) {
          const decoded = decodeFrame(data);
          setFrame(decoded);
          setCurrentFrame(decoded.frameId);
          currentFrameRef.current = decoded.frameId;
          // Forward frame to stream provider for caching + playback store
          streamProvider?.receiveFrame(decoded);
        } else if (msgType === MSG_METADATA) {
          const decoded = decodeMetadata(data);
          setMeta(decoded);
          // Create or update stream provider with metadata
          if (!streamProvider) {
            streamProvider = new StreamFrameProvider(client, decoded);
            streamProviderRef.current = streamProvider;
            // Wire async frame delivery to the playback store
            streamProvider.setOnFrameReady((frame) => {
              playbackApi.getState()._onAsyncFrame(frame);
            });
          } else {
            streamProvider.meta = decoded;
          }
          // Update per-node streaming data with stream provider
          if (nodeId) {
            const store = pipelineApi.getState();
            const existing = store.nodeStreamingData[nodeId];
            store.setNodeStreamingData(nodeId, {
              snapshot: existing?.snapshot ?? baseSnapshotRef.current!,
              streamProvider,
            });
            // Update the streaming node's connected status
            store.updateNodeParams(nodeId, { connected: true });
          }
        }
      },
      (isConnected) => {
        setConnected(isConnected);
        // Update the streaming node's connected status
        const nodeId = getStreamingNodeId();
        if (nodeId) {
          pipelineApi.getState().updateNodeParams(nodeId, { connected: isConnected });
        }
      },
    );

    client.connect();
    clientRef.current = client;

    return () => {
      client.disconnect();
      if (streamProviderRef.current) {
        streamProviderRef.current.clear();
        streamProviderRef.current = null;
      }
      const nodeId = getStreamingNodeId();
      if (nodeId) {
        pipelineApi.getState().removeNodeStreamingData(nodeId);
        pipelineApi.getState().updateNodeParams(nodeId, { connected: false });
      }
    };
  }, [url, getStreamingNodeId, pipelineApi, playbackApi]);

  const setTrajectorySource = useCallback((source: TrajectorySource) => {
    setTrajectorySourceState(source);
  }, []);

  const hasFileFrames = meta != null && meta.nFrames > 0;

  return {
    snapshot,
    frame,
    meta,
    connected,
    currentFrame,
    setCurrentFrame,
    currentFrameRef,
    clientRef,
    trajectorySource,
    setTrajectorySource,
    hasStructureFrames: false,
    hasFileFrames,
  };
}
