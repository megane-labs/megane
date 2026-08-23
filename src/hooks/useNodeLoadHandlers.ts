/**
 * Custom hook that wires up node-level file load event handlers.
 * Manages structure, trajectory, and vector load handler registration/teardown.
 * Returns a ref to the primary load_structure node ID for downstream use.
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import { usePipelineStore } from "../pipeline/store";
import { setStructureLoadHandler } from "../components/nodes/LoadStructureNode";
import { setTrajectoryLoadHandler } from "../components/nodes/LoadTrajectoryNode";
import { setVectorLoadHandler } from "../components/nodes/LoadVectorNode";
import { loadVectorFileData } from "../logic/vectorSourceLogic";
import { parseStructureFile, shouldUseLazyStructure } from "../parsers/structure";
import type { StructureParseResult, LazyStructureKind } from "../parsers/structure";
import type { NodeSnapshotData } from "../pipeline/execute";
import type { Snapshot } from "../types";

interface UseNodeLoadHandlersOptions {
  snapshot: Snapshot | null;
  onUploadStructure: (file: File, preParsed?: StructureParseResult) => void;
  onUploadTrajectory?: (file: File) => void;
}

/**
 * Registers node load event handlers for structure, trajectory, and vector nodes.
 * Returns a ref containing the ID of the primary load_structure node.
 */
export function useNodeLoadHandlers({
  snapshot,
  onUploadStructure,
  onUploadTrajectory,
}: UseNodeLoadHandlersOptions): MutableRefObject<string | null> {
  const setNodeSnapshot = usePipelineStore((s) => s.setNodeSnapshot);
  const updateNodeParams = usePipelineStore((s) => s.updateNodeParams);
  const setNodeParseError = usePipelineStore((s) => s.setNodeParseError);
  const clearNodeParseError = usePipelineStore((s) => s.clearNodeParseError);
  const setFileVectors = usePipelineStore((s) => s.setFileVectors);
  const pipelineNodes = usePipelineStore((s) => s.nodes);

  const primaryNodeIdRef = useRef<string | null>(null);

  // Track the primary load_structure node (first one, for backward compat)
  useEffect(() => {
    const primary = pipelineNodes.find((n) => n.type === "load_structure");
    primaryNodeIdRef.current = primary?.id ?? null;
  }, [pipelineNodes]);

  // Wire up structure load handler
  useEffect(() => {
    setStructureLoadHandler((nodeId, file) => {
      const isPrimary = nodeId === primaryNodeIdRef.current;

      // Large multi-frame structure files (XYZ / multi-MODEL PDB), primary node
      // only: stream via the lazy path. Delegate to the legacy loader
      // (loadFile → loadStructureLazy), which indexes the extra frames, parses
      // frame 0, sets THIS node's snapshot, and installs the structureProvider —
      // skipping the eager full-file parse here. If lazy is declined (single
      // frame / no worker) loadFile falls back to an eager parse, which also
      // populates the node snapshot. Non-primary nodes and other formats keep the
      // eager path below.
      const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
      const lazyKind: LazyStructureKind | null =
        ext === ".xyz" ? "xyz" : ext === ".pdb" ? "pdb" : null;
      if (isPrimary && lazyKind && shouldUseLazyStructure(lazyKind, file.size)) {
        clearNodeParseError(nodeId);
        onUploadStructure(file);
        return;
      }

      parseStructureFile(file)
        .then((result) => {
          clearNodeParseError(nodeId);
          const data: NodeSnapshotData = {
            snapshot: result.snapshot,
            frames: result.frames.length > 0 ? result.frames : null,
            meta: result.meta,
            labels: result.labels,
          };
          setNodeSnapshot(nodeId, data);
          updateNodeParams(nodeId, {
            hasTrajectory: result.frames.length > 0,
            hasCell: !!result.snapshot.box,
          });
          // Offer embedded vector channels (e.g. GRO velocities) to the
          // load_vector node UI. Nothing is rendered until the user activates
          // one — a parse must not switch a visual overlay on as a side effect.
          usePipelineStore
            .getState()
            .setEmbeddedVectorChannels(
              result.vectorChannels.length > 0
                ? result.vectorChannels.map((ch) => ({ name: ch.name, frames: ch.frames }))
                : null,
            );
          // For the primary node, also drive the legacy load path for
          // trajectory/label/bond source management. Pass the ALREADY-parsed
          // result so it reuses this parse instead of reading + WASM-parsing the
          // same file a second time (previously ~2x wall-clock per open). Doing
          // it inside .then also removes the prior race between this parse and
          // the legacy path's concurrent parse.
          if (isPrimary) {
            onUploadStructure(file, result);
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setNodeParseError(nodeId, `Failed to parse file: ${message}`);
        });
    });
    return () => {
      setStructureLoadHandler(null);
    };
  }, [
    onUploadStructure,
    setNodeSnapshot,
    updateNodeParams,
    setNodeParseError,
    clearNodeParseError,
    setFileVectors,
  ]);

  // Wire up trajectory load handler
  useEffect(() => {
    if (onUploadTrajectory) {
      setTrajectoryLoadHandler((file) => onUploadTrajectory(file));
    }
    return () => {
      setTrajectoryLoadHandler(null);
    };
  }, [onUploadTrajectory]);

  // Wire up vector load handler
  useEffect(() => {
    setVectorLoadHandler((file) => {
      const nAtoms = snapshot?.nAtoms ?? 0;
      if (nAtoms === 0) return;
      loadVectorFileData(file, nAtoms)
        .then(({ vectors }) => {
          setFileVectors(vectors);
        })
        .catch((err: unknown) => {
          console.error("Failed to load vector file:", err);
        });
    });
    return () => {
      setVectorLoadHandler(null);
    };
  }, [snapshot, setFileVectors]);

  return primaryNodeIdRef;
}
