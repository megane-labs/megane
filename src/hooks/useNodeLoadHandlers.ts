/**
 * Custom hook that wires up node-level file load event handlers.
 * Manages structure, trajectory, and vector load handler registration/teardown.
 * Returns a ref to the primary load_structure node ID for downstream use.
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import {
  useScopedPipelineStore,
  usePipelineStoreApi,
  useLoadHandlers,
} from "../stores/MeganeProvider";
import { loadVectorFileData } from "../logic/vectorSourceLogic";
import { parseStructureFile, shouldUseLazyStructure } from "../parsers/structure";
import { pdbMayHaveModels } from "../parsers/pdbModels";
import type { StructureParseResult, FileStructureKind } from "../parsers/structure";
import { applyStructureToPipeline, beginStructureLoad } from "../pipeline/openFile";
import type { Snapshot } from "../types";
import type {
  StructureLoadHandler,
  TrajectoryLoadHandler,
  VectorLoadHandler,
} from "../stores/loadHandlers";

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
  const setNodeParseError = useScopedPipelineStore((s) => s.setNodeParseError);
  const clearNodeParseError = useScopedPipelineStore((s) => s.clearNodeParseError);
  const setFileVectors = useScopedPipelineStore((s) => s.setFileVectors);
  const pipelineNodes = useScopedPipelineStore((s) => s.nodes);

  const pipelineApi = usePipelineStoreApi();
  const loadHandlers = useLoadHandlers();

  const primaryNodeIdRef = useRef<string | null>(null);

  // Track the primary load_structure node (first one, for backward compat)
  useEffect(() => {
    const primary = pipelineNodes.find((n) => n.type === "load_structure");
    primaryNodeIdRef.current = primary?.id ?? null;
  }, [pipelineNodes]);

  // Wire up structure load handler
  useEffect(() => {
    const handler: StructureLoadHandler = (nodeId, file) => {
      const isPrimary = nodeId === primaryNodeIdRef.current;
      // Parses finish out of order (a small file picked right after a big one
      // can be done first); only the newest load into this node may land.
      const isLatest = beginStructureLoad(pipelineApi, nodeId);

      // Large multi-frame structure files (XYZ / multi-MODEL PDB / ASE .traj), primary node
      // only: stream via the lazy path. Delegate to the legacy loader
      // (loadFile → loadStructureLazy), which indexes the extra frames, parses
      // frame 0, sets THIS node's snapshot, and installs the structureProvider —
      // skipping the eager full-file parse here. If lazy is declined (single
      // frame / no worker) loadFile falls back to an eager parse, which also
      // populates the node snapshot. Non-primary nodes and other formats keep the
      // eager path below.
      const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
      const lazyKind: FileStructureKind | null =
        ext === ".xyz" || ext === ".extxyz"
          ? "xyz"
          : ext === ".pdb"
            ? "pdb"
            : ext === ".traj"
              ? "traj"
              : null;
      if (isPrimary && lazyKind && shouldUseLazyStructure(lazyKind, file.size)) {
        const streamIt = () => {
          clearNodeParseError(nodeId);
          onUploadStructure(file);
        };
        if (lazyKind === "pdb") {
          // A PDB without MODEL records is a single frame: there is nothing to
          // stream, and without an ENDMDL the lazy path cannot prove frame 0
          // complete, so it would parse the file up to three times. Parse it
          // once, here. (An unreadable head falls to the eager path, which
          // reports the read error on the node.)
          pdbMayHaveModels(file).then(
            (multiModel) => (multiModel ? streamIt() : parseEagerly()),
            parseEagerly,
          );
          return;
        }
        streamIt();
        return;
      }
      parseEagerly();

      function parseEagerly() {
        parseStructureFile(file)
          .then((result) => {
            if (!isLatest()) return;
            clearNodeParseError(nodeId);
            // The same helper every structure-open path uses: node snapshot,
            // AddBond source, embedded vector channels and — for the primary
            // node — the global structure/trajectory state.
            applyStructureToPipeline(pipelineApi, nodeId, result, file.name);
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
            if (!isLatest()) return;
            const message = err instanceof Error ? err.message : String(err);
            setNodeParseError(nodeId, `Failed to parse file: ${message}`);
          });
      }
    };
    loadHandlers.setStructure(handler);
    return () => {
      // Only release the slot if it is still ours — StrictMode's double-effect
      // otherwise has the first cleanup clear the second registration.
      if (loadHandlers.structure === handler) loadHandlers.setStructure(null);
    };
  }, [
    onUploadStructure,
    setNodeParseError,
    clearNodeParseError,
    setFileVectors,
    pipelineApi,
    loadHandlers,
  ]);

  // Wire up trajectory load handler
  useEffect(() => {
    if (!onUploadTrajectory) return;
    const handler: TrajectoryLoadHandler = (file) => onUploadTrajectory(file);
    loadHandlers.setTrajectory(handler);
    return () => {
      if (loadHandlers.trajectory === handler) loadHandlers.setTrajectory(null);
    };
  }, [onUploadTrajectory, loadHandlers]);

  // Wire up vector load handler
  useEffect(() => {
    const handler: VectorLoadHandler = (file) => {
      const nAtoms = snapshot?.nAtoms ?? 0;
      if (nAtoms === 0) return;
      loadVectorFileData(file, nAtoms)
        .then(({ vectors }) => {
          setFileVectors(vectors);
        })
        .catch((err: unknown) => {
          console.error("Failed to load vector file:", err);
        });
    };
    loadHandlers.setVector(handler);
    return () => {
      if (loadHandlers.vector === handler) loadHandlers.setVector(null);
    };
  }, [snapshot, setFileVectors, loadHandlers]);

  return primaryNodeIdRef;
}
