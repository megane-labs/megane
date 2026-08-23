/**
 * Single canonical entry point for "open a file in megane".
 *
 * `performOpenFile` classifies the file by extension and configures the
 * pipeline accordingly:
 *
 * - `.megane.json`              → deserialize the pipeline, attach companion
 *                                 structure / trajectory files by basename.
 * - structure formats           → ensure a minimal pipeline exists, parse the
 *                                 file, and feed the result into the first
 *                                 `load_structure` node (snapshot, frames,
 *                                 fileName, hasTrajectory, hasCell).
 * - pure trajectory formats     → require an existing `load_structure` to be
 *                                 populated; otherwise reject. On success,
 *                                 push frames into the global `fileFrames`
 *                                 channel and update the first
 *                                 `load_trajectory` node's fileName.
 *
 * This module is host-agnostic so the webapp, VSCode webview, JupyterLab
 * DocWidget, and anywidget bundle can share a single ingestion path. Hosts
 * call it via the `openFile` action on `usePipelineStore`.
 */

import type { StoreApi } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import { parseStructureFile, parseTopBonds, parsePsfBonds } from "../parsers/structure";
import { isVaspBareName } from "../parsers/fileNames";
import { parseXTCFile, parseLammpstrjFile, parseDCDFile, parseNetCDFFile } from "../parsers/xtc";
import { createMinimalStructurePipeline } from "./defaults";
import { getLayoutedElements } from "./layout";
import type { PipelineNodeData } from "./execute";
import type { PipelineStore } from "./store";
import type { SerializedPipeline } from "./types";
import type { Snapshot, BondSource } from "../types";

export type OpenFileMode = "replace" | "merge";

export interface OpenFileOptions {
  /** "replace" wipes the current graph and installs a minimal pipeline before
   * loading. "merge" keeps the existing graph and only updates target nodes.
   * Defaults to "replace" unless the current graph already contains a
   * matching loader (then "merge"). */
  mode?: OpenFileMode;
  /** Companion files for `.megane.json` opens. Matched to nodes by basename. */
  companions?: File[];
  /** Force the parsed result into a specific node ID instead of the first
   * matching loader. Useful for UI-driven file picker drops on a specific
   * node. */
  targetNodeId?: string;
}

type FileKind = "structure" | "trajectory" | "pipeline" | "unknown";

const STRUCTURE_EXTS = [
  ".molden",
  ".c3xml",
  // Wavefunction Odyssey (XML `.xodydata` and the older text `.odydata`).
  ".xodydata",
  ".odydata",
  ".magres",
  ".gamess",
  ".phonon",
  ".pdb",
  ".ent",
  ".pdbx",
  ".gro",
  ".xyz",
  // Jmol's second extension for plain XYZ.
  ".jxyz",
  ".mol",
  ".sdf",
  ".cif",
  ".mmcif",
  ".data",
  ".lammps",
  ".traj",
  // LAMMPS dump opened standalone as a multi-frame structure (topology derived
  // from frame 0). Also listed under TRAJECTORY_EXTS so it can still be attached
  // onto a separately-loaded topology via the Load Trajectory node.
  ".lammpstrj",
  ".dump",
  ".trj",
  // XCrySDen structure / animation.
  ".xsf",
  ".axsf",
  // Chemical Markup Language.
  ".cml",
  // VASP POSCAR / CONTCAR / XDATCAR (also `.vasp`). The extensionless
  // spellings are classified by basename in `classify` below.
  ".vasp",
];

const TRAJECTORY_EXTS = [".xtc", ".lammpstrj", ".dump", ".trj", ".dcd", ".nc"];

const PIPELINE_SUFFIX = ".megane.json";

// Structure formats that embed bond information directly in the file
// (PDB CONECT records, MOL/SDF bond block, LAMMPS data Bonds section).
// Other supported structure formats (xyz, gro, cif, traj) carry no bond
// information, so VDW distance inference is the more useful default.
const FILE_BOND_EXTS = [
  ".pdb",
  ".ent",
  ".pdbx",
  ".mol",
  ".sdf",
  ".data",
  ".lammps",
  ".cml",
  ".c3xml",
  // Odyssey <bond> / HESSIAN connectivity. A file that declares none still
  // falls back to distance inference, since `nFileBonds` stays 0.
  ".xodydata",
  ".odydata",
];

