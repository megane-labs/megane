/**
 * Lower the viewer's frame rate while a file is still loading in the
 * background.
 *
 * The renderer redraws every animation frame. When frame 0 of a large file is
 * already on screen but the rest of the file is still arriving (a VS Code
 * webview receiving the remainder of a document, `useMeganeLocal`'s
 * progressive load), those redraws compete with receiving and indexing it for
 * the page's main thread. Under software WebGL that stretched receiving the
 * last 61 MB of a 73 MB trajectory from ~5 s to ~30 s. While any background
 * load is in flight the renderer redraws when the camera moves (so dragging
 * stays smooth) and otherwise at most every {@link BACKGROUND_LOAD_FRAME_MS},
 * back to every frame the moment the load ends.
 */

/** Minimum time between idle redraws while a background load is in flight. */
export const BACKGROUND_LOAD_FRAME_MS = 250;

let inFlight = 0;

/**
 * Mark a background load as started; call the returned function (once) when
 * it ends, successfully or not.
 */
export function beginBackgroundLoad(): () => void {
  inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight -= 1;
  };
}

/** Whether a frame due at `now` should be skipped, given the last draw time. */
export function skipFrameForBackgroundLoad(now: number, lastDrawAt: number): boolean {
  return inFlight > 0 && now - lastDrawAt < BACKGROUND_LOAD_FRAME_MS;
}
