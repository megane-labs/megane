/**
 * Main-thread load meter for the performance HUD's CPU readout.
 *
 * A page cannot read its process's CPU usage, but it can see how much of the
 * main thread is left over: the browser hands out idle time between tasks and
 * frames through `requestIdleCallback`, and each callback's `timeRemaining()`
 * is the length of the idle period it starts. Summing those over a window and
 * subtracting from the window's length gives the share of the main thread that
 * was busy — rendering, React, parsing on the main thread, GC, layout — which
 * is the load that makes the viewer stutter. Work in the parse worker and the
 * GPU process is not included.
 *
 * Browsers without `requestIdleCallback` (Safari) report `null`.
 */

/**
 * Rolling busy-fraction counter, fed one idle period at a time. Like
 * `FpsCounter` it recomputes once per window and holds that value, and it is
 * pure so the arithmetic is unit-testable without a browser.
 */
export class MainThreadLoad {
  private readonly windowMs: number;
  private windowStart: number | null = null;
  private idleMs = 0;
  private _load: number | null = null;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  /** Record an idle period of `idleMs` that began at `nowMs`. */
  idle(nowMs: number, idleMs: number): void {
    if (this.windowStart === null) {
      this.windowStart = nowMs;
    } else {
      const elapsed = nowMs - this.windowStart;
      if (elapsed >= this.windowMs) {
        this._load = Math.min(1, Math.max(0, 1 - this.idleMs / elapsed));
        this.windowStart = nowMs;
        this.idleMs = 0;
      }
    }
    // This period runs after `nowMs`, so it belongs to the window now open.
    this.idleMs += idleMs;
  }

  /** Busy fraction (0–1) of the last closed window, or null before the first. */
  get load(): number | null {
    return this._load;
  }
}

interface IdleWindow {
  requestIdleCallback(cb: (deadline: { timeRemaining(): number }) => void): number;
  cancelIdleCallback(handle: number): void;
}

let meter: MainThreadLoad | null = null;
let handle: number | null = null;
let users = 0;

function idleApi(): IdleWindow | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Partial<IdleWindow>;
  if (typeof w.requestIdleCallback !== "function" || typeof w.cancelIdleCallback !== "function") {
    return null;
  }
  return {
    requestIdleCallback: w.requestIdleCallback.bind(window),
    cancelIdleCallback: w.cancelIdleCallback.bind(window),
  };
}

/**
 * Start sampling idle time. The sampler is shared by every caller (the main
 * thread is one per page, however many viewers it hosts) and runs until each
 * has called the returned release function. Does nothing where
 * `requestIdleCallback` is missing.
 */
export function watchMainThreadLoad(): () => void {
  const api = idleApi();
  if (!api) return () => {};
  users++;
  if (users === 1) {
    const m = new MainThreadLoad();
    meter = m;
    const sample = (deadline: { timeRemaining(): number }) => {
      m.idle(performance.now(), deadline.timeRemaining());
      handle = api.requestIdleCallback(sample);
    };
    handle = api.requestIdleCallback(sample);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    if (users === 0) {
      if (handle !== null) api.cancelIdleCallback(handle);
      handle = null;
      meter = null;
    }
  };
}

/** Current main-thread busy fraction (0–1), or null when not measurable yet. */
export function mainThreadLoad(): number | null {
  return meter?.load ?? null;
}