export function defaultBondSourceForFile(filename: string): "structure" | "distance" {
  const lower = filename.toLowerCase();
  return FILE_BOND_EXTS.some((ext) => lower.endsWith(ext)) ? "structure" : "distance";
}

/**
 * Switch the AddBond node(s) consuming `loaderId`'s `particle` output to a
 * bondSource that matches the file format: `"structure"` for formats that
 * embed bonds (PDB/MOL/SDF/LAMMPS data), `"distance"` (VDW inference) for
 * formats that don't (XYZ/GRO/CIF/traj). Only nodes wired to the targeted
 * loader are touched; user-customised AddBond nodes wired elsewhere are
 * left alone.
 */
export function syncAddBondSourceForLoader(
  state: PipelineStore,
  loaderId: string,
  filename: string,
): void {
  const desired = defaultBondSourceForFile(filename);
  const targets = new Set<string>();
  // Walk forward along particle-carrying edges. AddBond may sit downstream of
  // particle pass-through nodes (symmetry / wrap / replicate / filter / modify /
  // color / representation), so we traverse through those to find it rather than only
  // looking at the loader's direct neighbours.
  const PASS_THROUGH = new Set([
    "symmetry",
    "wrap",
    "replicate",
    "filter",
    "modify",
    "color",
    "representation",
    "drawing_boundary",
  ]);
  const visited = new Set<string>([loaderId]);
  const stack: string[] = [loaderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const edge of state.edges) {
      if (edge.source !== id) continue;
      // Only follow particle-bearing outputs (load_structure "particle",
      // replicate "particle", filter/modify/color/representation "out").
      const sh = edge.sourceHandle ?? "particle";
      if (sh !== "particle" && sh !== "out") continue;
      const targetNode = state.nodes.find((n) => n.id === edge.target);
      if (!targetNode) continue;
      if (targetNode.type === "add_bond") {
        if ((edge.targetHandle ?? "particle") === "particle") targets.add(targetNode.id);
      } else if (PASS_THROUGH.has(targetNode.type ?? "") && !visited.has(targetNode.id)) {
        // Only chase particle inputs into the pass-through node.
        if ((edge.targetHandle ?? "particle") === "particle" || edge.targetHandle === "in") {
          visited.add(targetNode.id);
          stack.push(targetNode.id);
        }
      }
    }
  }
  for (const id of targets) {
    state.updateNodeParams(id, { bondSource: desired });
  }
}

function classify(filename: string): FileKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(PIPELINE_SUFFIX)) return "pipeline";
  // Structure is checked first so a format listed in both lists (a LAMMPS dump,
  // which can be opened standalone as a structure OR attached as a trajectory)
  // defaults to a standalone structure load on a generic/drag-drop open. The two
  // lists are otherwise disjoint, so pure trajectory formats are unaffected.
  for (const ext of STRUCTURE_EXTS) if (lower.endsWith(ext)) return "structure";
  if (isVaspBareName(lower)) return "structure";
  for (const ext of TRAJECTORY_EXTS) if (lower.endsWith(ext)) return "trajectory";
  return "unknown";
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * Read a Blob/File as UTF-8 text. Prefers `Blob.text()` when available
 * (browsers, modern Node) and falls back to `FileReader` for jsdom-based
 * test environments where Blob.text/arrayBuffer are not polyfilled.
 */
async function readBlobAsText(blob: Blob): Promise<string> {
  if (typeof (blob as Blob & { text?: () => Promise<string> }).text === "function") {
    return (blob as Blob & { text: () => Promise<string> }).text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsText(blob);
  });
}

function installMinimalGraph(api: StoreApi<PipelineStore>): void {
  const raw = createMinimalStructurePipeline();
  const { nodes, edges } = getLayoutedElements(raw.nodes, raw.edges);
  api.setState({
    nodes: nodes as Node<PipelineNodeData>[],
    edges: edges as Edge[],
    nodeSnapshots: {},
    nodeParseErrors: {},
    nodeStreamingData: {},
    snapshot: null,
    atomLabels: null,
    structureFrames: null,
    structureMeta: null,
    fileFrames: null,
    fileMeta: null,
    fileVectors: null,
  });
}

function findNodeId(
  api: StoreApi<PipelineStore>,
  type: "load_structure" | "load_trajectory",
): string | null {
  return api.getState().nodes.find((n) => n.type === type)?.id ?? null;
}

