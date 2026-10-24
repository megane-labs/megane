/**
 * Minimal rolling FPS counter.
 *
 * Fed one timestamp per animation frame (in ms, e.g. from `performance.now()`),
 * it recomputes the rate of *drawn* frames once every `windowMs` and holds that
 * value until the next window closes. The renderer draws on demand, so frames
 * it skipped (nothing changed) still close the window but are not counted: an
 * idle viewer reads 0. Pure and side-effect free so the timing math is
 * unit-testable without a WebGL context.
 */
export class FpsCounter {
  private readonly windowMs: number;
  private lastSample: number | null = null;
  private frames = 0;
  private _fps = 0;

  constructor(windowMs = 500) {
    this.windowMs = windowMs;
  }

  /** Record one animation frame at time `nowMs`; `drawn` is false for a skipped one. */
  tick(nowMs: number, drawn = true): void {
    if (this.lastSample === null) {
      this.lastSample = nowMs;
      return;
    }
    if (drawn) this.frames++;
    const elapsed = nowMs - this.lastSample;
    if (elapsed >= this.windowMs) {
      this._fps = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.lastSample = nowMs;
    }
  }

  /** Most recently computed FPS (0 until the first window has closed). */
  get fps(): number {
    return this._fps;
  }
}
