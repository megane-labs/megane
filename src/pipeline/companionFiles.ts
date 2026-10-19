/**
 * Companion files of a `.megane.json` pipeline.
 *
 * A saved pipeline stores file *names*, not file contents: every node that
 * reads a file keeps the name in one of its params, and the host opening the
 * pipeline has to fetch those files from beside the `.megane.json` and hand
 * them to `usePipelineStore.openFile(meganeFile, { companions })`, which
 * matches them back to the nodes by basename (`openPipeline` in `openFile.ts`).
 *
 * This module is the single list of which node types carry a file and under
 * which param, so the hosts (the JupyterLab pipeline document, the VS Code
 * pipeline editor) and the ingestion path cannot disagree about it. The VS
 * Code *extension host* is compiled separately from `src/` and keeps its own
 * copy, which `tests/ts/vscode/extension.test.ts` pins to this one.
 *
 * Companions always travel as bytes. Several structure formats are binary
 * (ASE `.traj`, for one), so decoding a companion as text on the way — as the
 * VS Code host once did for Load Structure files — corrupts it.
 */

import { fileFromBytes } from "../parsers/fileBytes";
import type { PipelineNodeType } from "./types";

/** Node type → the param that names the file it reads. */
export const COMPANION_FILE_PARAMS = {
  load_structure: "fileName",
  load_trajectory: "fileName",
  load_vector: "fileName",
  load_volumetric: "fileName",
  load_spectrum: "fileName",
  // A topology (.top / .psf) supplying the bonds when bondSource is "file".
  add_bond: "bondFileName",
} as const satisfies Partial<Record<PipelineNodeType, string>>;

export type CompanionNodeType = keyof typeof COMPANION_FILE_PARAMS;

/** The node types whose params name a companion file. */
export const COMPANION_NODE_TYPES = Object.keys(COMPANION_FILE_PARAMS) as CompanionNodeType[];

/**
 * Prefix `LoadVectorNode` writes into `fileName` when the vectors come from a
 * channel embedded in the structure file (e.g. GRO velocities) — not a file.
 */
export const EMBEDDED_VECTOR_PREFIX = "[embedded] ";

export function isCompanionNodeType(type: unknown): type is CompanionNodeType {
  return (
    typeof type === "string" && Object.prototype.hasOwnProperty.call(COMPANION_FILE_PARAMS, type)
  );
}

/**
 * The companion file a serialized pipeline node references, as written in the
 * pipeline (possibly a relative path), or `null` when the node reads no file.
 */
export function companionFileName(node: { type?: unknown }): string | null {
  if (!isCompanionNodeType(node.type)) return null;
  const value = (node as Record<string, unknown>)[COMPANION_FILE_PARAMS[node.type]];
  if (typeof value !== "string" || value === "") return null;
  if (node.type === "load_vector" && value.startsWith(EMBEDDED_VECTOR_PREFIX)) return null;
  return value;
}

/** One companion as a host posts it: the file's bytes and its basename. */
export interface CompanionFilePayload {
  nodeId: string;
  nodeType: string;
  filename: string;
  content: ArrayBuffer;
}

/** Rebuild `File`s from companions received as bytes. */
export function companionFilesFromPayload(payload: readonly CompanionFilePayload[]): File[] {
  return payload.map((c) => fileFromBytes(new Uint8Array(c.content), c.filename));
}
