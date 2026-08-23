/**
 * Local (in-memory) data source hook.
 * Parses structure files in the browser via WASM — no server communication needed.
 * Supports XTC trajectory loading as a separate step.
 * Delegates bond/label/vector source management to dedicated sub-hooks.
 */

import { useState, useRef, useCallback } from "react";
import {
  parseStructureFile,
  parseStructureText,
  indexStructureLazy,
  parseStructurePrefix,
  shouldUseLazyStructure,
} from "../parsers/structure";
import type {
  StructureParseResult,
  LazyStructureKind,
  StructureLazyHandle,
} from "../parsers/structure";
import {
  parseXTCFile,
  parseLammpstrjFile,
  parseDCDFile,
  parseNetCDFFile,
  indexTrajectoryLazy,
  decodeTrajectoryFrame0,
  decodeTrajectoryFrame,
  disposeTrajectoryLazy,
  shouldUseLazyTrajectory,
} from "../parsers/xtc";
import type { TrajectoryLazyHandle, LazyTrajectoryKind } from "../parsers/xtc";
import { remapTrajectoryTypesToElements } from "../parsers/parseCore";
import { LazyFrameProvider } from "../stream/LazyFrameProvider";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useBondSource } from "./useBondSource";
import { useLabelSource } from "./useLabelSource";
import { useVectorSource } from "./useVectorSource";
import { usePipelineStore } from "../pipeline/store";
import { createMinimalStructurePipeline } from "../pipeline/defaults";
import { syncAddBondSourceForLoader, applyTopologyFile } from "../pipeline/openFile";
import { getLayoutedElements } from "../pipeline/layout";
import type {
  Snapshot,
  Frame,
  TrajectoryMeta,
  BondSource,
  TrajectorySource,
  LabelSource,
  VectorSource,
} from "../types";

/** File extensions eligible for lazy multi-frame structure streaming → decoder kind. */
const LAZY_STRUCTURE_KIND: Record<string, LazyStructureKind> = {
  ".xyz": "xyz",
  ".pdb": "pdb",
};

export interface MeganeLocalState {
  snapshot: Snapshot | null;
  frame: Frame | null;
  meta: TrajectoryMeta | null;
  connected: boolean;
  currentFrame: number;
  currentFrameRef: React.MutableRefObject<number>;
  pdbFileName: string | null;
  xtcFileName: string | null;
  loadFile: (pdb: File, topFile?: File) => Promise<void>;
  applyStructureResult: (
    result: StructureParseResult,
    fileName: string,
    topFile?: File,
  ) => Promise<void>;
  loadText: (text: string, fileName?: string) => Promise<StructureParseResult>;
  loadXtc: (xtc: File) => Promise<void>;
  seekFrame: (frameIdx: number) => void;
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
  loadDemoVectors: () => void;
  vectorFileName: string | null;
  atomVectors: Float32Array | null;
}

