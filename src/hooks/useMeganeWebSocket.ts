/**
 * Custom hook for WebSocket connection to the megane backend.
 * Handles connection lifecycle, message routing, and frame tracking.
 * Supports client-side bond source switching (structure/file/distance/none)
 * and trajectory source switching (structure/file).
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
import { withBonds, computeBondsForSource, loadBondFileData } from "../logic/bondSourceLogic";
import { computeLabelsForSource, loadLabelFileData } from "../logic/labelSourceLogic";
import { getVectorsForFrame, loadVectorFileData } from "../logic/vectorSourceLogic";
import type {
  Snapshot,
  Frame,
  TrajectoryMeta,
  BondSource,
  TrajectorySource,
  LabelSource,
  VectorSource,
  VectorFrame,
} from "../types";

export interface MeganeWebSocketState {
  snapshot: Snapshot | null;
  frame: Frame | null;
  meta: TrajectoryMeta | null;
  connected: boolean;
  currentFrame: number;
  setCurrentFrame: (frame: number) => void;
  currentFrameRef: React.MutableRefObject<number>;
  clientRef: React.MutableRefObject<WebSocketClient | null>;
  bondSource: BondSource;
  setBondSource: (source: BondSource) => void;
  trajectorySource: TrajectorySource;
  setTrajectorySource: (source: TrajectorySource) => void;
  loadBondFile: (file: File) => Promise<void>;
  bondFileName: string | null;
  hasStructureBonds: boolean;
  hasStructureFrames: boolean;
  hasFileFrames: boolean;
  labelSource: LabelSource;
  setLabelSource: (source: LabelSource) => void;
  loadLabelFile: (file: File) => Promise<void>;
  labelFileName: string | null;
  hasStructureLabels: boolean;
  atomLabels: string[] | null;
  vectorSource: VectorSource;
  setVectorSource: (source: VectorSource) => void;
  loadVectorFile: (file: File) => Promise<void>;
  vectorFileName: string | null;
  atomVectors: Float32Array | null;
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
  const [bondSource, setBondSourceState] = useState<BondSource>("structure");
  const [trajectorySource, setTrajectorySourceState] = useState<TrajectorySource>("file");
  const [bondFileName, setBondFileName] = useState<string | null>(null);
  const [hasStructureBonds, setHasStructureBonds] = useState(false);
  const [labelSource, setLabelSourceState] = useState<LabelSource>("none");
  const [labelFileName, setLabelFileName] = useState<string | null>(null);
  const [atomLabels, setAtomLabels] = useState<string[] | null>(null);
  const [vectorSource, setVectorSourceState] = useState<VectorSource>("none");
  const [vectorFileName, setVectorFileName] = useState<string | null>(null);
  const [atomVectors, setAtomVectors] = useState<Float32Array | null>(null);

  const clientRef = useRef<WebSocketClient | null>(null);
  const currentFrameRef = useRef(0);
  const baseSnapshotRef = useRef<Snapshot | null>(null);
  const fileBondsRef = useRef<Uint32Array | null>(null);
  const vdwBondsRef = useRef<Uint32Array | null>(null);
  const fileLabelsRef = useRef<string[] | null>(null);
  const fileVectorsRef = useRef<VectorFrame[] | null>(null);

  const applyBondSource = useCallback(async (source: BondSource, base: Snapshot) => {
    const result = await computeBondsForSource(source, {
      baseSnapshot: base,
      fileBonds: fileBondsRef.current,
      vdwBonds: vdwBondsRef.current,
    });
    if (source === "distance" && result) {
      vdwBondsRef.current = result.bonds;
    }
    if (result) setSnapshot(result);
  }, []);

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
          setHasStructureBonds(decoded.nFileBonds > 0);
          fileBondsRef.current = null;
          vdwBondsRef.current = null;
          setBondFileName(null);
          setBondSourceState("structure");
          fileLabelsRef.current = null;
          setLabelFileName(null);
          setLabelSourceState("none");
          setAtomLabels(null);
          fileVectorsRef.current = null;
          setVectorFileName(null);
          setVectorSourceState("none");
          setAtomVectors(null);
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

  const setBondSource = useCallback(
    async (source: BondSource) => {
      setBondSourceState(source);
      const base = baseSnapshotRef.current;
      if (base) {
        await applyBondSource(source, base);
      }
    },
    [applyBondSource],
  );

  const setTrajectorySource = useCallback((source: TrajectorySource) => {
    setTrajectorySourceState(source);
  }, []);

  const loadBondFile = useCallback(async (file: File) => {
    const base = baseSnapshotRef.current;
    if (!base) return;

    const { bonds, fileName } = await loadBondFileData(file, base.nAtoms);
    fileBondsRef.current = bonds;
    setBondFileName(fileName);
    setBondSourceState("file");
    setSnapshot(withBonds(base, bonds, null));
  }, []);

  const setLabelSource = useCallback((source: LabelSource) => {
    setLabelSourceState(source);
    const base = baseSnapshotRef.current;
    if (!base) {
      setAtomLabels(null);
      return;
    }
    const labels = computeLabelsForSource(
      source,
      {
        structureLabels: null, // streaming mode has no structure labels
        fileLabels: fileLabelsRef.current,
      },
      base.nAtoms,
    );
    setAtomLabels(labels);
  }, []);

  const loadLabelFile = useCallback(async (file: File) => {
    const base = baseSnapshotRef.current;
    if (!base) return;

    const { labels, fileName } = await loadLabelFileData(file, base.nAtoms);
    fileLabelsRef.current = labels;
    setLabelFileName(fileName);
    setLabelSourceState("file");
    setAtomLabels(labels);
  }, []);

  const setVectorSource = useCallback((source: VectorSource) => {
    setVectorSourceState(source);
    if (source === "none") {
      setAtomVectors(null);
    } else if (source === "file" && fileVectorsRef.current) {
      const vecs = getVectorsForFrame(
        { fileVectors: fileVectorsRef.current },
        currentFrameRef.current,
      );
      setAtomVectors(vecs);
    }
  }, []);

  const loadVectorFile = useCallback(async (file: File) => {
    const base = baseSnapshotRef.current;
    if (!base) return;

    const { vectors, fileName } = await loadVectorFileData(file, base.nAtoms);
    fileVectorsRef.current = vectors;
    setVectorFileName(fileName);
    setVectorSourceState("file");
    const vecs = getVectorsForFrame({ fileVectors: vectors }, currentFrameRef.current);
    setAtomVectors(vecs);
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
    bondSource,
    setBondSource,
    trajectorySource,
    setTrajectorySource,
    loadBondFile,
    bondFileName,
    hasStructureBonds,
    hasStructureFrames: false,
    hasFileFrames,
    labelSource,
    setLabelSource,
    loadLabelFile,
    labelFileName,
    hasStructureLabels: false,
    atomLabels,
    vectorSource,
    setVectorSource,
    loadVectorFile,
    vectorFileName,
    atomVectors,
  };
}
