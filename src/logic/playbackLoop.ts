/**
 * Playhead arithmetic shared by every trajectory player in megane.
 *
 * The playback store (`usePlaybackStore` / `createPlaybackStore`, which
 * MeganeViewer and PipelineViewer drive) and the Jupyter widget's controlled
 * player (`useControlledPlayback`, where the frame index lives on the Python
 * model) both advance, step and clamp through these functions, so the loop
 * range and the end-of-trajectory wrap behave identically on every host.
 */

/** The frame range a player is allowed to visit. */
export interface PlaybackBounds {
  totalFrames: number;
  loopStart: number;
  loopEnd: number;
}

/** Milliseconds between playback ticks at `fps` frames per second × `speed`. */
export function playbackIntervalMs(fps: number, speed: number): number {
  return 1000 / (fps * speed);
}

/**
 * The loop range actually in force: `loopEnd` clamped to the last frame and
 * `loopStart` to the first, so a stale range (left over from a longer
 * trajectory) never points past the data.
 */
export function effectiveLoopRange(bounds: PlaybackBounds): { start: number; end: number } {
  return {
    start: Math.max(bounds.loopStart, 0),
    end: Math.min(bounds.loopEnd, bounds.totalFrames - 1),
  };
}

/**
 * The frame one playback tick moves to from `current`: the next frame,
 * wrapping to the loop start past the loop end. `null` when there is nothing
 * to play (a single-frame or empty trajectory), so the caller skips the tick.
 */
export function nextPlaybackFrame(current: number, bounds: PlaybackBounds): number | null {
  if (bounds.totalFrames <= 1) return null;
  const { start, end } = effectiveLoopRange(bounds);
  const next = current + 1;
  return next > end ? start : next;
}

/**
 * The frame a single step button moves to: one frame forward (`+1`) or back
 * (`-1`), held at the loop range's edge instead of wrapping.
 */
export function stepPlaybackFrame(current: number, delta: 1 | -1, bounds: PlaybackBounds): number {
  const { start, end } = effectiveLoopRange(bounds);
  return delta > 0 ? Math.min(current + 1, end) : Math.max(current - 1, start);
}

/** Clamp a requested loop range to the frames that exist. */
export function clampLoopRange(
  start: number,
  end: number,
  totalFrames: number,
): { loopStart: number; loopEnd: number } {
  const last = totalFrames - 1;
  return {
    loopStart: Math.max(0, Math.min(start, last)),
    loopEnd: Math.max(0, Math.min(end, last)),
  };
}