async function openStructure(
  api: StoreApi<PipelineStore>,
  file: File,
  opts: OpenFileOptions,
): Promise<void> {
  const result = await parseStructureFile(file);

  const hasLoader = api.getState().nodes.some((n) => n.type === "load_structure");
  const mode: OpenFileMode = opts.mode ?? (hasLoader ? "merge" : "replace");

  if (mode === "replace" || !hasLoader) {
    installMinimalGraph(api);
  }

  const state = api.getState();
  const loaderId = opts.targetNodeId ?? findNodeId(api, "load_structure");
  if (!loaderId) {
    throw new Error("No load_structure node available after installing minimal pipeline");
  }

  state.setNodeSnapshot(loaderId, {
    snapshot: result.snapshot,
    frames: result.frames.length > 0 ? result.frames : null,
    meta: result.meta,
    labels: result.labels,
  });
  state.updateNodeParams(loaderId, {
    fileName: file.name,
    hasTrajectory: result.frames.length > 0,
    hasCell: !!result.snapshot.box,
  });

  syncAddBondSourceForLoader(api.getState(), loaderId, file.name);

  // Offer embedded vector channels to the load_vector node UI; nothing
  // renders until the user activates one (a parse must not switch a visual
  // overlay on as a side effect).
  state.setEmbeddedVectorChannels(
    result.vectorChannels && result.vectorChannels.length > 0
      ? result.vectorChannels.map((ch) => ({ name: ch.name, frames: ch.frames }))
      : null,
  );

  // When opening a multi-frame structure file (e.g. .traj, multi-MODEL .pdb,
  // multi-frame .xyz), the frames live in the structure file itself. Switch
  // any LoadTrajectory node to its visible "structure" source instead of
  // silently removing it from the graph; a single-frame file resets it to
  // "file" so a later XTC/DCD open plays normally.
  const trajNodeId = findNodeId(api, "load_trajectory");
  if (result.frames.length > 0) {
    state.setFileFrames(null, null);
    if (trajNodeId) {
      state.updateNodeParams(trajNodeId, { source: "structure", fileName: "" });
    }
  } else if (trajNodeId) {
    state.updateNodeParams(trajNodeId, { source: "file" });
  }
}

async function openTrajectory(
  api: StoreApi<PipelineStore>,
  file: File,
  opts: OpenFileOptions,
): Promise<void> {
  const state = api.getState();
  const loaderId = findNodeId(api, "load_structure");
  const loaderSnapshot = loaderId ? state.nodeSnapshots[loaderId]?.snapshot : null;
  if (!loaderSnapshot) {
    throw new Error(
      `Cannot open ${file.name}: load a structure file first. Trajectory files require a structure to know the atom count and identities.`,
    );
  }

  const lower = file.name.toLowerCase();
  const isLammps =
    lower.endsWith(".lammpstrj") || lower.endsWith(".dump") || lower.endsWith(".trj");
  const isDcd = lower.endsWith(".dcd");
  const isNetcdf = lower.endsWith(".nc");
  const parseFn = isLammps
    ? parseLammpstrjFile
    : isDcd
      ? parseDCDFile
      : isNetcdf
        ? parseNetCDFFile
        : parseXTCFile;
  const { frames, meta } = await parseFn(file, loaderSnapshot.nAtoms);

  state.setFileFrames(frames, meta ?? null);

  const trajId = opts.targetNodeId ?? findNodeId(api, "load_trajectory");
  if (trajId) {
    state.updateNodeParams(trajId, { fileName: file.name, source: "file" });
  }
}

