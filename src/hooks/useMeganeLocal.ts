/**
 * Local (in-memory) data source hook.
 * Parses structure files in the browser via WASM — no server communication needed.
 * Supports XTC trajectory loading as a separate step.
 */

import { useState, useRef, useCallback } from "react";
import {
  parseStructureFile,
  parseStructureText,
  indexStructureLazy,
  parseStructureHead,
  parseStructurePrefix,
  shouldUseLazyStructure,
} from "../parsers/structure";
import type {
  StructureParseResult,
  FileStructureKind,
  StructureLazyHandle,
} from "../parsers/structure";
import {
  indexTrajectoryLazy,
  decodeTrajectoryFrame0,
  decodeTrajectoryFrame,
  disposeTrajectoryLazy,
  shouldUseLazyTrajectory,
} from "../parsers/xtc";
import type { TrajectoryLazyHandle, LazyTrajectoryKind } from "../parsers/xtc";
import { parseTrajectoryByName } from "../parsers/trajectoryDispatch";
import { trajectoryKindFromFileName } from "../parsers/fileNames";
import { LazyFrameProvider } from "../stream/LazyFrameProvider";
import type { ProgressiveFile } from "../hosts/progressiveFile";
import { beginBackgroundLoad } from "../renderer/backgroundLoad";
import { perfMark } from "../perf";
import { usePipelineStoreApi, usePlaybackStoreApi } from "../stores/MeganeProvider";
import {
  applyStructureToPipeline,
  applyTopologyFile,
  ensureStructureLoader,
  type AppliedStructure,
} from "../pipeline/openFile";
import type { Snapshot, Frame, TrajectoryMeta, TrajectorySource } from "../types";

/** File extensions eligible for lazy multi-frame structure streaming → decoder kind. */
const LAZY_STRUCTURE_KIND: Record<string, FileStructureKind> = {
  ".xyz": "xyz",
  ".extxyz": "xyz",
  ".pdb": "pdb",
  ".traj": "traj",
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
  loadFileProgressive: (file: ProgressiveFile, topFile?: File) => Promise<void>;
  applyStructureResult: (
    result: StructureParseResult,
    fileName: string,
    topFile?: File,
  ) => Promise<void>;
  loadText: (text: string, fileName?: string) => Promise<StructureParseResult>;
  loadXtc: (xtc: File) => Promise<void>;
  seekFrame: (frameIdx: number) => void;
  trajectorySource: TrajectorySource;
  setTrajectorySource: (source: TrajectorySource) => void;
  hasStructureFrames: boolean;
  hasFileFrames: boolean;
}

