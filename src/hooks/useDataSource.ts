/**
 * Unified data source hook.
 * Wraps streaming (WebSocket) and local (WASM) data sources behind a
 * common interface so that index.tsx doesn't need mode-switching boilerplate.
 */

import { useCallback } from "react";
import { useMeganeWebSocket } from "./useMeganeWebSocket";
import { useMeganeLocal, type MeganeLocalState } from "./useMeganeLocal";
import type { DataMode, Snapshot, Frame, TrajectoryMeta } from "../types";
import type { StructureParseResult } from "../parsers/structure";

export interface DataSource {
  snapshot: Snapshot | null;
  frame: Frame | null;
  meta: TrajectoryMeta | null;
  currentFrame: number;
  currentFrameRef: React.MutableRefObject<number>;

  seekFrame: (frameIdx: number) => void;
  uploadStructure: (file: File, preParsed?: StructureParseResult) => void;
  uploadTrajectory: (file: File) => void;

  /** Access to the full local state for demo loading etc. */
  local: MeganeLocalState;
}

async function uploadFiles(pdb: File): Promise<void> {
  const form = new FormData();
  form.append("pdb", pdb);
  await fetch("/api/upload", { method: "POST", body: form });
}

export function useDataSource(mode: DataMode): DataSource {
  const wsUrl =
    mode === "streaming"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`
      : null;
  const ws = useMeganeWebSocket(wsUrl);
  const local = useMeganeLocal();

  const snapshot = mode === "streaming" ? ws.snapshot : local.snapshot;
  const frame = mode === "streaming" ? ws.frame : local.frame;
  const meta = mode === "streaming" ? ws.meta : local.meta;
  const currentFrame = mode === "streaming" ? ws.currentFrame : local.currentFrame;
  const currentFrameRef = mode === "streaming" ? ws.currentFrameRef : local.currentFrameRef;

  const seekFrame = useCallback(
    (frameIdx: number) => {
      if (mode === "streaming") {
        ws.currentFrameRef.current = frameIdx;
        ws.clientRef.current?.send({ type: "request_frame", frame: frameIdx });
      } else {
        local.seekFrame(frameIdx);
      }
    },
    [mode, ws.currentFrameRef, ws.clientRef, local.seekFrame],
  );

  const uploadStructure = useCallback(
    (file: File, preParsed?: StructureParseResult) => {
      if (mode === "streaming") {
        uploadFiles(file);
      } else if (preParsed) {
        // The pipeline load_structure node already parsed this file; reuse its
        // result so we don't read + WASM-parse the same file a second time
        // (previously this doubled the wall-clock parse time on every open).
        void local.applyStructureResult(preParsed, file.name);
      } else {
        local.loadFile(file);
      }
    },
    [mode, local.loadFile, local.applyStructureResult],
  );

  const uploadTrajectory = useCallback(
    (file: File) => {
      if (mode === "local") {
        local.loadXtc(file);
      }
    },
    [mode, local.loadXtc],
  );

  return {
    snapshot,
    frame,
    meta,
    currentFrame,
    currentFrameRef,
    seekFrame,
    uploadStructure,
    uploadTrajectory,
    local,
  };
}
