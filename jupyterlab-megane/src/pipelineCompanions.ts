/**
 * Fetching the companion files a `.megane.json` pipeline references, through
 * the Jupyter Contents service.
 *
 * Which nodes carry a file, and under which param, comes from the shared
 * `companionFileName` (`src/pipeline/companionFiles.ts`), the same list the VS
 * Code host mirrors, so the two pipeline hosts fetch the same files.
 */

import type { Contents } from "@jupyterlab/services";
import { companionFileName } from "@megane/pipeline/companionFiles";
import { decodeBase64 } from "@megane/utils/base64";
import { fileFromBytes } from "@megane/parsers/fileBytes";

export interface MinimalSerializedPipeline {
  version?: number;
  nodes?: Array<{ id?: string; type?: string; [key: string]: unknown }>;
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

export function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Resolve `rel` against `dir` (both Contents-service paths), or `null` when it
 * is absolute or climbs out of `dir`.
 */
export function joinUnderDir(dir: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const parts = (dir ? `${dir}/${rel}` : rel).split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (dir === "") return joined;
  if (joined !== dir && !joined.startsWith(`${dir}/`)) return null;
  return joined;
}

/** The Contents paths of every companion file the pipeline's nodes name. */
export function collectCompanionTargets(
  pipeline: MinimalSerializedPipeline,
  dir: string,
): string[] {
  const targets: string[] = [];
  for (const node of pipeline.nodes ?? []) {
    const fileName = companionFileName(node);
    if (!fileName) continue;
    const target = joinUnderDir(dir, fileName);
    if (target) targets.push(target);
  }
  return targets;
}

/**
 * Fetch one file as bytes (base64 over the Contents API, so binary formats such
 * as ASE `.traj` arrive intact), or `null` when it cannot be read.
 */
export async function fetchCompanion(
  contents: Contents.IManager,
  path: string,
): Promise<File | null> {
  try {
    const model = await contents.get(path, { content: true, format: "base64" });
    const bytes = decodeBase64(String(model.content ?? ""));
    return fileFromBytes(bytes, basename(path));
  } catch {
    return null;
  }
}

/** Fetch every companion of `pipeline` in parallel, dropping unreadable ones. */
export async function fetchPipelineCompanions(
  contents: Contents.IManager,
  pipeline: MinimalSerializedPipeline,
  dir: string,
): Promise<File[]> {
  const targets = collectCompanionTargets(pipeline, dir);
  const fetched = await Promise.all(targets.map((p) => fetchCompanion(contents, p)));
  return fetched.filter((f): f is File => f !== null);
}
