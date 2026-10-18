/**
 * Per-atom vector data helpers: parse a `.vec` file and pick the vectors for a
 * playback frame. Used by the pipeline's `load_vector` node (openFile.ts,
 * useNodeLoadHandlers.ts) and the viewport's vector overlay (apply.ts).
 */

import type { VectorFrame } from "../types";

/** Mutable refs for vector caching. */
export interface VectorSourceRefs {
  fileVectors: VectorFrame[] | null;
}

/**
 * Get vectors for a given frame index.
 * Returns null if no vector data is available.
 * If only one frame of vectors exists, it is used for all frames (static vectors).
 */
export function getVectorsForFrame(
  refs: VectorSourceRefs,
  frameIndex: number,
): Float32Array | null {
  if (!refs.fileVectors || refs.fileVectors.length === 0) return null;
  if (refs.fileVectors.length === 1) return refs.fileVectors[0].vectors;
  const vf = refs.fileVectors.find((v) => v.frame === frameIndex);
  return vf?.vectors ?? null;
}

/**
 * Parse a .vec file (JSON Lines) and return per-frame vector data.
 * Format: each line is {"frame": N, "vectors": [[vx,vy,vz], ...]}
 */
export async function loadVectorFileData(
  file: File,
  nAtoms: number,
): Promise<{ vectors: VectorFrame[]; fileName: string }> {
  const text = await file.text();
  const lines = text.trim().split("\n");
  const vectors: VectorFrame[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line) as { frame: number; vectors: number[][] };
    const flat = new Float32Array(nAtoms * 3);
    for (let i = 0; i < nAtoms && i < obj.vectors.length; i++) {
      flat[i * 3] = obj.vectors[i][0];
      flat[i * 3 + 1] = obj.vectors[i][1];
      flat[i * 3 + 2] = obj.vectors[i][2];
    }
    vectors.push({ frame: obj.frame, vectors: flat });
  }
  return { vectors, fileName: file.name };
}