async function openPipeline(
  api: StoreApi<PipelineStore>,
  file: File,
  opts: OpenFileOptions,
): Promise<void> {
  const text = await readBlobAsText(file);
  const pipeline = JSON.parse(text) as SerializedPipeline;
  if (pipeline.version !== 3) {
    throw new Error(
      `Not a valid megane pipeline file (version 3 required, got ${pipeline.version})`,
    );
  }

  api.getState().deserialize(pipeline);

  const companions = opts.companions ?? [];
  if (companions.length === 0) return;

  const fileMap = new Map(companions.map((f) => [f.name, f]));

  // Phase 1: structure files. Match by basename of the node's fileName.
  let firstSnapshot: Snapshot | null = null;
  for (const node of pipeline.nodes ?? []) {
    if (node.type !== "load_structure") continue;
    const fname = (node as { fileName?: string | null }).fileName;
    if (!fname) continue;
    const name = basename(String(fname));
    const f = fileMap.get(name);
    if (!f) continue;
    const result = await parseStructureFile(f);
    const state = api.getState();
    state.setNodeSnapshot(node.id, {
      snapshot: result.snapshot,
      frames: result.frames.length > 0 ? result.frames : null,
      meta: result.meta,
      labels: result.labels,
    });
    state.updateNodeParams(node.id, {
      fileName: name,
      hasTrajectory: result.frames.length > 0,
      hasCell: !!result.snapshot.box,
    });
    if (!firstSnapshot) firstSnapshot = result.snapshot;
  }

  // Phase 2: trajectory files. Single global trajectory channel — only
  // attach the first one we find that has a matching companion.
  for (const node of pipeline.nodes ?? []) {
    if (node.type !== "load_trajectory") continue;
    if (!firstSnapshot) break;
    const fname = (node as { fileName?: string | null }).fileName;
    if (!fname) continue;
    const name = basename(String(fname));
    const f = fileMap.get(name);
    if (!f) continue;
    const lower = name.toLowerCase();
    const isLammps =
      lower.endsWith(".lammpstrj") || lower.endsWith(".dump") || lower.endsWith(".trj");
    const isDcd = lower.endsWith(".dcd");
    const isNetcdf = lower.endsWith(".nc");
    const parseFn = isLammps
      ? parseLammpstrjFile
      : isDcd
        ? parseDCDFile
        : isNetcdf
          ? parseNetCDFFile
          : parseXTCFile;
    const { frames, meta } = await parseFn(f, firstSnapshot.nAtoms);
    const state = api.getState();
    state.setFileFrames(frames, meta ?? null);
    state.updateNodeParams(node.id, { fileName: name });
    break;
  }
}

/**
 * Parse a topology file (.top or .psf) and apply the resulting bonds to every
 * AddBond node that is downstream of `loaderId` in the current graph.
 *
 * This is the programmatic equivalent of the user dropping a .top file onto
 * the AddBond node in the UI.  Call it *after* `syncAddBondSourceForLoader`
 * so it overwrites the format-based default ("distance" for GRO).
 */
export async function applyTopologyFile(
  state: PipelineStore,
  loaderId: string,
  topFile: File,
): Promise<void> {
  const text = await readBlobAsText(topFile);
  const lower = topFile.name.toLowerCase();
  const bondIndices = lower.endsWith(".psf")
    ? await parsePsfBonds(text, 0xffffffff)
    : await parseTopBonds(text, 0xffffffff);

  const PASS_THROUGH = new Set([
    "symmetry",
    "wrap",
    "replicate",
    "filter",
    "modify",
    "color",
    "representation",
    "drawing_boundary",
  ]);
  const visited = new Set<string>([loaderId]);
  const stack: string[] = [loaderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const edge of state.edges) {
      if (edge.source !== id) continue;
      const sh = edge.sourceHandle ?? "particle";
      if (sh !== "particle" && sh !== "out") continue;
      const targetNode = state.nodes.find((n) => n.id === edge.target);
      if (!targetNode) continue;
      if (targetNode.type === "add_bond") {
        if ((edge.targetHandle ?? "particle") === "particle") {
          state.updateNodeParams(targetNode.id, {
            bondSource: "file" as BondSource,
            bondFileName: topFile.name,
            bondFileData: bondIndices,
          });
        }
      } else if (PASS_THROUGH.has(targetNode.type ?? "") && !visited.has(targetNode.id)) {
        if ((edge.targetHandle ?? "particle") === "particle" || edge.targetHandle === "in") {
          visited.add(targetNode.id);
          stack.push(targetNode.id);
        }
      }
    }
  }
}

/**
 * Entry point used by `usePipelineStore.openFile`. Hosts should not call
 * this directly — use the store action so subscribers see the changes.
 */
export async function performOpenFile(
  api: StoreApi<PipelineStore>,
  file: File,
  opts: OpenFileOptions = {},
): Promise<void> {
  const kind = classify(file.name);
  switch (kind) {
    case "pipeline":
      return openPipeline(api, file, opts);
    case "structure":
      return openStructure(api, file, opts);
    case "trajectory":
      return openTrajectory(api, file, opts);
    case "unknown":
    default:
      throw new Error(`Unsupported file type: ${file.name}`);
  }
}

// Re-export the classifier for use by hosts that want to know how a file
// would be treated before invoking openFile (e.g. the webapp drag-drop
// handler reading multi-file drops).
export { classify as classifyFile };
export type { FileKind };
