/**
 * Playback controls for a viewer whose playhead lives outside React.
 *
 * The Jupyter widget does not own its frames: `frame_index` is a traitlet on
 * the Python model and every frame change goes out through `onSeek`. So unlike
 * MeganeViewer / PipelineViewer — which drive a playback store that pulls
 * frames from a FrameProvider — WidgetViewer is a *controlled* player. This
 * hook gives it the same transport as the store: the tick, step and loop
 * arithmetic come from `logic/playbackLoop` (shared with the store), so the
 * loop range, the wrap at the end and the clamping behave identically.
 *
 * Returns props ready to spread into `<Timeline>`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampLoopRange,
  nextPlaybackFrame,
  playbackIntervalMs,
  stepPlaybackFrame,
  type PlaybackBounds,
} from "../logic/playbackLoop";

export interface ControlledPlaybackOptions {
  /** The frame currently shown (owned by the host). */
  currentFrame: number;
  totalFrames: number;
  /** Ask the host to show `frame`. */
  onSeek: (frame: number) => void;
}

export interface ControlledPlayback {
  playing: boolean;
  fps: number;
  speedMultiplier: number;
  loopStart: number;
  loopEnd: number;
  onSeek: (frame: number) => void;
  onPlayPause: () => void;
  onFpsChange: (fps: number) => void;
  onSpeedChange: (speed: number) => void;
  onLoopRangeChange: (start: number, end: number) => void;
  onStepBackward: () => void;
  onStepForward: () => void;
}

export function useControlledPlayback({
  currentFrame,
  totalFrames,
  onSeek,
}: ControlledPlaybackOptions): ControlledPlayback {
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(30);
  const [speedMultiplier, setSpeedMultiplier] = useState(1);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(0);

  // The interval callback reads the latest values through refs, so it is only
  // re-armed when its period changes.
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const frameRef = useRef(currentFrame);
  frameRef.current = currentFrame;
  const bounds: PlaybackBounds = { totalFrames, loopStart, loopEnd };
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // A new trajectory resets the loop range to all of it.
  useEffect(() => {
    setLoopStart(0);
    setLoopEnd(totalFrames > 0 ? totalFrames - 1 : 0);
  }, [totalFrames]);

  // Nothing left to play (the host swapped in a single-frame structure while
  // playing): stop, instead of re-seeking frame 0 on every tick with the
  // Timeline — and so the pause button — no longer on screen.
  const canPlay = totalFrames > 1;
  useEffect(() => {
    if (!canPlay) setPlaying(false);
  }, [canPlay]);

  // The interval lives in an effect so it is re-armed on an fps / speed change
  // and cleared on pause and on unmount.
  useEffect(() => {
    if (!playing || !canPlay) return;
    const id = setInterval(
      () => {
        const next = nextPlaybackFrame(frameRef.current, boundsRef.current);
        if (next === null) return;
        frameRef.current = next;
        onSeekRef.current(next);
      },
      playbackIntervalMs(fps, speedMultiplier),
    );
    return () => clearInterval(id);
  }, [playing, canPlay, fps, speedMultiplier]);

  const handlePlayPause = useCallback(() => {
    setPlaying((prev) => !prev && boundsRef.current.totalFrames > 1);
  }, []);

  // Scrubbing pauses playback, so the playhead stays where the user put it.
  const handleSeek = useCallback((frame: number) => {
    setPlaying(false);
    onSeekRef.current(frame);
  }, []);

  const handleLoopRangeChange = useCallback((start: number, end: number) => {
    const clamped = clampLoopRange(start, end, boundsRef.current.totalFrames);
    setLoopStart(clamped.loopStart);
    setLoopEnd(clamped.loopEnd);
  }, []);

  const handleStepForward = useCallback(() => {
    onSeekRef.current(stepPlaybackFrame(frameRef.current, 1, boundsRef.current));
  }, []);

  const handleStepBackward = useCallback(() => {
    onSeekRef.current(stepPlaybackFrame(frameRef.current, -1, boundsRef.current));
  }, []);

  return {
    playing,
    fps,
    speedMultiplier,
    loopStart,
    loopEnd,
    onSeek: handleSeek,
    onPlayPause: handlePlayPause,
    onFpsChange: setFps,
    onSpeedChange: setSpeedMultiplier,
    onLoopRangeChange: handleLoopRangeChange,
    onStepBackward: handleStepBackward,
    onStepForward: handleStepForward,
  };
}