export function useMeganeLocal(): MeganeLocalState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [meta, setMeta] = useState<TrajectoryMeta | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [pdbFileName, setPdbFileName] = useState<string | null>(null);
  const [xtcFileName, setXtcFileName] = useState<string | null>(null);
  const [trajectorySource, setTrajectorySourceState] = useState<TrajectorySource>("structure");
  const [hasStructureFrames, setHasStructureFrames] = useState(false);
  const [hasFileFrames, setHasFileFrames] = useState(false);

  const currentFrameRef = useRef(0);
  const structureFramesRef = useRef<Frame[]>([]);
  const fileFramesRef = useRef<Frame[]>([]);
  const baseSnapshotRef = useRef<Snapshot | null>(null);
  const xtcFileNameRef = useRef<string | null>(null);
  // Bumped on every load so a slow background index (Phase-2 streaming attach)
  // can detect it's stale and not clobber a newer file.
  const loadTokenRef = useRef(0);
  // Same idea for the trajectory path, kept separate so a trajectory load never
  // invalidates an in-flight structure phase-2 attach (or vice versa).
  const xtcLoadTokenRef = useRef(0);
  const fileTrajMetaRef = useRef<TrajectoryMeta | null>(null);
  const currentTrajSourceRef = useRef<TrajectorySource>("structure");

  // Sub-hooks for source management
  const bonds = useBondSource(baseSnapshotRef, setSnapshot);
  const labels = useLabelSource(baseSnapshotRef);
  const vectors = useVectorSource(
    baseSnapshotRef,
    currentFrameRef,
    structureFramesRef,
    fileTrajMetaRef,
  );

  const resetPlayback = useCallback(() => {
    setFrame(null);
    setCurrentFrame(0);
    currentFrameRef.current = 0;
  }, []);

  const updateMetaForTrajSource = useCallback((trajSource: TrajectorySource) => {
    const base = baseSnapshotRef.current;
    if (!base) return;

    if (trajSource === "file") {
      const fm = fileTrajMetaRef.current;
      if (fm && fileFramesRef.current.length > 0) {
        setMeta(fm);
      } else {
        setMeta(null);
      }
    } else {
      if (structureFramesRef.current.length > 0) {
        setMeta({
          nFrames: structureFramesRef.current.length + 1,
          timestepPs: 1.0,
          nAtoms: base.nAtoms,
        });
      } else {
        setMeta(null);
      }
    }
  }, []);

  const applyResult = useCallback(
    (
      result: {
        snapshot: Snapshot;
        frames: Frame[];
        meta: TrajectoryMeta | null;
        labels: string[] | null;
      },
      filename?: string,
      // Lazy multi-frame structure (large XYZ/PDB): frame 0 is the eager
      // snapshot, extra frames stream from this provider via the pipeline's
      // structure-trajectory channel. When set, the eager frame arrays stay
      // empty and `result.frames` is empty.
      lazy?: { provider: LazyFrameProvider },
    ) => {
      const prevSnapshot = baseSnapshotRef.current;
      baseSnapshotRef.current = result.snapshot;
      structureFramesRef.current = result.frames;
      fileFramesRef.current = [];
      fileTrajMetaRef.current = null;
      xtcFileNameRef.current = null;
      // Multi-frame when the file carries eager extra frames OR a lazy provider.
      const hasFrames = result.frames.length > 0 || !!lazy;

      // If the new structure itself carries multiple frames (multi-frame
      // XYZ, multi-MODEL PDB, etc.), feed them through the pipeline's
      // file-trajectory channel so the default LoadTrajectory →
      // Viewport edge picks them up — there is no LoadStructure edge to
      // viewport.traj in the standard graph.
      //
      // executeLoadTrajectory builds a MemoryFrameProvider WITHOUT
      // basePositions, so its index 0 must be a real frame. The XYZ
      // parser puts frame 0 into `snapshot.positions` and frames 1..N-1
      // into `result.frames`; prepend a synthetic frame 0 so the
      // provider-emitted indices match the file's frame numbering.
      //
      // Otherwise, only clear when we are replacing a prior structure
      // with incompatible atom count; never clear during the very first
      // load (no prior structure) to avoid racing against a follow-up
      // loadXtc() in the auto-load.
      const pipeStore = usePipelineStore.getState();
      if (lazy) {
        // Extra frames stream through the structure-trajectory channel. Clear
        // (and dispose) any prior file trajectory so only this provider is live;
        // the LoadTrajectory node below switches to its "structure" source.
        pipeStore.setFileFrames(null, null);
        pipeStore.setStructureProvider(lazy.provider);
      } else if (result.frames.length > 0) {
        const allFrames: Frame[] = [
          {
            frameId: 0,
            nAtoms: result.snapshot.nAtoms,
            positions: result.snapshot.positions,
          },
          ...result.frames,
        ];
        const trajectoryMeta: TrajectoryMeta = {
          nFrames: allFrames.length,
          timestepPs: 1.0,
          nAtoms: result.snapshot.nAtoms,
        };
        // Feed both channels: the default web/widget pipelines wire
        // through LoadTrajectory (consumes fileFrames); the empty
        // pipeline used by the VSCode custom editor wires LoadStructure
        // directly to Viewport.traj (consumes structureFrames).
        pipeStore.setFileFrames(allFrames, trajectoryMeta);
        pipeStore.setStructureFrames(result.frames, trajectoryMeta);
      } else if (prevSnapshot && prevSnapshot.nAtoms !== result.snapshot.nAtoms) {
        pipeStore.setFileFrames(null, null);
        pipeStore.setStructureFrames(null, null);
      }

      // Keep the pipeline's load_structure node in sync with whatever was
      // just loaded. Without this the editor would show stale demo
      // filenames (e.g. "caffeine_water.pdb") even though the viewer is
      // rendering the user's file.
      //
      // If the current graph has no load_structure node — e.g. a previous
      // .megane.json open replaced the pipeline with one that lacks one,
      // or an empty/broken graph is in the store — install a minimal
      // pipeline first so the parsed file actually reaches the viewer.
      // Without this, the WASM parse succeeds but the snapshot is dropped
      // and the viewport stays empty (the symptom users see as "the next
      // file I open is broken").
      if (filename) {
        let loaderNode = pipeStore.nodes.find((n) => n.type === "load_structure");
        if (!loaderNode) {
          const raw = createMinimalStructurePipeline();
          const { nodes, edges } = getLayoutedElements(raw.nodes, raw.edges);
          usePipelineStore.setState({ nodes, edges });
          loaderNode = usePipelineStore.getState().nodes.find((n) => n.type === "load_structure");
        }
        if (loaderNode) {
          pipeStore.setNodeSnapshot(loaderNode.id, {
            snapshot: result.snapshot,
            frames: result.frames.length > 0 ? result.frames : null,
            meta: result.meta,
            labels: result.labels,
          });
          pipeStore.updateNodeParams(loaderNode.id, {
            fileName: filename,
            hasTrajectory: hasFrames,
            hasCell: !!result.snapshot.box,
          });
          // Mirror the openFile path: pick AddBond's Source by file format
          // ("structure" for PDB/MOL/SDF/LAMMPS, "distance" / VDW otherwise)
          // so VSCode and JupyterLab single-file viewers — which feed files
          // through this hook instead of usePipelineStore.openFile — also
          // start with a sensible default for formats that lack bond info.
          syncAddBondSourceForLoader(usePipelineStore.getState(), loaderNode.id, filename);
        }
        const trajNode = pipeStore.nodes.find((n) => n.type === "load_trajectory");
        if (trajNode) {
          if (hasFrames) {
            // Multi-frame structure files (.traj, multi-MODEL PDB,
            // multi-frame XYZ) carry their trajectory in the structure file
            // itself. Flip the node to its visible "structure" source rather
            // than silently removing it from the graph.
            pipeStore.updateNodeParams(trajNode.id, { source: "structure", fileName: "" });
          } else {
            // Clear any previously-loaded XTC name so it doesn't linger
            // across structure swaps, and reset to the file source.
            pipeStore.updateNodeParams(trajNode.id, { source: "file", fileName: "" });
          }
        }
      }

      // Reset sub-hook state
      bonds.reset(result.snapshot);
      labels.reset(result.labels);
      vectors.reset();

      setHasStructureFrames(hasFrames);
      setHasFileFrames(false);

      const initialTrajSource = hasFrames ? "structure" : "file";
      currentTrajSourceRef.current = initialTrajSource;
      setTrajectorySourceState(initialTrajSource);

      setSnapshot(result.snapshot);
      // Lazy provider knows the true frame count (extra + 1); the eager frame-0
      // result has no meta of its own.
      setMeta(lazy ? lazy.provider.meta : result.meta);
      resetPlayback();
    },
    [resetPlayback, bonds.reset, labels.reset, vectors.reset],
  );

  // Apply an ALREADY-parsed structure result without re-reading or re-parsing
  // the file. This is the shared body of loadFile, exposed so callers that have
  // already parsed the file (e.g. the pipeline load_structure node handler) can
  // reuse the result instead of paying a second file read + WASM parse.
  const applyStructureResult = useCallback(
    async (result: StructureParseResult, fileName: string, topFile?: File) => {
      applyResult(result, fileName);
      setPdbFileName(fileName);
      setXtcFileName(result.meta ? "PDB models" : null);

      // applyResult calls syncAddBondSourceForLoader (sets "distance" for GRO).
      // If the host pre-loaded a sibling .top, overwrite with topology bonds.
      if (topFile) {
        const store = usePipelineStore.getState();
        const loaderNode = store.nodes.find((n) => n.type === "load_structure");
        if (loaderNode) {
          await applyTopologyFile(store, loaderNode.id, topFile);
        }
      }
    },
    [applyResult],
  );

  // Build the streaming provider from frame 0 and attach it to the pipeline,
  // upgrading a statically-rendered frame 0 into a scrubbable trajectory. Called
  // in the background (Phase 2) so it never blocks first paint. Guarded by a load
  // token so a slow index for an old file cannot clobber a newer load.
  const attachStreamingProvider = useCallback(
    (handle: StructureLazyHandle, frame0: StructureParseResult, token: number) => {
      const meta: TrajectoryMeta = {
        nFrames: handle.index.nFrames + 1, // + synthetic frame 0 (the eager snapshot)
        timestepPs: 1.0,
        nAtoms: frame0.snapshot.nAtoms,
      };
      const provider = new LazyFrameProvider(handle, meta, {
        decode: decodeTrajectoryFrame,
        dispose: disposeTrajectoryLazy,
        basePositions: frame0.snapshot.positions,
      });
      if (loadTokenRef.current !== token) {
        provider.dispose(); // a newer file superseded this load
        return;
      }
      provider.setOnFrameReady((f) => usePlaybackStore.getState()._onAsyncFrame(f));
      const store = usePipelineStore.getState();
      store.setStructureProvider(provider);
      const loaderNode = store.nodes.find((n) => n.type === "load_structure");
      if (loaderNode) store.updateNodeParams(loaderNode.id, { hasTrajectory: true });
      const trajNode = store.nodes.find((n) => n.type === "load_trajectory");
      if (trajNode) {
        store.updateNodeParams(trajNode.id, { source: "structure", fileName: "" });
      }
      setHasStructureFrames(true);
      setMeta(meta);
      currentTrajSourceRef.current = "structure";
      setTrajectorySourceState("structure");
      setXtcFileName("PDB models");
    },
    [],
  );

  // Lazy path for large multi-frame structure files (XYZ / PDB) — the target is
  // big-atom-count, many-frame files (multi-MODEL PDB / multi-frame XYZ) whose
  // eager whole-file decode dominates the wait.
  //
  // Phase 1 (critical): parse ONLY frame 0 from a bounded PREFIX of the file and
  //   render it — first paint is O(one frame), independent of total file size.
  // Phase 2 (background): read the full file, build the extra-frame index, and
  //   attach the streaming provider so the rest becomes scrubbable shortly after.
  //
  // Falls back to a single full read (which also renders frame 0 before decoding
  // the rest) when the prefix can't hold frame 0; returns false only when even
  // that is unavailable (→ caller's eager parse).
  const loadStructureLazy = useCallback(
    async (file: File, kind: LazyStructureKind, topFile?: File): Promise<boolean> => {
      const myToken = ++loadTokenRef.current;

      const applyTop = async () => {
        if (!topFile) return;
        const store = usePipelineStore.getState();
        const loaderNode = store.nodes.find((n) => n.type === "load_structure");
        if (loaderNode) await applyTopologyFile(store, loaderNode.id, topFile);
      };

      // ── Phase 1: instant frame 0 from a bounded prefix ──
      const prefixFrame0 = await parseStructurePrefix(file, kind);
      if (prefixFrame0) {
        applyResult(
          {
            snapshot: prefixFrame0.snapshot,
            frames: [],
            meta: null,
            labels: prefixFrame0.labels,
          },
          file.name,
        );
        setPdbFileName(file.name);
        setXtcFileName(null);
        await applyTop();
        // ── Phase 2 (background): full index → upgrade to streaming ──
        void indexStructureLazy(file, kind)
          .then(async (indexed) => {
            if (!indexed) return; // frame 0 already shown; no streaming available
            // Heterogeneous files can't ride the positions-only lazy path — the
            // per-frame atom count / cell would be lost. Discard the lazy handle
            // and reparse eagerly so the full HeteroFrames side table is built.
            if (indexed.handle.index.heterogeneous) {
              disposeTrajectoryLazy(indexed.handle.trajectoryId);
              if (myToken !== loadTokenRef.current) return;
              const result = await parseStructureFile(file);
              if (myToken !== loadTokenRef.current) return;
              await applyStructureResult(result, file.name, topFile);
              return;
            }
            if (indexed.handle.index.nFrames <= 0) {
              disposeTrajectoryLazy(indexed.handle.trajectoryId); // single frame — nothing to stream
              return;
            }
            attachStreamingProvider(indexed.handle, prefixFrame0, myToken);
          })
          .catch(() => {});
        return true;
      }

      // ── Fallback: single full read (frame 0 still renders before full decode) ──
      const indexed = await indexStructureLazy(file, kind);
      if (!indexed) return false;
      const { handle, frame0 } = indexed;
      // Heterogeneous → reparse eagerly (see Phase 2 note above).
      if (handle.index.heterogeneous) {
        disposeTrajectoryLazy(handle.trajectoryId);
        return false; // caller's eager parse path handles it
      }
      if (handle.index.nFrames <= 0) {
        disposeTrajectoryLazy(handle.trajectoryId);
        applyResult(
          { snapshot: frame0.snapshot, frames: [], meta: null, labels: frame0.labels },
          file.name,
        );
        setPdbFileName(file.name);
        setXtcFileName(null);
      } else {
        applyResult(
          { snapshot: frame0.snapshot, frames: [], meta: null, labels: frame0.labels },
          file.name,
        );
        setPdbFileName(file.name);
        attachStreamingProvider(handle, frame0, myToken);
      }
      await applyTop();
      return true;
    },
    [applyResult, attachStreamingProvider, applyStructureResult],
  );

  const loadFile = useCallback(
    async (pdb: File, topFile?: File) => {
      const ext = pdb.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
      const lazyKind = LAZY_STRUCTURE_KIND[ext];
      if (lazyKind && shouldUseLazyStructure(lazyKind, pdb.size)) {
        if (await loadStructureLazy(pdb, lazyKind, topFile)) return;
      }
      const result = await parseStructureFile(pdb);
      await applyStructureResult(result, pdb.name, topFile);
    },
    [applyStructureResult, loadStructureLazy],
  );

  const loadText = useCallback(
    async (text: string, fileName?: string) => {
      const result = await parseStructureText(text, fileName);
      const effectiveName = fileName ?? "caffeine_water.pdb";
      applyResult(result, effectiveName);
      setPdbFileName(effectiveName);
      setXtcFileName(result.meta ? "PDB models" : null);
      return result;
    },
    [applyResult],
  );

  // Build the streaming provider from a fully-scanned trajectory index and swap
  // it into the pipeline's file-trajectory channel, promoting a statically-shown
  // frame 0 into a scrubbable trajectory. `seedFrame0` (the phase-1 partial-read
  // positions) primes the provider's frame-0 cache so the swap doesn't flicker.
  const attachFileProvider = useCallback(
    (handle: TrajectoryLazyHandle, fileName: string, nAtoms: number, seedFrame0?: Float32Array) => {
      const meta: TrajectoryMeta = {
        nFrames: handle.index.nFrames,
        timestepPs: handle.index.timestepPs,
        nAtoms: handle.index.nAtoms,
      };
      const provider = new LazyFrameProvider(handle, meta, {
        decode: decodeTrajectoryFrame,
        dispose: disposeTrajectoryLazy,
        seedFrame0,
      });
      provider.setOnFrameReady((f) => usePlaybackStore.getState()._onAsyncFrame(f));

      // Stream embedded vector channels (LAMMPS velocity/force) as frames
      // decode, OFFERING them to the load_vector node UI (the first channel,
      // matching the eager path). The overlay renders only once the user
      // activates the channel there; updates are batched so we don't re-run
      // the pipeline per frame.
      const channelNames = handle.index.vectorChannelNames;
      if (channelNames.length > 0) {
        const stride = nAtoms * 3;
        const accumulated = new Map<number, Float32Array>();
        let flushScheduled = false;
        const flush = () => {
          flushScheduled = false;
          // Only apply while this provider is still the active trajectory.
          if (usePipelineStore.getState().fileProvider !== provider) return;
          const frames = [...accumulated.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([frame, vectors]) => ({ frame, vectors }));
          usePipelineStore
            .getState()
            .setEmbeddedVectorChannels([{ name: channelNames[0], frames }]);
        };
        provider.setOnVectors((frameId, vectors) => {
          accumulated.set(frameId, vectors.slice(0, stride));
          if (!flushScheduled) {
            flushScheduled = true;
            setTimeout(flush, 200);
          }
        });
      }

      // useMeganeLocal's own frame array stays empty — positions render
      // through the pipeline provider + playback store, not fileFramesRef.
      fileFramesRef.current = [];
      fileTrajMetaRef.current = meta;
      xtcFileNameRef.current = fileName;
      setHasFileFrames(true);
      currentTrajSourceRef.current = "file";
      setTrajectorySourceState("file");
      setMeta(meta);
      resetPlayback();
      setXtcFileName(fileName);

      const store = usePipelineStore.getState();
      store.setFileProvider(provider);
      const trajNode = store.nodes.find((n) => n.type === "load_trajectory");
      if (trajNode) {
        store.updateNodeParams(trajNode.id, { fileName });
      }
    },
    [resetPlayback],
  );

  const loadXtc = useCallback(
    async (xtc: File) => {
      if (!baseSnapshotRef.current) {
        throw new Error("Load a structure before loading a trajectory");
      }
      const ext = xtc.name.toLowerCase();
      const isLammpstrj =
        ext.endsWith(".lammpstrj") || ext.endsWith(".dump") || ext.endsWith(".trj");
      const isDcd = ext.endsWith(".dcd");
      const isNetcdf = ext.endsWith(".nc");
      const isXtc = !isLammpstrj && !isDcd && !isNetcdf;
      const nAtoms = baseSnapshotRef.current.nAtoms;
      const store = usePipelineStore.getState();

      // Eager whole-file parse + apply. Used for small files, when the worker is
      // unavailable, and as the fallback for a heterogeneous (variable-atom)
      // LAMMPS dump — whose jagged frames the positions-only lazy decoder can't
      // stream, so the full TrajHetero side table must be built eagerly.
      const eagerLoad = async () => {
        const parseFn = isLammpstrj
          ? parseLammpstrjFile
          : isDcd
            ? parseDCDFile
            : isNetcdf
              ? parseNetCDFFile
              : parseXTCFile;
        const { frames: parsedFrames, meta: xtcMeta, vectorChannels } = await parseFn(xtc, nAtoms);
        // A variable-atom LAMMPS dump emits raw integer type ids as each frame's
        // elements; map them to real atomic numbers via the loaded structure.
        // The remap returns new frames — the parser output itself stays as-read.
        const frames =
          xtcMeta?.variesTopology && baseSnapshotRef.current
            ? remapTrajectoryTypesToElements(parsedFrames, baseSnapshotRef.current.elements)
            : parsedFrames;
        fileFramesRef.current = frames;
        fileTrajMetaRef.current = xtcMeta;
        xtcFileNameRef.current = xtc.name;
        setHasFileFrames(true);

        currentTrajSourceRef.current = "file";
        setTrajectorySourceState("file");
        setMeta(xtcMeta);
        resetPlayback();
        setXtcFileName(xtc.name);

        // Feed parsed frames into the pipeline store so executeLoadTrajectory produces output.
        store.setFileFrames(frames, xtcMeta ?? null);

        // Sync the load_trajectory node's displayed fileName so the pipeline
        // editor reflects the actually-loaded XTC/dump.
        const trajNode = store.nodes.find((n) => n.type === "load_trajectory");
        if (trajNode) {
          store.updateNodeParams(trajNode.id, { fileName: xtc.name });
        }

        // Offer embedded vector channels (e.g. LAMMPS dump vx/vy/vz) to the
        // load_vector node UI; the user activates one there. A parse must not
        // switch a visual overlay on as a side effect.
        store.setEmbeddedVectorChannels(
          vectorChannels.length > 0
            ? vectorChannels.map((ch) => ({ name: ch.name, frames: ch.frames }))
            : null,
        );
      };

      // Lazy/streaming path (large XTC or LAMMPS dump, worker-gated). Two phases,
      // like the structure path, so first paint is O(one frame) not O(file size):
      //   Phase 1 (critical): decode ONLY frame 0 from a bounded prefix and show
      //     it — time-to-interactive is independent of total file size.
      //   Phase 2 (background): scan the full frame index and swap in the
      //     streaming provider (scrubbable, embedded vectors), seeding frame 0.
      // Small files stay eager (smoother playback, no per-frame worker cost); a
      // null result also falls back to a full read.
      const lazyKind: LazyTrajectoryKind | null = isLammpstrj ? "lammpstrj" : isXtc ? "xtc" : null;
      if (lazyKind && shouldUseLazyTrajectory(lazyKind, xtc.size)) {
        const myToken = ++xtcLoadTokenRef.current;

        // ── Phase 1: instant frame 0 from a bounded prefix ──
        const frame0Positions = await decodeTrajectoryFrame0(xtc, lazyKind, nAtoms);
        if (frame0Positions) {
          const frame0: Frame = { frameId: 0, nAtoms, positions: frame0Positions };
          const provisionalMeta: TrajectoryMeta = { nFrames: 1, timestepPs: 1.0, nAtoms };
          fileFramesRef.current = [];
          fileTrajMetaRef.current = provisionalMeta;
          xtcFileNameRef.current = xtc.name;
          setHasFileFrames(true);
          currentTrajSourceRef.current = "file";
          setTrajectorySourceState("file");
          setMeta(provisionalMeta);
          resetPlayback();
          setXtcFileName(xtc.name);
          // A single-frame MemoryFrameProvider shows frame 0 while the index scans.
          store.setFileFrames([frame0], provisionalMeta);
          const trajNode = store.nodes.find((n) => n.type === "load_trajectory");
          if (trajNode) store.updateNodeParams(trajNode.id, { fileName: xtc.name });

          // ── Phase 2 (background): full index → swap to streaming provider ──
          void indexTrajectoryLazy(xtc, lazyKind, nAtoms)
            .then(async (handle) => {
              if (!handle) return; // frame 0 already shown; no streaming available
              if (xtcLoadTokenRef.current !== myToken) {
                disposeTrajectoryLazy(handle.trajectoryId); // a newer load superseded this
                return;
              }
              // Variable-atom dump: the lazy decoder can't stream jagged frames,
              // so drop it and reparse eagerly (builds the full side table).
              if (handle.index.heterogeneous) {
                disposeTrajectoryLazy(handle.trajectoryId);
                if (xtcLoadTokenRef.current === myToken) await eagerLoad();
                return;
              }
              attachFileProvider(handle, xtc.name, nAtoms, frame0Positions);
            })
            .catch(() => {});
          return;
        }

        // ── Fallback: single full read (frame 0 still renders via the provider) ──
        const handle = await indexTrajectoryLazy(xtc, lazyKind, nAtoms);
        if (handle && !handle.index.heterogeneous) {
          attachFileProvider(handle, xtc.name, nAtoms);
          return;
        }
        if (handle) disposeTrajectoryLazy(handle.trajectoryId); // heterogeneous → eager below
      }

      await eagerLoad();
    },
    [resetPlayback, attachFileProvider],
  );

  const seekFrame = useCallback(
    (frameIdx: number) => {
      const frames =
        currentTrajSourceRef.current === "file"
          ? fileFramesRef.current
          : structureFramesRef.current;

      if (frameIdx === 0) {
        if (baseSnapshotRef.current) {
          setFrame({
            frameId: 0,
            nAtoms: baseSnapshotRef.current.nAtoms,
            positions: baseSnapshotRef.current.positions,
          });
        }
      } else {
        const f = frames[frameIdx - 1];
        if (f) setFrame(f);
      }
      setCurrentFrame(frameIdx);
      currentFrameRef.current = frameIdx;

      // Update vectors for this frame
      vectors.updateForFrame(frameIdx);
    },
    [vectors.updateForFrame],
  );

  const setTrajectorySource = useCallback(
    (source: TrajectorySource) => {
      currentTrajSourceRef.current = source;
      setTrajectorySourceState(source);
      updateMetaForTrajSource(source);
      resetPlayback();

      if (source === "file") {
        setXtcFileName(xtcFileNameRef.current);
      } else {
        setXtcFileName(structureFramesRef.current.length > 0 ? "PDB models" : null);
      }
    },
    [updateMetaForTrajSource, resetPlayback],
  );

  return {
    snapshot,
    frame,
    meta,
    connected: true,
    currentFrame,
    currentFrameRef,
    pdbFileName,
    xtcFileName,
    loadFile,
    applyStructureResult,
    loadText,
    loadXtc,
    seekFrame,
    bondSource: bonds.bondSource,
    setBondSource: bonds.setBondSource,
    trajectorySource,
    setTrajectorySource,
    loadBondFile: bonds.loadBondFile,
    bondFileName: bonds.bondFileName,
    hasStructureBonds: bonds.hasStructureBonds,
    hasStructureFrames,
    hasFileFrames,
    labelSource: labels.labelSource,
    setLabelSource: labels.setLabelSource,
    loadLabelFile: labels.loadLabelFile,
    labelFileName: labels.labelFileName,
    hasStructureLabels: labels.hasStructureLabels,
    atomLabels: labels.atomLabels,
    vectorSource: vectors.vectorSource,
    setVectorSource: vectors.setVectorSource,
    loadVectorFile: vectors.loadVectorFile,
    loadDemoVectors: vectors.loadDemoVectors,
    vectorFileName: vectors.vectorFileName,
    atomVectors: vectors.atomVectors,
  };
}