export function useMeganeLocal(): MeganeLocalState {
  // Resolved through the provider, so a viewer inside a <MeganeProvider> has
  // its loader write to the same store the viewer renders. With no provider
  // these are the module-global singletons, exactly as before.
  const pipelineApi = usePipelineStoreApi();
  const playbackApi = usePlaybackStoreApi();

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
    (result: AppliedStructure, filename: string) => {
      baseSnapshotRef.current = result.snapshot;
      structureFramesRef.current = result.frames;
      fileFramesRef.current = [];
      fileTrajMetaRef.current = null;
      xtcFileNameRef.current = null;
      const hasFrames = result.frames.length > 0;

      // Everything the pipeline sees goes through the same helper `openFile`
      // and the Load Structure node use, so the VSCode and JupyterLab
      // single-file viewers — which feed files through this hook — open a
      // file exactly like the webapp does (node snapshot, AddBond source,
      // embedded vector channels, structure frames, LoadTrajectory source).
      // A graph without a load_structure node (e.g. a .megane.json that has
      // none) gets the minimal pipeline first so the parse reaches the viewer.
      const loaderId = ensureStructureLoader(pipelineApi);
      applyStructureToPipeline(pipelineApi, loaderId, result, filename);

      setHasStructureFrames(hasFrames);
      setHasFileFrames(false);

      const initialTrajSource = hasFrames ? "structure" : "file";
      currentTrajSourceRef.current = initialTrajSource;
      setTrajectorySourceState(initialTrajSource);

      setSnapshot(result.snapshot);
      setMeta(result.meta);
      resetPlayback();
    },
    [resetPlayback, pipelineApi],
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

      // applyResult picks the format's AddBond source (sets "distance" for GRO).
      // If the host pre-loaded a sibling .top, overwrite with topology bonds.
      if (topFile) {
        const store = pipelineApi.getState();
        const loaderNode = store.nodes.find((n) => n.type === "load_structure");
        if (loaderNode) {
          await applyTopologyFile(store, loaderNode.id, topFile);
        }
      }
    },
    [applyResult, pipelineApi],
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
      provider.setOnFrameReady((f) => playbackApi.getState()._onAsyncFrame(f));
      const store = pipelineApi.getState();
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
    [pipelineApi, playbackApi],
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
  // Show a frame 0 parsed from the file's first bytes as a static structure;
  // the rest of the file upgrades it to a trajectory later.
  const showFrame0 = useCallback(
    async (frame0: StructureParseResult, fileName: string, topFile?: File) => {
      applyResult(
        { snapshot: frame0.snapshot, frames: [], meta: null, labels: frame0.labels },
        fileName,
      );
      setPdbFileName(fileName);
      setXtcFileName(null);
      if (!topFile) return;
      const store = pipelineApi.getState();
      const loaderNode = store.nodes.find((n) => n.type === "load_structure");
      if (loaderNode) await applyTopologyFile(store, loaderNode.id, topFile);
    },
    [applyResult, pipelineApi],
  );

  // Phase 2 of a lazy load (background): read the whole file, build the
  // extra-frame index, and attach the streaming provider so the frame 0 already
  // on screen becomes scrubbable. Guarded by `token` against a newer load.
  const upgradeToStreaming = useCallback(
    async (
      file: File,
      kind: FileStructureKind,
      frame0: StructureParseResult,
      token: number,
      topFile?: File,
    ) => {
      const indexed = await indexStructureLazy(file, kind);
      perfMark("megane:lazy:indexed");
      // Heterogeneous files can't ride the positions-only lazy path — the
      // per-frame atom count / cell would be lost. Discard the lazy handle
      // and reparse eagerly so the full HeteroFrames side table is built. A
      // .traj the index cannot read frame by frame is parsed whole too, since
      // its extra frames have no other way in.
      if (!indexed ? kind === "traj" : indexed.handle.index.heterogeneous) {
        if (indexed) disposeTrajectoryLazy(indexed.handle.trajectoryId);
        if (token !== loadTokenRef.current) return;
        const result = await parseStructureFile(file);
        if (token !== loadTokenRef.current) return;
        // A .traj keeps the frame-0 snapshot already on screen (the same
        // atoms, cell and bonds) so the camera is not re-fitted under the user.
        const kept = kind === "traj" ? { ...result, snapshot: frame0.snapshot } : result;
        await applyStructureResult(kept, file.name, topFile);
        return;
      }
      if (!indexed) return; // frame 0 already shown; no streaming available
      if (indexed.handle.index.nFrames <= 0) {
        disposeTrajectoryLazy(indexed.handle.trajectoryId); // single frame — nothing to stream
        return;
      }
      attachStreamingProvider(indexed.handle, frame0, token);
    },
    [applyStructureResult, attachStreamingProvider],
  );

  // Lazy path for large multi-frame structure files (XYZ / PDB) — the target is
  // big-atom-count, many-frame files (multi-MODEL PDB / multi-frame XYZ) whose
  // eager whole-file decode dominates the wait.
  //
  // Phase 1 (critical): parse ONLY frame 0 from a bounded PREFIX of the file and
  //   render it — first paint is O(one frame), independent of total file size.
  // Phase 2 (background): `upgradeToStreaming`.
  //
  // Falls back to a single full read (which also renders frame 0 before decoding
  // the rest) when the prefix can't hold frame 0; returns false only when even
  // that is unavailable (→ caller's eager parse).
  const loadStructureLazy = useCallback(
    async (file: File, kind: FileStructureKind, topFile?: File): Promise<boolean> => {
      const myToken = ++loadTokenRef.current;

      // ── Phase 1: instant frame 0 from a bounded prefix ──
      const prefixFrame0 = await parseStructurePrefix(file, kind);
      perfMark("megane:lazy:prefix");
      if (prefixFrame0) {
        await showFrame0(prefixFrame0, file.name, topFile);
        const endLoad = beginBackgroundLoad();
        void upgradeToStreaming(file, kind, prefixFrame0, myToken, topFile)
          .catch(() => {})
          .finally(endLoad);
        return true;
      }

      // ── Fallback: single full read (frame 0 still renders before full decode) ──
      const indexed = await indexStructureLazy(file, kind);
      if (!indexed) return false;
      const { handle, frame0 } = indexed;
      // Heterogeneous → reparse eagerly (see upgradeToStreaming).
      if (handle.index.heterogeneous) {
        disposeTrajectoryLazy(handle.trajectoryId);
        return false; // caller's eager parse path handles it
      }
      if (handle.index.nFrames <= 0) {
        disposeTrajectoryLazy(handle.trajectoryId);
        await showFrame0(frame0, file.name, topFile);
      } else {
        await showFrame0(frame0, file.name, topFile);
        attachStreamingProvider(handle, frame0, myToken);
      }
      return true;
    },
    [attachStreamingProvider, showFrame0, upgradeToStreaming],
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

  // A file the host delivers in pieces (src/hosts/progressiveFile.ts): draw
  // frame 0 from its head and tail as soon as they arrive, and bring in the
  // rest of the frames when the whole file has. Formats whose frame 0 cannot be
  // read that way simply wait for the whole file and load as usual.
  const loadFileProgressive = useCallback(
    async (pf: ProgressiveFile, topFile?: File) => {
      const ext = pf.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
      const lazyKind = LAZY_STRUCTURE_KIND[ext];
      const streamKind = lazyKind && shouldUseLazyStructure(lazyKind, pf.size) ? lazyKind : null;
      const headKind = streamKind ?? (ext === ".traj" ? ("traj" as const) : null);
      if (headKind) {
        const myToken = ++loadTokenRef.current;
        const frame0 = await parseStructureHead(pf.head, pf.tail, pf.size, headKind);
        perfMark("megane:lazy:prefix");
        if (frame0 && myToken === loadTokenRef.current) {
          await showFrame0(frame0, pf.name, topFile);
          const endLoad = beginBackgroundLoad();
          void pf.file
            .then(async (file) => {
              if (myToken !== loadTokenRef.current) return;
              if (streamKind) {
                await upgradeToStreaming(file, streamKind, frame0, myToken, topFile);
                return;
              }
              // A .traj too small to stream is parsed whole, keeping the
              // frame-0 snapshot already on screen (the same atoms, cell and
              // bonds) so the camera is not re-fitted under the user.
              const result = await parseStructureFile(file);
              if (myToken !== loadTokenRef.current) return;
              await applyStructureResult({ ...result, snapshot: frame0.snapshot }, file.name);
            })
            .catch(() => {})
            .finally(endLoad);
          return;
        }
      }
      await loadFile(await pf.file, topFile);
    },
    [applyStructureResult, loadFile, showFrame0, upgradeToStreaming],
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
        // Frames that each carry a cell: the seeded frame 0 carries its own too.
        seedBox0: handle.index.frameCells ? handle.index.box : null,
      });
      provider.setOnFrameReady((f) => playbackApi.getState()._onAsyncFrame(f));

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
          if (pipelineApi.getState().fileProvider !== provider) return;
          const frames = [...accumulated.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([frame, vectors]) => ({ frame, vectors }));
          pipelineApi.getState().setEmbeddedVectorChannels([{ name: channelNames[0], frames }]);
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

      const store = pipelineApi.getState();
      store.setFileProvider(provider);
      const trajNode = store.nodes.find((n) => n.type === "load_trajectory");
      if (trajNode) {
        store.updateNodeParams(trajNode.id, { fileName });
      }
    },
    [resetPlayback, pipelineApi, playbackApi],
  );

  const loadXtc = useCallback(
    async (xtc: File) => {
      if (!baseSnapshotRef.current) {
        throw new Error("Load a structure before loading a trajectory");
      }
      const kind = trajectoryKindFromFileName(xtc.name);
      const nAtoms = baseSnapshotRef.current.nAtoms;
      const store = pipelineApi.getState();

      // Eager whole-file parse + apply. Used for small files, when the worker is
      // unavailable, and as the fallback for a heterogeneous (variable-atom)
      // LAMMPS dump — whose jagged frames the positions-only lazy decoder can't
      // stream, so the full TrajHetero side table must be built eagerly.
      const eagerLoad = async () => {
        // Dispatches by extension and remaps a variable-atom LAMMPS dump's
        // per-frame type ids to elements via the loaded structure.
        const {
          frames,
          meta: xtcMeta,
          vectorChannels,
        } = await parseTrajectoryByName(xtc, nAtoms, baseSnapshotRef.current?.elements);
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
      const lazyKind: LazyTrajectoryKind | null =
        kind === "lammpstrj" || kind === "xtc" || kind === "dcd" || kind === "netcdf" ? kind : null;
      if (lazyKind && shouldUseLazyTrajectory(lazyKind, xtc.size)) {
        const myToken = ++xtcLoadTokenRef.current;

        // ── Phase 1: instant frame 0 from a bounded prefix ──
        // A DCD / NetCDF index is read from the header alone, so it skips
        // straight to the streaming provider below.
        const fixedLayout = lazyKind === "dcd" || lazyKind === "netcdf";
        const frame0Positions = fixedLayout
          ? null
          : await decodeTrajectoryFrame0(xtc, lazyKind, nAtoms);
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
    [resetPlayback, attachFileProvider, pipelineApi],
  );

  const seekFrame = useCallback((frameIdx: number) => {
    const frames =
      currentTrajSourceRef.current === "file" ? fileFramesRef.current : structureFramesRef.current;

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
  }, []);

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
    loadFileProgressive,
    applyStructureResult,
    loadText,
    loadXtc,
    seekFrame,
    trajectorySource,
    setTrajectorySource,
    hasStructureFrames,
    hasFileFrames,
  };
}
