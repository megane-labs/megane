import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useControlledPlayback,
  type ControlledPlaybackOptions,
} from "@/hooks/useControlledPlayback";

/**
 * Drives the hook like WidgetViewer does: the host owns the playhead and
 * feeds every `onSeek` back as `currentFrame` on the next render.
 */
function setup(totalFrames: number, currentFrame = 0) {
  const seeks: number[] = [];
  let props: ControlledPlaybackOptions;
  const onSeek = vi.fn((frame: number) => {
    seeks.push(frame);
    props = { ...props, currentFrame: frame };
    hook.rerender(props);
  });
  props = { currentFrame, totalFrames, onSeek };
  const hook = renderHook((p: ControlledPlaybackOptions) => useControlledPlayback(p), {
    initialProps: props,
  });
  return {
    hook,
    seeks,
    onSeek,
    get current() {
      return hook.result.current;
    },
    setProps(next: Partial<ControlledPlaybackOptions>) {
      props = { ...props, ...next };
      hook.rerender(props);
    },
  };
}

describe("useControlledPlayback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts paused at 30 fps with the loop range covering the trajectory", () => {
    const p = setup(5);
    expect(p.current.playing).toBe(false);
    expect(p.current.fps).toBe(30);
    expect(p.current.speedMultiplier).toBe(1);
    expect(p.current.loopStart).toBe(0);
    expect(p.current.loopEnd).toBe(4);
  });

  it("plays through the host, wrapping at the loop end", () => {
    const p = setup(3);
    act(() => p.current.onFpsChange(10));
    act(() => p.current.onPlayPause());
    expect(p.current.playing).toBe(true);
    act(() => vi.advanceTimersByTime(100 * 4));
    expect(p.seeks).toEqual([1, 2, 0, 1]);

    act(() => p.current.onPlayPause());
    expect(p.current.playing).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(p.seeks).toHaveLength(4);
  });

  it("re-arms the interval on a speed change", () => {
    const p = setup(100);
    act(() => p.current.onFpsChange(10));
    act(() => p.current.onPlayPause());
    act(() => p.current.onSpeedChange(2));
    expect(p.current.speedMultiplier).toBe(2);
    act(() => vi.advanceTimersByTime(200));
    expect(p.seeks).toEqual([1, 2, 3, 4]);
  });

  it("will not play a single-frame trajectory", () => {
    const p = setup(1);
    act(() => p.current.onPlayPause());
    expect(p.current.playing).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it("stops when the host swaps in a single-frame structure mid-playback", () => {
    const p = setup(10);
    act(() => p.current.onPlayPause());
    act(() => p.setProps({ totalFrames: 1, currentFrame: 0 }));
    expect(p.current.playing).toBe(false);
    p.onSeek.mockClear();
    act(() => vi.advanceTimersByTime(1000));
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it("clears the interval on unmount", () => {
    const p = setup(10);
    act(() => p.current.onPlayPause());
    p.hook.unmount();
    p.onSeek.mockClear();
    vi.advanceTimersByTime(1000);
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it("pauses when the user scrubs", () => {
    const p = setup(10);
    act(() => p.current.onPlayPause());
    act(() => p.current.onSeek(7));
    expect(p.current.playing).toBe(false);
    expect(p.seeks).toEqual([7]);
  });

  it("steps within the clamped loop range", () => {
    const p = setup(10, 5);
    act(() => p.current.onLoopRangeChange(4, 99));
    expect(p.current.loopStart).toBe(4);
    expect(p.current.loopEnd).toBe(9);
    act(() => p.current.onLoopRangeChange(4, 6));
    act(() => p.current.onStepForward());
    act(() => p.current.onStepForward());
    expect(p.seeks).toEqual([6, 6]);
    act(() => p.current.onStepBackward());
    act(() => p.current.onStepBackward());
    act(() => p.current.onStepBackward());
    expect(p.seeks).toEqual([6, 6, 5, 4, 4]);
  });

  it("keeps playing (and sending frames to the host) when the loop start is past the end", () => {
    const p = setup(100, 78);
    // Mid-edit in the Timeline: start typed as 80 while the end is still 20.
    act(() => p.current.onLoopRangeChange(80, 20));
    // The inputs keep showing what was typed.
    expect([p.current.loopStart, p.current.loopEnd]).toEqual([80, 20]);
    act(() => p.current.onPlayPause());
    for (let i = 0; i < 4; i++) act(() => vi.advanceTimersByTime(1000 / 30 + 1));
    expect(p.seeks).toEqual([79, 80, 20, 21]);
  });

  it("resets the loop range when a new trajectory arrives", () => {
    const p = setup(10);
    act(() => p.current.onLoopRangeChange(2, 3));
    act(() => p.setProps({ totalFrames: 20 }));
    expect(p.current.loopStart).toBe(0);
    expect(p.current.loopEnd).toBe(19);
    act(() => p.setProps({ totalFrames: 0 }));
    expect(p.current.loopEnd).toBe(0);
  });
});
