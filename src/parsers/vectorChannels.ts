/**
 * Shared helper for deserializing embedded vector channels from WASM parse results.
 * Used by both structure.ts and xtc.ts.
 */

import type { ScalarChannel, ScalarFrame, VectorChannel, VectorFrame } from "../types";

/**
 * Deserialize embedded vector channels from a WASM parse result.
 *
 * @param nAtoms   Number of atoms (determines stride = nAtoms * 3).
 * @param metaStr  JSON string: `[{"name":"velocity","n_frames":1}, ...]`
 * @param dataFn   Lazy accessor for the flat Float32Array of all channel data.
 *                 Called only when metaStr indicates channels are present.
 *
 * Data layout in the flat buffer: for each channel, for each frame in order,
 * `nAtoms * 3` f32 values.  `subarray` is used to avoid per-frame copies.
 */
export function deserializeVectorChannels(
  nAtoms: number,
  metaStr: string,
  dataFn: () => Float32Array,
): VectorChannel[] {
  if (!metaStr || metaStr === "[]") return [];
  const meta = JSON.parse(metaStr) as Array<{ name: string; n_frames: number }>;
  if (meta.length === 0) return [];

  const data = dataFn();
  const stride = nAtoms * 3;
  const channels: VectorChannel[] = [];
  let offset = 0;

  for (const ch of meta) {
    const frames: VectorFrame[] = [];
    for (let f = 0; f < ch.n_frames; f++) {
      // subarray avoids a copy — the view shares the underlying WASM buffer.
      frames.push({ frame: f, vectors: data.subarray(offset, offset + stride) });
      offset += stride;
    }
    channels.push({ name: ch.name, frames });
  }
  return channels;
}

/**
 * Deserialize embedded per-atom scalar channels from a WASM parse result.
 * Same layout as vector channels but with a stride of `nAtoms` (one value per
 * atom per frame).
 */
export function deserializeScalarChannels(
  nAtoms: number,
  metaStr: string,
  dataFn: () => Float32Array,
): ScalarChannel[] {
  if (!metaStr || metaStr === "[]") return [];
  const meta = JSON.parse(metaStr) as Array<{ name: string; n_frames: number }>;
  if (meta.length === 0) return [];

  const data = dataFn();
  const channels: ScalarChannel[] = [];
  let offset = 0;

  for (const ch of meta) {
    const frames: ScalarFrame[] = [];
    for (let f = 0; f < ch.n_frames; f++) {
      // subarray avoids a copy — the view shares the underlying WASM buffer.
      frames.push({ frame: f, values: data.subarray(offset, offset + nAtoms) });
      offset += nAtoms;
    }
    channels.push({ name: ch.name, frames });
  }
  return channels;
}
