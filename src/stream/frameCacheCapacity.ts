/**
 * How many decoded trajectory frames a frame provider keeps.
 *
 * A frame costs 12 bytes per atom, so a cache sized in frames alone grows with
 * the system: 256 frames of a 100k-atom trajectory pin ~300 MB, and of a
 * 1M-atom one ~3 GB, which takes the tab down. The cache is therefore capped
 * by bytes too; small systems still keep every frame up to the frame limit.
 */

/** Most bytes of decoded positions a frame cache keeps by default (128 MiB). */
export const DEFAULT_FRAME_CACHE_BYTES = 128 * 1024 * 1024;

/**
 * Fewest frames a cache keeps whatever their size: the frame on screen and
 * the next one, so stepping forward never evicts the frame just decoded.
 */
export const MIN_FRAME_CACHE_FRAMES = 2;

/**
 * Frames of `nAtoms` atoms a cache keeps: at most `maxFrames`, at most
 * `maxBytes` of positions, and never fewer than {@link MIN_FRAME_CACHE_FRAMES}.
 */
export function frameCacheCapacity(
  nAtoms: number,
  maxFrames: number,
  maxBytes: number = DEFAULT_FRAME_CACHE_BYTES,
): number {
  const frameBytes = Math.max(1, nAtoms * 3 * Float32Array.BYTES_PER_ELEMENT);
  const byBytes = Math.floor(maxBytes / frameBytes);
  return Math.max(MIN_FRAME_CACHE_FRAMES, Math.min(maxFrames, byBytes));
}
